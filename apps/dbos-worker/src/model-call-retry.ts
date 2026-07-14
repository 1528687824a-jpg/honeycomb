import {
  classifyModelCallFailure,
  type ModelCallFailureDecision,
  type ModelCallFailureSource
} from "../../../packages/shared/src/model-retry-policy";
import { JobCancelledError, isJobCancellationError } from "./job-cancellation";

const FAILURE_SOURCES = new Set<ModelCallFailureSource>([
  "provider_http",
  "provider_network",
  "provider_timeout",
  "openclaw_process",
  "configuration",
  "output_invalid",
  "unknown"
]);

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
  return Number.isFinite(parsed) ? parsed : null;
}

function nestedNetworkCode(error: unknown) {
  const value = recordValue(error);
  return stringValue(value?.networkCode) ??
    stringValue(value?.code) ??
    stringValue(recordValue(value?.cause)?.code);
}

export function classifyModelCallError(error: unknown) {
  const value = recordValue(error);
  const rawSource = stringValue(value?.failureSource);
  const source = rawSource && FAILURE_SOURCES.has(rawSource as ModelCallFailureSource)
    ? rawSource as ModelCallFailureSource
    : value?.timedOut === true
      ? "provider_timeout"
      : "unknown";
  return classifyModelCallFailure({
    message: error instanceof Error ? error.message : String(error),
    source,
    statusCode: numberValue(value?.statusCode),
    providerCode: stringValue(value?.providerCode),
    networkCode: nestedNetworkCode(error),
    retryAfterMs: numberValue(value?.retryAfterMs)
  });
}

export class ModelCallExecutionError extends Error {
  readonly dbosRetryable = false;

  constructor(
    message: string,
    readonly decision: ModelCallFailureDecision
  ) {
    super(message);
    this.name = "ModelCallExecutionError";
  }
}

export function shouldRetryModelCallStep(error: unknown) {
  if (isJobCancellationError(error)) return false;
  const value = recordValue(error);
  if (value?.dbosRetryable === false || value?.name === "ModelCallExecutionError") {
    return false;
  }
  return true;
}

export type ModelCallRetryAction = "retry" | "failover" | "stop" | "stop_unknown_outcome";

export function resolveModelCallRetryAction(input: {
  decision: ModelCallFailureDecision;
  routeAttemptNo: number;
  maxAttempts: number;
}): ModelCallRetryAction {
  if (input.decision.unknownOutcome) return "stop_unknown_outcome";
  if (input.decision.retryable && input.routeAttemptNo < input.maxAttempts) return "retry";
  if (input.decision.allowFailover) return "failover";
  return "stop";
}

export function waitForModelRetry(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new JobCancelledError());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Math.floor(delayMs)));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
