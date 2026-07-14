import type {
  ModelCallConcurrencyLimits,
  ModelCallConcurrencyUsage,
  ModelCallQueueBlockingScope
} from "./types";

const DEFAULT_GLOBAL_LIMIT = 4;
const DEFAULT_PROVIDER_LIMIT = 2;
const DEFAULT_AGENT_LIMIT = 1;
const DEFAULT_QUEUE_POLL_MS = 750;
const DEFAULT_QUEUE_WAIT_TIMEOUT_SECONDS = 600;
const DEFAULT_QUEUE_HEARTBEAT_TTL_SECONDS = 30;
const DEFAULT_LEASE_GRACE_SECONDS = 45;

function positiveInteger(value: unknown, fallback: number, maximum = 10_000) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(maximum, Math.floor(parsed))
    : fallback;
}

export function metadataConcurrencyLimit(metadata: Record<string, unknown> | null | undefined) {
  return positiveInteger(
    metadata?.concurrencyLimit ?? metadata?.maxConcurrency,
    0,
    1_000
  ) || null;
}

export function resolveModelCallConcurrencyPolicy(input: {
  env?: NodeJS.ProcessEnv;
  providerLimitOverride?: number | null;
  agentLimitOverride?: number | null;
} = {}) {
  const env = input.env ?? process.env;
  const limits: ModelCallConcurrencyLimits = {
    global: positiveInteger(
      env.HONEYCOMB_MODEL_CONCURRENCY_GLOBAL,
      DEFAULT_GLOBAL_LIMIT,
      1_000
    ),
    provider: positiveInteger(
      input.providerLimitOverride ?? env.HONEYCOMB_MODEL_CONCURRENCY_PER_PROVIDER,
      DEFAULT_PROVIDER_LIMIT,
      1_000
    ),
    agent: positiveInteger(
      input.agentLimitOverride ?? env.HONEYCOMB_MODEL_CONCURRENCY_PER_AGENT,
      DEFAULT_AGENT_LIMIT,
      1_000
    )
  };

  return {
    limits,
    pollMs: positiveInteger(
      env.HONEYCOMB_MODEL_QUEUE_POLL_MS,
      DEFAULT_QUEUE_POLL_MS,
      60_000
    ),
    waitTimeoutMs: positiveInteger(
      env.HONEYCOMB_MODEL_QUEUE_WAIT_TIMEOUT_SECONDS,
      DEFAULT_QUEUE_WAIT_TIMEOUT_SECONDS,
      86_400
    ) * 1000,
    queueHeartbeatTtlSeconds: positiveInteger(
      env.HONEYCOMB_MODEL_QUEUE_HEARTBEAT_TTL_SECONDS,
      DEFAULT_QUEUE_HEARTBEAT_TTL_SECONDS,
      3_600
    ),
    leaseGraceSeconds: positiveInteger(
      env.HONEYCOMB_MODEL_QUEUE_LEASE_GRACE_SECONDS,
      DEFAULT_LEASE_GRACE_SECONDS,
      3_600
    )
  };
}

export function evaluateModelCallConcurrency(input: {
  limits: ModelCallConcurrencyLimits;
  active: ModelCallConcurrencyUsage;
  hasEarlierScopeConflict: boolean;
}) {
  const blockingScopes: ModelCallQueueBlockingScope[] = [];
  if (input.active.global >= input.limits.global) {
    blockingScopes.push("global");
  }
  if (input.active.provider >= input.limits.provider) {
    blockingScopes.push("provider");
  }
  if (input.active.agent >= input.limits.agent) {
    blockingScopes.push("agent");
  }
  if (input.hasEarlierScopeConflict) {
    blockingScopes.push("earlier_request");
  }
  return {
    acquired: blockingScopes.length === 0,
    blockingScopes
  };
}
