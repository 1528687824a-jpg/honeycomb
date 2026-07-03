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
  | "provider:video";

export class OpenClawOutputError extends Error {
  constructor(
    message: string,
    readonly stdoutPreview: string
  ) {
    super(message);
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

class ProviderDirectResponseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null
  ) {
    super(message);
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

function isLikelyImageGenerationModel(model: string | null | undefined) {
  return Boolean(
    model?.match(/(dall-e|gpt-image-|imagen|cogview|wanx|seedream|doubao[-_]?seedream|doubao.*image|flux|stable-diffusion)/i)
  );
}

function isLikelyVideoGenerationModel(model: string | null | undefined) {
  return Boolean(
    model?.match(/(seedance|doubao[-_]?seedance|sora|veo|video-generation|cogvideo|kling|wanx.*video)/i)
  );
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

async function providerResponseErrorMessage(response: Response) {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = await response.json() as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
      code?: unknown;
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
  } catch {
    // Keep the status-only message. Do not echo raw provider bodies.
  }
  return message;
}

async function fetchProviderJson(input: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify(input.body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderDirectResponseError(await providerResponseErrorMessage(response), response.status);
    }

    const responseText = await response.text();
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      return responseText;
    }
  } catch (error) {
    if (error instanceof ProviderDirectResponseError) {
      throw error;
    }
    throw new ProviderDirectResponseError(
      error instanceof Error ? error.message.slice(0, 500) : "provider_direct_request_failed",
      null
    );
  } finally {
    clearTimeout(timeout);
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
}) {
  const maxBytes = mediaDownloadMaxBytes(input.kind);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), mediaDownloadTimeoutMs());
  try {
    const response = await fetch(input.url, {
      method: "GET",
      signal: controller.signal
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
    await writeFile(filePath, Buffer.concat(chunks, totalBytes));
    return {
      filePath,
      mimeType: contentType ?? input.fallbackMimeType,
      sizeBytes: totalBytes
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function persistMediaCandidates(input: {
  candidates: MediaCandidate[];
  outputDir?: string | null;
  sessionId: string;
}) {
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
  const artifacts: OpenClawGeneratedArtifact[] = [];
  for (let index = 0; index < input.candidates.length; index++) {
    const candidate = input.candidates[index];
    let filePath: string | null = null;
    if (candidate.b64Json) {
      const extension = extensionForMimeType(candidate.mimeType, candidate.kind);
      filePath = path.join(
        input.outputDir,
        `${toOpenClawSessionId(input.sessionId)}-${candidate.kind}-${index + 1}.${extension}`
      );
      const buffer = Buffer.from(candidate.b64Json, "base64");
      await writeFile(filePath, buffer);
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
          fallbackMimeType: candidate.mimeType
        });
        filePath = downloaded.filePath;
        mimeType = downloaded.mimeType;
        sizeBytes = downloaded.sizeBytes;
      } catch (error) {
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
  provider: OpenClawProviderRuntime & { baseUrl: string; model: string; apiKey: string };
  timeoutSeconds: number;
}): Promise<OpenClawRunResult> {
  const maxTokens = numberValue(process.env.OPENCLAW_PROVIDER_DIRECT_MAX_TOKENS) ?? 1200;
  const raw = await fetchProviderJson({
    url: chatCompletionsUrl(input.provider.baseUrl),
    apiKey: input.provider.apiKey,
    timeoutMs: providerTimeoutMs(input.timeoutSeconds),
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
  outputDir?: string | null;
  provider: OpenClawProviderRuntime & { baseUrl: string; model: string; apiKey: string };
  timeoutSeconds: number;
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
    timeoutMs: providerTimeoutMs(input.timeoutSeconds),
    body
  });
  const artifacts = await persistMediaCandidates({
    candidates: collectMediaCandidates(raw, "image"),
    outputDir: input.outputDir,
    sessionId: input.sessionId
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
  outputDir?: string | null;
  provider: OpenClawProviderRuntime & { baseUrl: string; model: string; apiKey: string };
  timeoutSeconds: number;
}): Promise<OpenClawRunResult> {
  const raw = await fetchProviderJson({
    url: videoTasksUrl(input.provider.baseUrl),
    apiKey: input.provider.apiKey,
    timeoutMs: providerTimeoutMs(input.timeoutSeconds),
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
  const artifacts = await persistMediaCandidates({
    candidates: collectMediaCandidates(raw, "video"),
    outputDir: input.outputDir,
    sessionId: input.sessionId
  });
  const taskId =
    stringValue(recordValue(raw)?.id) ??
    stringValue(recordValue(raw)?.task_id) ??
    stringValue(recordValue(raw)?.taskId);
  const text = [
    "Provider direct video generation task submitted.",
    taskId ? `Task ID: ${taskId}` : "",
    providerDirectText({ kind: "video", raw, artifacts })
  ].filter(Boolean).join("\n");
  return {
    mode: "provider-direct",
    sessionId: toOpenClawSessionId(input.sessionId),
    text,
    textSource: "provider:video",
    usage: extractOpenClawUsage(raw),
    artifacts,
    raw
  };
}

async function runProviderDirectAgent(input: {
  sessionId: string;
  message: string;
  provider?: OpenClawProviderRuntime | null;
  outputDir?: string | null;
  timeoutSeconds: number;
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
  providerDirectMessage?: string | null;
  provider?: OpenClawProviderRuntime | null;
  outputDir?: string | null;
  timeoutSeconds?: number;
}): Promise<OpenClawRunResult | null> {
  if (!openClawRealMode()) {
    return null;
  }

  const timeoutSeconds = input.timeoutSeconds ?? 600;
  if (shouldUseProviderDirectRunner()) {
    return runProviderDirectAgent({
      sessionId: input.sessionId,
      message: input.providerDirectMessage ?? input.message,
      provider: input.provider,
      outputDir: input.outputDir,
      timeoutSeconds
    });
  }

  const hostCommand = buildOpenClawHostCommand({
    agentId: input.agentId,
    sessionId: input.sessionId,
    message: input.message,
    timeoutSeconds
  });

  const { stdout } = await execFileAsync(hostCommand.command, hostCommand.args, {
    env: {
      ...process.env,
      ...buildProviderEnv(input.provider)
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: hostCommand.timeoutMs,
    windowsHide: true
  });

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
