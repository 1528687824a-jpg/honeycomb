import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  normalizeOpenClawAgentRunner,
  resolveOpenClawAgentRunner,
  type OpenClawAgentRunner,
  type OpenClawEffectiveRunner
} from "../../../../packages/shared/src/openclaw-runner";
import {
  isLikelyImageGenerationModel,
  isLikelyVideoGenerationModel
} from "../../../../packages/shared/src/model-capabilities";
import {
  parseRetryAfterMs,
  type ModelCallFailureSource
} from "../../../../packages/shared/src/model-retry-policy";
import {
  JobCancelledError,
  isJobCancellationError
} from "../job-cancellation";

const execFileAsync = promisify(execFile);

export type OpenClawRunResult = {
  mode: "mock" | "real" | "provider-direct";
  sessionId: string;
  text: string;
  textSource: OpenClawTextSource;
  usage: OpenClawTokenUsage | null;
  artifacts?: OpenClawGeneratedArtifact[];
  raw: unknown;
};

export type OpenClawGeneratedArtifact = {
  kind: "image" | "video";
  url: string | null;
  filePath: string | null;
  mimeType: string | null;
  note: string | null;
  source?: "base64" | "url";
  sizeBytes?: number | null;
  downloadError?: string | null;
};

export type OpenClawTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ProviderVideoTaskPhase =
  | "submitted"
  | "resumed"
  | "polling"
  | "query_retry"
  | "downloading"
  | "download_retry"
  | "completed"
  | "cancel_requested"
  | "cancel_failed";

export type ProviderVideoTaskUpdate = {
  version: "honeycomb.provider-video-task.v1";
  taskId: string;
  status: string;
  phase: ProviderVideoTaskPhase;
  pollCount: number;
  checkedAt: string;
  error: string | null;
};

export type OpenClawProviderRuntime = {
  providerId: string | null;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  agentRole?: string | null;
};

export type OpenClawTextSource =
  | "string"
  | "field:text"
  | "field:reply"
  | "field:message"
  | "field:content"
  | "field:output"
  | "payloads"
  | "finalAssistantVisibleText"
  | "finalAssistantRawText"
  | "provider:chat"
  | "provider:image"
  | "provider:video"
  | "provider:reconciled";

export class OpenClawOutputError extends Error {
  readonly failureSource = "output_invalid" as const;

  constructor(
    message: string,
    readonly stdoutPreview: string
  ) {
    super(message);
    this.name = "OpenClawOutputError";
  }
}

export class OpenClawProcessError extends Error {
  readonly failureSource = "openclaw_process" as const;

  constructor(
    message: string,
    readonly networkCode: string | null,
    readonly timedOut: boolean
  ) {
    super(message);
    this.name = "OpenClawProcessError";
  }
}

export class ProviderVideoPendingError extends Error {
  readonly dbosRetryable = true;

  constructor(
    readonly taskId: string,
    readonly providerStatus: string,
    readonly pollCount: number
  ) {
    super(`provider_video_task_pending: ${taskId} (${providerStatus})`);
    this.name = "ProviderVideoPendingError";
  }
}

function openClawRealMode() {
  return process.env.OPENCLAW_AGENT_MODE === "real";
}

export type OpenClawHostCommand = {
  runner: Exclude<OpenClawEffectiveRunner, "provider-direct">;
  command: string;
  args: string[];
  timeoutMs: number;
};

export function getOpenClawAgentRunner(): OpenClawAgentRunner {
  return normalizeOpenClawAgentRunner(process.env.OPENCLAW_AGENT_RUNNER);
}

export function shouldUseProviderDirectRunner(input: {
  runner?: OpenClawAgentRunner;
  platform?: NodeJS.Platform;
} = {}) {
  return resolveOpenClawAgentRunner({
    runner: input.runner ?? getOpenClawAgentRunner(),
    platform: input.platform
  }) === "provider-direct";
}

export { resolveOpenClawAgentRunner };
export type { OpenClawAgentRunner, OpenClawEffectiveRunner };

function getOpenClawCommand(platform: NodeJS.Platform = process.platform) {
  const configured = process.env.OPENCLAW_CLI?.trim();
  if (configured) {
    return configured;
  }
  return platform === "win32" ? "/home/administrator/.npm-global/bin/openclaw" : "openclaw";
}

function getWslDistro() {
  return process.env.OPENCLAW_WSL_DISTRO ?? "Ubuntu-24.04";
}

function chatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/chat/completions`;
}

function imageGenerationsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/images/generations`;
}

function videoTasksUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/contents/generations/tasks`;
}

function toOpenClawSessionId(sessionId: string) {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
}

function buildProviderEnv(provider?: OpenClawProviderRuntime | null) {
  if (!provider) {
    return {};
  }

  const env: Record<string, string> = {};
  if (provider.providerId) {
    env.HONEYCOMB_PROVIDER_ID = provider.providerId;
  }
  if (provider.baseUrl) {
    env.HONEYCOMB_PROVIDER_BASE_URL = provider.baseUrl;
    env.OPENAI_BASE_URL = provider.baseUrl;
  }
  if (provider.model) {
    env.HONEYCOMB_MODEL = provider.model;
    env.OPENAI_MODEL = provider.model;
  }
  if (provider.apiKey) {
    env.HONEYCOMB_PROVIDER_API_KEY = provider.apiKey;
    env.OPENAI_API_KEY = provider.apiKey;
    if (provider.providerId?.toLowerCase().includes("deepseek")) {
      env.DEEPSEEK_API_KEY = provider.apiKey;
    }
  }

  return env;
}

export function extractOpenClawText(raw: unknown): {
  text: string;
  source: OpenClawTextSource;
} | null {
  if (typeof raw === "string") {
    return raw.trim() ? { text: raw, source: "string" } : null;
  }

  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["text", "reply", "message", "content", "output"] as const) {
      if (typeof value[key] === "string" && (value[key] as string).trim()) {
        return { text: value[key] as string, source: `field:${key}` };
      }
    }

    if (Array.isArray(value.payloads)) {
      for (const payload of value.payloads) {
        if (
          payload &&
          typeof payload === "object" &&
          typeof (payload as Record<string, unknown>).text === "string" &&
          ((payload as Record<string, unknown>).text as string).trim()
        ) {
          return { text: (payload as Record<string, string>).text, source: "payloads" };
        }
      }
    }

    if (typeof value.finalAssistantVisibleText === "string" && value.finalAssistantVisibleText.trim()) {
      return { text: value.finalAssistantVisibleText, source: "finalAssistantVisibleText" };
    }

    if (typeof value.finalAssistantRawText === "string" && value.finalAssistantRawText.trim()) {
      return { text: value.finalAssistantRawText, source: "finalAssistantRawText" };
    }
  }

  return null;
}

function usageNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return null;
}

export function extractOpenClawUsage(raw: unknown): OpenClawTokenUsage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const candidates = [value.usage, value.tokenUsage, (value.meta as Record<string, unknown> | undefined)?.usage];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const usage = candidate as Record<string, unknown>;
    const promptTokens = usageNumber(usage, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"]);
    const completionTokens = usageNumber(usage, [
      "completionTokens",
      "completion_tokens",
      "outputTokens",
      "output_tokens"
    ]);
    if (promptTokens === null && completionTokens === null) {
      continue;
    }
    const totalTokens =
      usageNumber(usage, ["totalTokens", "total_tokens"]) ??
      (promptTokens ?? 0) + (completionTokens ?? 0);
    return {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      totalTokens
    };
  }

  return null;
}

export class ProviderDirectResponseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly failureSource: ModelCallFailureSource,
    readonly providerCode: string | null = null,
    readonly networkCode: string | null = null,
    readonly retryAfterMs: number | null = null,
    readonly providerRequestId: string | null = null
  ) {
    super(message);
    this.name = "ProviderDirectResponseError";
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function selectProviderDirectKind(provider?: OpenClawProviderRuntime | null): "chat" | "image" | "video" {
  const role = provider?.agentRole?.toLowerCase() ?? "";
  if (role === "image" || isLikelyImageGenerationModel(provider?.model)) {
    return "image";
  }
  if (role === "video" || isLikelyVideoGenerationModel(provider?.model)) {
    return "video";
  }
  return "chat";
}

function providerTimeoutMs(timeoutSeconds: number) {
  return Math.max(1, timeoutSeconds) * 1000;
}

function throwIfJobCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new JobCancelledError();
  }
}

function createTimedAbortSignal(input: {
  signal?: AbortSignal;
  timeoutMs: number;
  timeoutReason: string;
}) {
  throwIfJobCancelled(input.signal);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromJob = () => controller.abort(new JobCancelledError());
  input.signal?.addEventListener("abort", abortFromJob, { once: true });
  if (input.signal?.aborted) {
    abortFromJob();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(input.timeoutReason));
  }, input.timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromJob);
    }
  };
}

async function providerResponseErrorDetails(response: Response) {
  let message = `${response.status} ${response.statusText}`.trim();
  let providerCode: string | null = null;
  let providerRequestId = providerResponseRequestId(response);
  try {
    const body = await response.json() as {
      error?: { message?: unknown; code?: unknown; request_id?: unknown; requestId?: unknown };
      message?: unknown;
      code?: unknown;
      request_id?: unknown;
      requestId?: unknown;
    };
    const remoteMessage =
      typeof body.error?.message === "string"
        ? body.error.message
        : typeof body.message === "string"
          ? body.message
          : null;
    if (remoteMessage) {
      message = `${message}: ${remoteMessage}`.slice(0, 500);
    }
    const remoteCode = body.error?.code ?? body.code;
    if (typeof remoteCode === "string" || typeof remoteCode === "number") {
      providerCode = String(remoteCode).slice(0, 120);
    }
    const remoteRequestId =
      body.error?.request_id ??
      body.error?.requestId ??
      body.request_id ??
      body.requestId;
    if (!providerRequestId && (typeof remoteRequestId === "string" || typeof remoteRequestId === "number")) {
      providerRequestId = String(remoteRequestId).slice(0, 500);
    }
  } catch {
    // Keep the status-only message. Do not echo raw provider bodies.
  }
  return {
    message,
    providerCode,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
    providerRequestId: providerRequestId?.trim().slice(0, 500) || null
  };
}

function providerResponseRequestId(response: Response) {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    response.headers.get("x-amzn-requestid")
  )?.trim().slice(0, 500) || null;
}

async function notifyProviderRequestId(
  callback: ((providerRequestId: string) => Promise<void>) | undefined,
  providerRequestId: string
) {
  if (!callback) {
    return;
  }
  try {
    await callback(providerRequestId);
  } catch (error) {
    if (isJobCancellationError(error)) {
      throw new JobCancelledError();
    }
    throw new ProviderDirectResponseError(
      "provider_request_reference_persist_failed",
      null,
      "provider_network",
      null,
      "REFERENCE_PERSIST_FAILED",
      null,
      providerRequestId
    );
  }
}

function nestedErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === "string") return value.code;
  if (value.cause && typeof value.cause === "object") {
    const causeCode = (value.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return null;
}

async function fetchProviderJson(input: {
  url: string;
  apiKey: string;
  requestId?: string | null;
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  onProviderRequestId?: (providerRequestId: string) => Promise<void>;
}) {
  const abort = createTimedAbortSignal({
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    timeoutReason: "provider_direct_timeout"
  });
  try {
    const method = input.method ?? "POST";
    const response = await fetch(input.url, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
        ...(method === "POST" && input.requestId
          ? { "idempotency-key": input.requestId.slice(0, 200) }
          : {})
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: abort.signal
    });

    const responseRequestId = providerResponseRequestId(response);
    if (responseRequestId) {
      await notifyProviderRequestId(input.onProviderRequestId, responseRequestId);
    }

    if (!response.ok) {
      const details = await providerResponseErrorDetails(response);
      throw new ProviderDirectResponseError(
        details.message,
        response.status,
        "provider_http",
        details.providerCode,
        null,
        details.retryAfterMs,
        details.providerRequestId
      );
    }

    const responseText = await response.text();
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      return responseText;
    }
  } catch (error) {
    if (input.signal?.aborted || isJobCancellationError(error) || isJobCancellationError(abort.signal.reason)) {
      throw new JobCancelledError();
    }
    if (error instanceof ProviderDirectResponseError) {
      throw error;
    }
    throw new ProviderDirectResponseError(
      abort.timedOut()
        ? "provider_direct_timeout"
        : error instanceof Error
          ? error.message.slice(0, 500)
          : "provider_direct_request_failed",
      null,
      abort.timedOut() ? "provider_timeout" : "provider_network",
      null,
      nestedErrorCode(error)
    );
  } finally {
    abort.dispose();
  }
}

const VIDEO_PENDING_STATUSES = new Set(["queued", "running", "processing", "pending"]);
const VIDEO_FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "expired"]);

function boundedMilliseconds(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.floor(parsed)))
    : fallback;
}

function videoPollIntervalMs() {
  return boundedMilliseconds(process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS, 10_000, 10, 60_000);
}

function videoPollWindowMs(timeoutSeconds: number) {
  return boundedMilliseconds(
    process.env.OPENCLAW_VIDEO_POLL_WINDOW_MS,
    providerTimeoutMs(timeoutSeconds),
    25,
    3_600_000
  );
}

function videoStatusRequestTimeoutMs() {
  return boundedMilliseconds(
    process.env.OPENCLAW_VIDEO_STATUS_REQUEST_TIMEOUT_MS,
    30_000,
    250,
    120_000
  );
}

function normalizedVideoTaskStatus(raw: unknown, fallback = "queued") {
  const status =
    stringValue(recordValue(raw)?.status) ??
    stringValue(recordValue(recordValue(raw)?.data)?.status) ??
    fallback;
  return status.trim().toLowerCase().replace(/[\s-]+/g, "_").slice(0, 100);
}

function providerVideoTaskId(raw: unknown) {
  const value = recordValue(raw);
  const data = recordValue(value?.data);
  return (
    stringValue(value?.id) ??
    stringValue(value?.task_id) ??
    stringValue(value?.taskId) ??
    stringValue(data?.id) ??
    stringValue(data?.task_id) ??
    stringValue(data?.taskId)
  );
}

function providerVideoTaskError(raw: unknown) {
  const value = recordValue(raw);
  const error = recordValue(value?.error) ?? recordValue(recordValue(value?.data)?.error);
  return (
    stringValue(error?.message) ??
    stringValue(value?.message) ??
    stringValue(error?.code) ??
    "provider_video_task_failed"
  ).slice(0, 300);
}

function providerVideoCandidates(raw: unknown) {
  const value = recordValue(raw);
  const nested = recordValue(value?.content) ??
    recordValue(recordValue(value?.data)?.content) ??
    recordValue(value?.result) ??
    recordValue(value?.output);
  return collectMediaCandidates(nested ?? raw, "video")
    .filter((candidate) => Boolean(candidate.url || candidate.b64Json));
}

function waitForProviderPoll(delayMs: number, signal?: AbortSignal) {
  throwIfJobCancelled(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Math.floor(delayMs)));
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function notifyProviderVideoTask(
  callback: ((update: ProviderVideoTaskUpdate) => Promise<void>) | undefined,
  input: Omit<ProviderVideoTaskUpdate, "version" | "checkedAt">
) {
  if (!callback) return;
  await callback({
    version: "honeycomb.provider-video-task.v1",
    ...input,
    checkedAt: new Date().toISOString()
  });
}

async function cancelProviderVideoTask(input: {
  baseUrl: string;
  apiKey: string;
  taskId: string;
  pollCount: number;
  onProviderTaskUpdate?: (update: ProviderVideoTaskUpdate) => Promise<void>;
}) {
  await notifyProviderVideoTask(input.onProviderTaskUpdate, {
    taskId: input.taskId,
    status: "cancelling",
    phase: "cancel_requested",
    pollCount: input.pollCount,
    error: null
  }).catch(() => undefined);
  try {
    await fetchProviderJson({
      url: `${videoTasksUrl(input.baseUrl)}/${encodeURIComponent(input.taskId)}`,
      apiKey: input.apiKey,
      method: "DELETE",
      timeoutMs: 10_000
    });
  } catch (error) {
    await notifyProviderVideoTask(input.onProviderTaskUpdate, {
      taskId: input.taskId,
      status: "cancel_unknown",
      phase: "cancel_failed",
      pollCount: input.pollCount,
      error: error instanceof Error ? error.message.slice(0, 300) : "provider_video_cancel_failed"
    }).catch(() => undefined);
  }
}

export function extractProviderDirectChatText(raw: unknown) {
  const value = recordValue(raw);
  const outputText = stringValue(value?.output_text) ?? stringValue(value?.outputText);
  if (outputText) {
    return outputText;
  }

  const choices = Array.isArray(value?.choices) ? value.choices : [];
  for (const choice of choices) {
    const choiceRecord = recordValue(choice);
    const message = recordValue(choiceRecord?.message);
    const delta = recordValue(choiceRecord?.delta);
    const text =
      extractTextContent(message?.content) ??
      extractTextContent(message?.reasoning_content) ??
      extractTextContent(message?.reasoningContent) ??
      extractTextContent(choiceRecord?.text) ??
      extractTextContent(delta?.content) ??
      extractTextContent(delta?.reasoning_content) ??
      extractTextContent(delta?.reasoningContent);
    if (text) {
      return text;
    }
  }

  const outputItemsText = extractOutputItemsText(value?.output);
  if (outputItemsText) {
    return outputItemsText;
  }

  return extractOpenClawText(raw)?.text ?? null;
}

function extractOutputItemsText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parts = value
    .map((item) => {
      const record = recordValue(item);
      if (!record) {
        return "";
      }
      const direct = extractTextContent(record.content) ?? extractTextContent(record.text);
      if (direct) {
        return direct;
      }
      return extractOutputItemsText(record.content) ?? "";
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n") : null;
}

function extractTextContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const record = recordValue(item);
      return (
        stringValue(record?.text) ??
        stringValue(record?.content) ??
        stringValue(record?.output_text) ??
        stringValue(record?.outputText) ??
        ""
      );
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

export type MediaCandidate = {
  kind: "image" | "video";
  url: string | null;
  b64Json: string | null;
  mimeType: string | null;
  note: string | null;
};

function dataUrlParts(value: string | null) {
  const match = value?.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    return {
      mimeType: null,
      base64: value
    };
  }
  return {
    mimeType: match[1],
    base64: match[2]
  };
}

export function collectMediaCandidates(raw: unknown, kind: "image" | "video"): MediaCandidate[] {
  const value = recordValue(raw);
  const data =
    Array.isArray(value?.data)
      ? value.data
      : Array.isArray(value?.images)
        ? value.images
        : Array.isArray(value?.videos)
          ? value.videos
          : value
            ? [value]
            : [];

  return data
    .map((item): MediaCandidate | null => {
      const record = recordValue(item);
      if (!record) {
        return null;
      }
      const rawBase64 =
        stringValue(record.b64_json) ??
        stringValue(record.b64Json) ??
        stringValue(record.base64) ??
        stringValue(record.image) ??
        stringValue(record.video);
      const parts = dataUrlParts(rawBase64);
      const url =
        stringValue(record.url) ??
        stringValue(record.image_url) ??
        stringValue(record.video_url) ??
        stringValue(record.uri);
      const note =
        stringValue(record.revised_prompt) ??
        stringValue(record.revisedPrompt) ??
        stringValue(record.message) ??
        stringValue(record.status);

      if (!url && !parts.base64 && !note) {
        return null;
      }

      return {
        kind,
        url,
        b64Json: parts.base64,
        mimeType: parts.mimeType,
        note
      };
    })
    .filter((item): item is MediaCandidate => Boolean(item));
}

function extensionForMimeType(mimeType: string | null, kind: "image" | "video" = "image") {
  if (!mimeType) {
    return kind === "video" ? "mp4" : "png";
  }
  if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) {
    return "jpg";
  }
  if (mimeType?.includes("webp")) {
    return "webp";
  }
  if (mimeType?.includes("gif")) {
    return "gif";
  }
  if (mimeType?.includes("mp4")) {
    return "mp4";
  }
  return mimeType.startsWith("video/") || kind === "video" ? "mp4" : "png";
}

function extensionForMediaUrl(url: string | null) {
  if (!url) {
    return null;
  }
  try {
    const extension = path.extname(new URL(url).pathname).replace(".", "").toLowerCase();
    return ["jpg", "jpeg", "png", "webp", "gif", "mp4", "mov", "webm"].includes(extension)
      ? extension.replace("jpeg", "jpg")
      : null;
  } catch {
    return null;
  }
}

function isSpecificMediaMimeType(mimeType: string | null) {
  return Boolean(mimeType?.startsWith("image/") || mimeType?.startsWith("video/"));
}

function mediaDownloadMaxBytes(kind: "image" | "video") {
  const configured = Number(process.env.OPENCLAW_MEDIA_DOWNLOAD_MAX_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return kind === "video" ? 250 * 1024 * 1024 : 50 * 1024 * 1024;
}

function mediaDownloadTimeoutMs() {
  const configured = Number(process.env.OPENCLAW_MEDIA_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60_000;
}

function appendArtifactNote(note: string | null, extra: string) {
  return [note, extra].filter(Boolean).join("\n");
}

async function downloadMediaUrl(input: {
  url: string;
  kind: "image" | "video";
  outputDir: string;
  sessionId: string;
  index: number;
  fallbackMimeType: string | null;
  signal?: AbortSignal;
}) {
  const maxBytes = mediaDownloadMaxBytes(input.kind);
  const abort = createTimedAbortSignal({
    signal: input.signal,
    timeoutMs: mediaDownloadTimeoutMs(),
    timeoutReason: "media_download_timeout"
  });
  try {
    const response = await fetch(input.url, {
      method: "GET",
      signal: abort.signal
    });
    if (!response.ok) {
      throw new Error(`media_download_http_${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`media_download_too_large_${contentLength}`);
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || null;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const body = response.body;
    if (body) {
      const reader = body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const buffer = Buffer.from(chunk.value);
        totalBytes += buffer.byteLength;
        if (totalBytes > maxBytes) {
          throw new Error(`media_download_too_large_${totalBytes}`);
        }
        chunks.push(buffer);
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      totalBytes = buffer.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`media_download_too_large_${totalBytes}`);
      }
      chunks.push(buffer);
    }

    const extension = isSpecificMediaMimeType(contentType)
      ? extensionForMimeType(contentType, input.kind)
      : extensionForMediaUrl(input.url) ?? extensionForMimeType(input.fallbackMimeType, input.kind);
    const filePath = path.join(
      input.outputDir,
      `${toOpenClawSessionId(input.sessionId)}-${input.kind}-${input.index + 1}.${extension}`
    );
    await writeFile(filePath, Buffer.concat(chunks, totalBytes), { signal: abort.signal });
    return {
      filePath,
      mimeType: contentType ?? input.fallbackMimeType,
      sizeBytes: totalBytes
    };
  } catch (error) {
    if (input.signal?.aborted || isJobCancellationError(error) || isJobCancellationError(abort.signal.reason)) {
      throw new JobCancelledError();
    }
    if (abort.timedOut()) {
      throw new Error("media_download_timeout");
    }
    throw error;
  } finally {
    abort.dispose();
  }
}

