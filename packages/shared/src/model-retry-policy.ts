export type ModelCallFailureSource =
  | "provider_http"
  | "provider_network"
  | "provider_timeout"
  | "openclaw_process"
  | "configuration"
  | "output_invalid"
  | "unknown";

export const MODEL_CALL_FAILURE_CATEGORIES = [
  "cancelled",
  "configuration",
  "authentication",
  "authorization",
  "quota_or_billing",
  "model_or_endpoint",
  "invalid_request",
  "rate_limited",
  "provider_timeout",
  "provider_server",
  "network_transient",
  "network_unknown_outcome",
  "output_invalid",
  "unknown"
] as const;

export type ModelCallFailureCategory = (typeof MODEL_CALL_FAILURE_CATEGORIES)[number];

export type ModelCallFailureSignal = {
  message: string;
  source?: ModelCallFailureSource;
  statusCode?: number | null;
  providerCode?: string | null;
  providerRequestId?: string | null;
  networkCode?: string | null;
  retryAfterMs?: number | null;
};

export type ModelCallFailureDecision = {
  category: ModelCallFailureCategory;
  retryable: boolean;
  allowFailover: boolean;
  unknownOutcome: boolean;
  userActionRequired: boolean;
  statusCode: number | null;
  providerCode: string | null;
  providerRequestId: string | null;
  networkCode: string | null;
  retryAfterMs: number | null;
};

export type ModelRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

export type TaskExecutionRetryState = {
  version: "honeycomb.model-retry.v1";
  status: "waiting";
  idempotencyKey: string;
  actionType: string;
  agentId: string;
  providerId: string;
  routeIndex: number;
  failedAttemptNo: number;
  nextAttemptNo: number;
  maxAttempts: number;
  failureCategory: ModelCallFailureCategory;
  reason: string;
  delayMs: number;
  retryAfterMs: number | null;
  retryAt: string;
  updatedAt: string;
};

const TRANSIENT_CONNECT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT"
]);

const UNKNOWN_NETWORK_OUTCOME_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function decision(
  input: ModelCallFailureSignal,
  category: ModelCallFailureCategory,
  options: {
    retryable?: boolean;
    allowFailover?: boolean;
    unknownOutcome?: boolean;
    userActionRequired?: boolean;
  } = {}
): ModelCallFailureDecision {
  return {
    category,
    retryable: options.retryable ?? false,
    allowFailover: options.allowFailover ?? false,
    unknownOutcome: options.unknownOutcome ?? false,
    userActionRequired: options.userActionRequired ?? false,
    statusCode: input.statusCode ?? null,
    providerCode: input.providerCode ?? null,
    providerRequestId: input.providerRequestId ?? null,
    networkCode: input.networkCode ?? null,
    retryAfterMs: input.retryAfterMs ?? null
  };
}

