import {
  normalizedProviderState,
  type ModelCallReconciliationStatus,
  type ModelCallRequestReference,
  type ProviderUnknownOutcomePolicy
} from "../../../packages/shared/src/model-reconciliation";
import { collectMediaCandidates } from "../../dbos-worker/src/adapters/openclaw";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_RECOVERED_TEXT_LENGTH = 200_000;

export type ProviderReconciliationResult = {
  status: Exclude<ModelCallReconciliationStatus, "pending">;
  providerStatus: string | null;
  providerHttpStatus: number | null;
  reason: string | null;
  resultText: string | null;
  payload: unknown;
};

export type RecoveredProviderMediaArtifact = {
  kind: "image" | "video";
  url: string;
  filePath: null;
  mimeType: string | null;
  note: string;
  source: "url";
  sizeBytes: null;
  downloadError: null;
};

export function recoverProviderMediaArtifacts(input: {
  kind: "image" | "video";
  payload?: unknown;
  resultText?: string | null;
}): RecoveredProviderMediaArtifact[] {
  const candidates = collectMediaCandidates(input.payload, input.kind);
  const directUrl = input.resultText?.trim();
  if (directUrl) {
    try {
      const parsed = new URL(directUrl);
      if (["http:", "https:"].includes(parsed.protocol)) {
        candidates.push({
          kind: input.kind,
          url: parsed.toString(),
          b64Json: null,
          mimeType: null,
          note: "Recovered from provider reconciliation"
        });
      }
    } catch {
      // A non-URL text result is not a deliverable media artifact.
    }
  }

  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (!candidate.url || seen.has(candidate.url)) {
      return [];
    }
    try {
      const url = new URL(candidate.url);
      if (!["http:", "https:"].includes(url.protocol)) {
        return [];
      }
    } catch {
      return [];
    }
    seen.add(candidate.url);
    return [{
      kind: candidate.kind,
      url: candidate.url,
      filePath: null,
      mimeType: candidate.mimeType,
      note: candidate.note ?? "Recovered from provider reconciliation",
      source: "url" as const,
      sizeBytes: null,
      downloadError: null
    }];
  });
}

export function readProviderPayloadPath(value: unknown, path: string): unknown {
  const normalizedPath = path
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/^\./, "");
  if (!normalizedPath) {
    return value;
  }

  let current: unknown = value;
  for (const segment of normalizedPath.split(".").filter(Boolean)) {
    if (["__proto__", "prototype", "constructor"].includes(segment)) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolveProviderReconciliationUrl(
  baseUrl: string,
  pathTemplate: string,
  requestId: string
) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new Error("provider_reconciliation_protocol_not_allowed");
  }
  if (!pathTemplate.startsWith("/") || !pathTemplate.includes("{requestId}")) {
    throw new Error("provider_reconciliation_path_invalid");
  }

  const path = pathTemplate
    .split("{requestId}")
    .join(encodeURIComponent(requestId));
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) {
    throw new Error("provider_reconciliation_origin_mismatch");
  }
  return url;
}

function recoveredText(value: unknown) {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.slice(0, MAX_RECOVERED_TEXT_LENGTH) : null;
  }
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value).slice(0, MAX_RECOVERED_TEXT_LENGTH);
  } catch {
    return null;
  }
}

export function classifyProviderReconciliationPayload(
  payload: unknown,
  policy: ProviderUnknownOutcomePolicy,
  providerHttpStatus: number | null = null
): ProviderReconciliationResult {
  const statusValue = readProviderPayloadPath(payload, policy.statusPath);
  const providerStatus = typeof statusValue === "string" || typeof statusValue === "number"
    ? normalizedProviderState(String(statusValue))
    : null;
  const resultText = policy.resultTextPath
    ? recoveredText(readProviderPayloadPath(payload, policy.resultTextPath))
    : null;

  if (!providerStatus) {
    return {
      status: "manual_review",
      providerStatus: null,
      providerHttpStatus,
      reason: "provider_status_missing",
      resultText,
      payload
    };
  }
  if (policy.pendingValues.includes(providerStatus)) {
    return {
      status: "provider_pending",
      providerStatus,
      providerHttpStatus,
      reason: null,
      resultText: null,
      payload
    };
  }
  if (policy.notAcceptedValues.includes(providerStatus)) {
    return {
      status: "confirmed_not_accepted",
      providerStatus,
      providerHttpStatus,
      reason: null,
      resultText: null,
      payload
    };
  }
  if (policy.failedValues.includes(providerStatus)) {
    return {
      status: "confirmed_failed",
      providerStatus,
      providerHttpStatus,
      reason: null,
      resultText: null,
      payload
    };
  }
  if (policy.succeededValues.includes(providerStatus)) {
    return {
      status: "confirmed_succeeded",
      providerStatus,
      providerHttpStatus,
      reason: resultText ? null : "provider_result_missing",
      resultText,
      payload
    };
  }
  return {
    status: "manual_review",
    providerStatus,
    providerHttpStatus,
    reason: "provider_status_unrecognized",
    resultText,
    payload
  };
}

async function readResponseBody(response: Response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("provider_reconciliation_response_too_large");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("provider_reconciliation_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseResponsePayload(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, MAX_RECOVERED_TEXT_LENGTH);
  }
}

function queryFailure(input: {
  reason: string;
  providerHttpStatus?: number | null;
  payload?: unknown;
}): ProviderReconciliationResult {
  return {
    status: "query_failed",
    providerStatus: null,
    providerHttpStatus: input.providerHttpStatus ?? null,
    reason: input.reason.slice(0, 500),
    resultText: null,
    payload: input.payload ?? null
  };
}

export async function queryProviderUnknownOutcome(input: {
  baseUrl: string;
  apiKey: string | null;
  reference: ModelCallRequestReference;
  policy: ProviderUnknownOutcomePolicy;
  fetchImpl?: typeof fetch;
}): Promise<ProviderReconciliationResult> {
  const requestId = input.policy.requestIdSource === "providerRequestId"
    ? input.reference.providerRequestId
    : input.reference.requestId;
  if (!requestId) {
    return queryFailure({ reason: "provider_reconciliation_request_id_missing" });
  }

  let url: URL;
  try {
    url = resolveProviderReconciliationUrl(input.baseUrl, input.policy.pathTemplate, requestId);
  } catch (error) {
    return queryFailure({ reason: error instanceof Error ? error.message : String(error) });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.policy.timeoutSeconds * 1000);
  timeout.unref?.();
  try {
    const headers = new Headers({
      accept: "application/json",
      "idempotency-key": input.reference.requestId
    });
    if (input.apiKey) {
      headers.set("authorization", `Bearer ${input.apiKey}`);
    }
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal
    });
    const payload = parseResponsePayload(await readResponseBody(response));
    const classified = classifyProviderReconciliationPayload(payload, input.policy, response.status);
    if (!response.ok) {
      if (
        classified.status === "confirmed_not_accepted" &&
        (response.status === 404 || response.status === 410)
      ) {
        return classified;
      }
      return queryFailure({
        reason: `provider_reconciliation_http_${response.status}`,
        providerHttpStatus: response.status,
        payload
      });
    }
    return classified;
  } catch (error) {
    return queryFailure({
      reason: controller.signal.aborted
        ? "provider_reconciliation_timeout"
        : error instanceof Error
          ? error.message
          : String(error)
    });
  } finally {
    clearTimeout(timeout);
  }
}