export async function persistMediaCandidates(input: {
  candidates: MediaCandidate[];
  outputDir?: string | null;
  sessionId: string;
  signal?: AbortSignal;
}) {
  throwIfJobCancelled(input.signal);
  if (!input.outputDir) {
    return input.candidates.map((candidate) => ({
      kind: candidate.kind,
      url: candidate.url,
      filePath: null,
      mimeType: candidate.mimeType,
      note: candidate.note,
      source: undefined,
      sizeBytes: null,
      downloadError: null
    }));
  }

  await mkdir(input.outputDir, { recursive: true });
  throwIfJobCancelled(input.signal);
  const artifacts: OpenClawGeneratedArtifact[] = [];
  for (let index = 0; index < input.candidates.length; index++) {
    throwIfJobCancelled(input.signal);
    const candidate = input.candidates[index];
    let filePath: string | null = null;
    if (candidate.b64Json) {
      const extension = extensionForMimeType(candidate.mimeType, candidate.kind);
      filePath = path.join(
        input.outputDir,
        `${toOpenClawSessionId(input.sessionId)}-${candidate.kind}-${index + 1}.${extension}`
      );
      const buffer = Buffer.from(candidate.b64Json, "base64");
      try {
        await writeFile(filePath, buffer, { signal: input.signal });
      } catch (error) {
        if (input.signal?.aborted || isJobCancellationError(error)) {
          throw new JobCancelledError();
        }
        throw error;
      }
      artifacts.push({
        kind: candidate.kind,
        url: candidate.url,
        filePath,
        mimeType: candidate.mimeType,
        note: candidate.note,
        source: "base64",
        sizeBytes: buffer.byteLength,
        downloadError: null
      });
      continue;
    }

    let mimeType = candidate.mimeType;
    let sizeBytes: number | null = null;
    let downloadError: string | null = null;
    let note = candidate.note;
    if (candidate.url) {
      try {
        const downloaded = await downloadMediaUrl({
          url: candidate.url,
          kind: candidate.kind,
          outputDir: input.outputDir,
          sessionId: input.sessionId,
          index,
          fallbackMimeType: candidate.mimeType,
          signal: input.signal
        });
        filePath = downloaded.filePath;
        mimeType = downloaded.mimeType;
        sizeBytes = downloaded.sizeBytes;
      } catch (error) {
        if (input.signal?.aborted || isJobCancellationError(error)) {
          throw new JobCancelledError();
        }
        downloadError = error instanceof Error ? error.message.slice(0, 300) : "media_download_failed";
        note = appendArtifactNote(note, `Media download failed: ${downloadError}`);
      }
    }

    artifacts.push({
      kind: candidate.kind,
      url: candidate.url,
      filePath,
      mimeType,
      note,
      source: candidate.url ? "url" : undefined,
      sizeBytes,
      downloadError
    });
  }
  return artifacts;
}