function normalizedFailureText(input: ModelCallFailureSignal) {
  return [input.message, input.providerCode, input.networkCode]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function classifyModelCallFailure(input: ModelCallFailureSignal): ModelCallFailureDecision {
  const text = normalizedFailureText(input);
  const status = input.statusCode ?? null;
  const networkCode = input.networkCode?.toUpperCase() ?? null;

  if (text.includes("job_cancelled")) {
    return decision(input, "cancelled");
  }
  if (
    input.source === "configuration" ||
    /provider_(not_bound|base_url_missing|api_key_missing)|model_not_configured|agent_disabled|openclaw_session_id_missing/.test(text) ||
    /enoent|command not found|executable not found/.test(text)
  ) {
    return decision(input, "configuration", {
      allowFailover: true,
      userActionRequired: true
    });
  }
  if (
    status === 402 ||
    /insufficient[_ -](balance|credit|quota)|billing|quota[_ -]?(exceeded|exhausted)|out[_ -]of[_ -]quota/.test(text)
  ) {
    return decision(input, "quota_or_billing", {
      allowFailover: true,
      userActionRequired: true
    });
  }
  if (status === 401 || /invalid[_ -]?(api[_ -]?)?(key|token)|unauthenticated|authentication[_ -]failed/.test(text)) {
    return decision(input, "authentication", {
      allowFailover: true,
      userActionRequired: true
    });
  }
  if (status === 403 || /permission[_ -]denied|not[_ -]authorized|forbidden/.test(text)) {
    return decision(input, "authorization", {
      allowFailover: true,
      userActionRequired: true
    });
  }
  if (
    status === 404 ||
    /model.*(not[_ -]?(found|exist)|invalid|unsupported)|unknown[_ -]model|endpoint[_ -]not[_ -]found/.test(text)
  ) {
    return decision(input, "model_or_endpoint", {
      allowFailover: true,
      userActionRequired: true
    });
  }
  if (status === 408) {
    return decision(input, "provider_timeout", {
      retryable: true,
      allowFailover: true
    });
  }
  if (status === 425 || status === 429 || /rate.?limit|too many requests/.test(text)) {
    return decision(input, "rate_limited", {
      retryable: true,
      allowFailover: true
    });
  }
  if (status !== null && status >= 500 && status <= 599) {
    return decision(input, "provider_server", {
      retryable: true,
      allowFailover: true
    });
  }
  if (status === 400 || status === 409 || status === 415 || status === 422) {
    return decision(input, "invalid_request", {
      allowFailover: true,
      userActionRequired: true
    });
  }
  if (input.source === "provider_timeout") {
    return decision(input, "provider_timeout", {
      unknownOutcome: true,
      userActionRequired: true
    });
  }
  if (networkCode && TRANSIENT_CONNECT_CODES.has(networkCode)) {
    return decision(input, "network_transient", {
      retryable: true,
      allowFailover: true
    });
  }
  if (networkCode && UNKNOWN_NETWORK_OUTCOME_CODES.has(networkCode)) {
    return decision(input, "network_unknown_outcome", {
      unknownOutcome: true,
      userActionRequired: true
    });
  }
  if (/provider_direct_timeout|timed out|timeout/.test(text)) {
    return decision(input, "provider_timeout", {
      unknownOutcome: true,
      userActionRequired: true
    });
  }
  if (input.source === "provider_network") {
    return decision(input, "network_unknown_outcome", {
      unknownOutcome: true,
      userActionRequired: true
    });
  }
  if (input.source === "output_invalid") {
    return decision(input, "output_invalid", { allowFailover: true });
  }
  if (input.source === "openclaw_process") {
    return decision(input, "network_unknown_outcome", {
      unknownOutcome: true,
      userActionRequired: true
    });
  }
  return decision(input, "unknown", { userActionRequired: true });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.floor(parsed)))
    : fallback;
}

export function resolveModelRetryPolicy(env: NodeJS.ProcessEnv = process.env): ModelRetryPolicy {
  const jitter = Number(env.HONEYCOMB_MODEL_RETRY_JITTER_RATIO);
  return {
    maxAttempts: boundedInteger(env.HONEYCOMB_MODEL_RETRY_MAX_ATTEMPTS, 3, 1, 5),
    baseDelayMs: boundedInteger(env.HONEYCOMB_MODEL_RETRY_BASE_DELAY_MS, 1_000, 100, 60_000),
    maxDelayMs: boundedInteger(env.HONEYCOMB_MODEL_RETRY_MAX_DELAY_MS, 60_000, 1_000, 300_000),
    jitterRatio: Number.isFinite(jitter) ? Math.max(0, Math.min(0.5, jitter)) : 0.2
  };
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
  maxDelayMs = 300_000
) {
  const normalized = value?.trim();
  if (!normalized) return null;
  const seconds = Number(normalized);
  const delayMs = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Math.max(0, Date.parse(normalized) - nowMs);
  return Number.isFinite(delayMs) ? Math.min(maxDelayMs, Math.round(delayMs)) : null;
}

export function computeModelRetryDelay(input: {
  retryNumber: number;
  retryAfterMs?: number | null;
  policy: ModelRetryPolicy;
  random?: () => number;
}) {
  const retryNumber = Math.max(1, Math.floor(input.retryNumber));
  const exponential = Math.min(
    input.policy.maxDelayMs,
    input.policy.baseDelayMs * 2 ** (retryNumber - 1)
  );
  const random = Math.max(0, Math.min(1, (input.random ?? Math.random)()));
  const jitterMultiplier = 1 + (random * 2 - 1) * input.policy.jitterRatio;
  const jittered = Math.round(exponential * jitterMultiplier);
  const providerDelay = Math.max(0, input.retryAfterMs ?? 0);
  return Math.min(input.policy.maxDelayMs, Math.max(providerDelay, jittered));
}