function providerDirectText(input: {
  kind: "image" | "video";
  raw: unknown;
  artifacts: OpenClawGeneratedArtifact[];
}) {
  const directText = extractOpenClawText(input.raw)?.text;
  if (input.artifacts.length === 0 && !directText) {
    return "";
  }
  const lines = [
    `Provider direct ${input.kind} generation completed.`,
    ...input.artifacts.flatMap((artifact, index) => [
      `${input.kind === "image" ? "Image" : "Video"} ${index + 1}:`,
      artifact.filePath ? `File: ${artifact.filePath}` : "",
      artifact.url ? `URL: ${artifact.url}` : "",
      artifact.note ? `Note: ${artifact.note}` : ""
    ]).filter(Boolean),
    directText ? `Provider message: ${directText}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function sanitizeProviderForDirectRun(provider?: OpenClawProviderRuntime | null) {
  if (!provider?.baseUrl) {
    throw new Error("provider_base_url_missing");
  }
  if (!provider.model) {
    throw new Error("model_not_configured");
  }
  if (!provider.apiKey) {
    throw new Error("provider_api_key_missing");
  }
  return provider as OpenClawProviderRuntime & {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
}

async function runProviderDirectChat(input: {
  sessionId: string;
  message: string;
  requestId?: string | null;
  provider: OpenClawProviderRuntime & { baseUrl: string; model: string; apiKey: string };
  timeoutSeconds: number;
  signal?: AbortSignal;
  onProviderRequestId?: (providerRequestId: string) => Promise<void>;
}): Promise<OpenClawRunResult> {
  const maxTokens = numberValue(process.env.OPENCLAW_PROVIDER_DIRECT_MAX_TOKENS) ?? 1200;
  const raw = await fetchProviderJson({
    url: chatCompletionsUrl(input.provider.baseUrl),
    apiKey: input.provider.apiKey,
    requestId: input.requestId,
    timeoutMs: providerTimeoutMs(input.timeoutSeconds),
    signal: input.signal,
    onProviderRequestId: input.onProviderRequestId,
    body: {
      model: input.provider.model,
      messages: [
        {
          role: "system",
          content:
            "You are a Honeycomb child agent. Follow the supplied AGENTS.md prompt snapshot, stay inside the assigned specialist role, inspect the task packet and memory hints before producing, and return concise usable output for this stage only."
        },
        {
          role: "user",
          content: input.message
        }
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false
    }
  });
  const text = extractProviderDirectChatText(raw);
  if (!text) {
    const preview = (typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw)).slice(0, 2000);
    throw new OpenClawOutputError(
      `Provider direct chat returned empty or unrecognized output. Response preview: ${preview.slice(0, 500)}`,
      preview
    );
  }
  return {
    mode: "provider-direct",
    sessionId: toOpenClawSessionId(input.sessionId),
    text,
    textSource: "provider:chat",
    usage: extractOpenClawUsage(raw),
    raw
  };
}

async function runProviderDirectImage(input: {
  sessionId: string;
  message: string;
  requestId?: string | null;
  outputDir?: string | null;
  provider: OpenClawProviderRuntime & { baseUrl: string; model: string; apiKey: string };
  timeoutSeconds: number;
  signal?: AbortSignal;
  onProviderRequestId?: (providerRequestId: string) => Promise<void>;
}): Promise<OpenClawRunResult> {
  const body: Record<string, unknown> = {
    model: input.provider.model,
    prompt: input.message
  };
  const size = process.env.OPENCLAW_IMAGE_SIZE?.trim();
  const responseFormat = process.env.OPENCLAW_IMAGE_RESPONSE_FORMAT?.trim();
  if (size) {
    body.size = size;
  }
  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const raw = await fetchProviderJson({
    url: imageGenerationsUrl(input.provider.baseUrl),
    apiKey: input.provider.apiKey,
    requestId: input.requestId,
    timeoutMs: providerTimeoutMs(input.timeoutSeconds),
    signal: input.signal,
    onProviderRequestId: input.onProviderRequestId,
    body
  });
  const artifacts = await persistMediaCandidates({
    candidates: collectMediaCandidates(raw, "image"),
    outputDir: input.outputDir,
    sessionId: input.sessionId,
    signal: input.signal
  });
  const text = providerDirectText({ kind: "image", raw, artifacts });
  if (!text.trim()) {
    throw new OpenClawOutputError(
      "Provider direct image generation returned empty or unrecognized output.",
      JSON.stringify(raw).slice(0, 2000)
    );
  }
  return {
    mode: "provider-direct",
    sessionId: toOpenClawSessionId(input.sessionId),
    text,
    textSource: "provider:image",
    usage: extractOpenClawUsage(raw),
    artifacts,
    raw
  };
}

async function runProviderDirectVideo(input: {
  sessionId: string;
  message: string;
  requestId?: string | null;
  resumeProviderTaskId?: string | null;
  resumeProviderTaskStatus?: string | null;
  outputDir?: string | null;
  provider: OpenClawProviderRuntime & { baseUrl: string; model: string; apiKey: string };
  timeoutSeconds: number;
  signal?: AbortSignal;
  onProviderRequestId?: (providerRequestId: string) => Promise<void>;
  onProviderTaskId?: (providerTaskId: string) => Promise<void>;
  onProviderTaskUpdate?: (update: ProviderVideoTaskUpdate) => Promise<void>;
}): Promise<OpenClawRunResult> {
  let taskId = input.resumeProviderTaskId?.trim().slice(0, 500) || null;
  let raw: unknown = null;
  let status = taskId
    ? input.resumeProviderTaskStatus?.trim().toLowerCase().slice(0, 100) || "queued"
    : "submitting";
  let pollCount = 0;
  const deadline = Date.now() + videoPollWindowMs(input.timeoutSeconds);

  try {
    if (!taskId) {
      raw = await fetchProviderJson({
        url: videoTasksUrl(input.provider.baseUrl),
        apiKey: input.provider.apiKey,
        requestId: input.requestId,
        timeoutMs: providerTimeoutMs(input.timeoutSeconds),
        signal: input.signal,
        onProviderRequestId: input.onProviderRequestId,
        body: {
          model: input.provider.model,
          content: [
            {
              type: "text",
              text: input.message
            }
          ]
        }
      });
      taskId = providerVideoTaskId(raw)?.slice(0, 500) ?? null;
      if (!taskId) {
        throw new OpenClawOutputError(
          "Provider direct video generation did not return a task ID.",
          JSON.stringify(raw).slice(0, 2000)
        );
      }
      await notifyProviderRequestId(input.onProviderTaskId, taskId);
      status = normalizedVideoTaskStatus(raw);
      await notifyProviderVideoTask(input.onProviderTaskUpdate, {
        taskId,
        status,
        phase: "submitted",
        pollCount,
        error: null
      });
    } else {
      await notifyProviderVideoTask(input.onProviderTaskUpdate, {
        taskId,
        status,
        phase: "resumed",
        pollCount,
        error: null
      });
    }

    for (;;) {
      throwIfJobCancelled(input.signal);
      status = normalizedVideoTaskStatus(raw, status);

      if (status === "succeeded") {
        const candidates = providerVideoCandidates(raw);
        if (candidates.length > 0) {
          await notifyProviderVideoTask(input.onProviderTaskUpdate, {
            taskId,
            status,
            phase: "downloading",
            pollCount,
            error: null
          });
          const artifacts = await persistMediaCandidates({
            candidates,
            outputDir: input.outputDir,
            sessionId: input.sessionId,
            signal: input.signal
          });
          const locallyAvailable = artifacts.some((artifact) =>
            Boolean(artifact.filePath && !artifact.downloadError)
          );
          if (locallyAvailable) {
            await notifyProviderVideoTask(input.onProviderTaskUpdate, {
              taskId,
              status,
              phase: "completed",
              pollCount,
              error: null
            });
            return {
              mode: "provider-direct",
              sessionId: toOpenClawSessionId(input.sessionId),
              text: [
                "Provider direct video generation completed.",
                `Task ID: ${taskId}`,
                providerDirectText({ kind: "video", raw, artifacts })
              ].filter(Boolean).join("\n"),
              textSource: "provider:video",
              usage: extractOpenClawUsage(raw),
              artifacts,
              raw
            };
          }
          const downloadError = artifacts
            .map((artifact) => artifact.downloadError)
            .find(Boolean) ?? "provider_video_result_not_saved";
          status = "download_pending";
          await notifyProviderVideoTask(input.onProviderTaskUpdate, {
            taskId,
            status,
            phase: "download_retry",
            pollCount,
            error: downloadError.slice(0, 300)
          });
        } else {
          status = "result_pending";
          await notifyProviderVideoTask(input.onProviderTaskUpdate, {
            taskId,
            status,
            phase: "polling",
            pollCount,
            error: "provider_video_url_missing"
          });
        }
      } else if (VIDEO_FAILED_STATUSES.has(status)) {
        throw new ProviderDirectResponseError(
          `provider_video_task_${status}: ${providerVideoTaskError(raw)}`,
          null,
          "output_invalid",
          status,
          null,
          null,
          taskId
        );
      }

      if (Date.now() >= deadline) {
        throw new ProviderVideoPendingError(taskId, status, pollCount);
      }
      await waitForProviderPoll(Math.min(videoPollIntervalMs(), deadline - Date.now()), input.signal);

      try {
        raw = await fetchProviderJson({
          url: `${videoTasksUrl(input.provider.baseUrl)}/${encodeURIComponent(taskId)}`,
          apiKey: input.provider.apiKey,
          method: "GET",
          timeoutMs: videoStatusRequestTimeoutMs(),
          signal: input.signal
        });
        pollCount += 1;
        status = normalizedVideoTaskStatus(raw, "unknown");
        await notifyProviderVideoTask(input.onProviderTaskUpdate, {
          taskId,
          status,
          phase: "polling",
          pollCount,
          error: null
        });
      } catch (error) {
        if (isJobCancellationError(error) || input.signal?.aborted) {
          throw new JobCancelledError();
        }
        pollCount += 1;
        status = VIDEO_PENDING_STATUSES.has(status) ? status : "query_pending";
        await notifyProviderVideoTask(input.onProviderTaskUpdate, {
          taskId,
          status,
          phase: "query_retry",
          pollCount,
          error: error instanceof Error ? error.message.slice(0, 300) : "provider_video_query_failed"
        });
      }
    }
  } catch (error) {
    if (taskId && (isJobCancellationError(error) || input.signal?.aborted)) {
      await cancelProviderVideoTask({
        baseUrl: input.provider.baseUrl,
        apiKey: input.provider.apiKey,
        taskId,
        pollCount,
        onProviderTaskUpdate: input.onProviderTaskUpdate
      });
      throw new JobCancelledError();
    }
    throw error;
  }
}

async function runProviderDirectAgent(input: {
  sessionId: string;
  message: string;
  requestId?: string | null;
  resumeProviderTaskId?: string | null;
  resumeProviderTaskStatus?: string | null;
  provider?: OpenClawProviderRuntime | null;
  outputDir?: string | null;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onProviderRequestId?: (providerRequestId: string) => Promise<void>;
  onProviderTaskId?: (providerTaskId: string) => Promise<void>;
  onProviderTaskUpdate?: (update: ProviderVideoTaskUpdate) => Promise<void>;
}) {
  const provider = sanitizeProviderForDirectRun(input.provider);
  const kind = selectProviderDirectKind(provider);
  if (kind === "image") {
    return runProviderDirectImage({ ...input, provider });
  }
  if (kind === "video") {
    return runProviderDirectVideo({ ...input, provider });
  }
  return runProviderDirectChat({ ...input, provider });
}

export function buildOpenClawAgentArgs(input: {
  agentId: string;
  sessionId: string;
  message: string;
  timeoutSeconds: number;
}) {
  // The Linux-side `timeout` wrapper guarantees cleanup of the WSL process
  // tree: the outer execFile timeout only kills wsl.exe on the Windows side,
  // which can leave the CLI running inside the distro.
  return [
    "-d",
    getWslDistro(),
    "--",
    "timeout",
    "--kill-after=5",
    String(input.timeoutSeconds + 5),
    getOpenClawCommand(),
    "agent",
    "--agent",
    input.agentId,
    "--session-id",
    toOpenClawSessionId(input.sessionId),
    "--message",
    input.message,
    "--json",
    "--timeout",
    String(input.timeoutSeconds)
  ];
}

export function buildOpenClawCancelArgs(sessionId: string) {
  const normalizedSessionId = toOpenClawSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("openclaw_session_id_missing");
  }
  const escapedSessionId = normalizedSessionId.replace(/[\\.^$|?*+()[{]/g, "\\$&");
  return [
    "-d",
    getWslDistro(),
    "--",
    "pkill",
    "-TERM",
    "-f",
    "--",
    `--session-id ${escapedSessionId}( |$)`
  ];
}

async function cancelWslOpenClawSession(sessionId: string) {
  try {
    await execFileAsync("wsl", buildOpenClawCancelArgs(sessionId), {
      timeout: 10_000,
      windowsHide: true
    });
  } catch {
    // The process may already have exited, or WSL may be unavailable during shutdown.
  }
}

export function buildNativeOpenClawAgentArgs(input: {
  agentId: string;
  sessionId: string;
  message: string;
  timeoutSeconds: number;
}) {
  return [
    "agent",
    "--agent",
    input.agentId,
    "--session-id",
    toOpenClawSessionId(input.sessionId),
    "--message",
    input.message,
    "--json",
    "--timeout",
    String(input.timeoutSeconds)
  ];
}

export function buildOpenClawHostCommand(input: {
  agentId: string;
  sessionId: string;
  message: string;
  timeoutSeconds: number;
  platform?: NodeJS.Platform;
  runner?: OpenClawAgentRunner;
}): OpenClawHostCommand {
  const platform = input.platform ?? process.platform;
  const runner = resolveOpenClawAgentRunner({ runner: input.runner ?? getOpenClawAgentRunner(), platform });
  const timeoutMs = input.timeoutSeconds * 1000 + 30_000;
  if (runner === "provider-direct") {
    throw new Error("provider-direct does not use an OpenClaw host command.");
  }
  if (runner === "wsl") {
    return {
      runner,
      command: "wsl",
      args: buildOpenClawAgentArgs(input),
      timeoutMs
    };
  }
  return {
    runner,
    command: getOpenClawCommand(platform),
    args: buildNativeOpenClawAgentArgs(input),
    timeoutMs
  };
}

export async function runOpenClawAgent(input: {
  agentId: string;
  sessionId: string;
  message: string;
  requestId?: string | null;
  resumeProviderTaskId?: string | null;
  resumeProviderTaskStatus?: string | null;
  providerDirectMessage?: string | null;
  provider?: OpenClawProviderRuntime | null;
  outputDir?: string | null;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onProviderRequestId?: (providerRequestId: string) => Promise<void>;
  onProviderTaskId?: (providerTaskId: string) => Promise<void>;
  onProviderTaskUpdate?: (update: ProviderVideoTaskUpdate) => Promise<void>;
}): Promise<OpenClawRunResult | null> {
  throwIfJobCancelled(input.signal);
  if (!openClawRealMode()) {
    return null;
  }

  const timeoutSeconds = input.timeoutSeconds ?? 600;
  if (shouldUseProviderDirectRunner()) {
    return runProviderDirectAgent({
      sessionId: input.sessionId,
      message: input.providerDirectMessage ?? input.message,
      requestId: input.requestId,
      resumeProviderTaskId: input.resumeProviderTaskId,
      resumeProviderTaskStatus: input.resumeProviderTaskStatus,
      provider: input.provider,
      outputDir: input.outputDir,
      timeoutSeconds,
      signal: input.signal,
      onProviderRequestId: input.onProviderRequestId,
      onProviderTaskId: input.onProviderTaskId,
      onProviderTaskUpdate: input.onProviderTaskUpdate
    });
  }

  const hostCommand = buildOpenClawHostCommand({
    agentId: input.agentId,
    sessionId: input.sessionId,
    message: input.message,
    timeoutSeconds
  });

  let stdout: string;
  try {
    const result = await execFileAsync(hostCommand.command, hostCommand.args, {
      env: {
        ...process.env,
        ...buildProviderEnv(input.provider)
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: hostCommand.timeoutMs,
      windowsHide: true,
      signal: input.signal
    });
    stdout = result.stdout;
  } catch (error) {
    if (input.signal?.aborted || isJobCancellationError(error)) {
      if (hostCommand.runner === "wsl") {
        await cancelWslOpenClawSession(input.sessionId);
      }
      throw new JobCancelledError();
    }
    const value = error && typeof error === "object"
      ? error as { killed?: unknown; signal?: unknown }
      : null;
    throw new OpenClawProcessError(
      error instanceof Error ? error.message.slice(0, 500) : "openclaw_process_failed",
      nestedErrorCode(error),
      value?.killed === true || value?.signal === "SIGTERM" || value?.signal === "SIGKILL"
    );
  }

  const trimmed = stdout.trim();
  let raw: unknown = trimmed;

  try {
    raw = JSON.parse(trimmed);
  } catch {
    raw = trimmed;
  }

  const extracted = extractOpenClawText(raw);
  if (!extracted) {
    throw new OpenClawOutputError(
      "OpenClaw returned empty or unrecognized output; expected a text/reply/message/content/output/payloads field.",
      trimmed.slice(0, 2000)
    );
  }

  return {
    mode: "real",
    sessionId: toOpenClawSessionId(input.sessionId),
    text: extracted.text,
    textSource: extracted.source,
    usage: extractOpenClawUsage(raw),
    raw
  };
}
