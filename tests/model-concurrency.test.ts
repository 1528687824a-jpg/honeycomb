import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateModelCallConcurrency,
  metadataConcurrencyLimit,
  resolveModelCallConcurrencyPolicy
} from "../packages/shared/src/model-concurrency";
import { parseTaskExecutionQueueState } from "../packages/shared/src/task-queue-contract";

test("model concurrency policy uses conservative product defaults", () => {
  const policy = resolveModelCallConcurrencyPolicy({ env: {} });
  assert.deepEqual(policy.limits, {
    global: 4,
    provider: 2,
    agent: 1
  });
  assert.equal(policy.pollMs, 750);
  assert.equal(policy.waitTimeoutMs, 600_000);
  assert.equal(policy.queueHeartbeatTtlSeconds, 30);
});

test("model concurrency policy accepts environment and metadata overrides", () => {
  const policy = resolveModelCallConcurrencyPolicy({
    env: {
      HONEYCOMB_MODEL_CONCURRENCY_GLOBAL: "8",
      HONEYCOMB_MODEL_CONCURRENCY_PER_PROVIDER: "5",
      HONEYCOMB_MODEL_CONCURRENCY_PER_AGENT: "3",
      HONEYCOMB_MODEL_QUEUE_POLL_MS: "250",
      HONEYCOMB_MODEL_QUEUE_WAIT_TIMEOUT_SECONDS: "45"
    },
    providerLimitOverride: 2,
    agentLimitOverride: 1
  });
  assert.deepEqual(policy.limits, {
    global: 8,
    provider: 2,
    agent: 1
  });
  assert.equal(policy.pollMs, 250);
  assert.equal(policy.waitTimeoutMs, 45_000);
  assert.equal(metadataConcurrencyLimit({ concurrencyLimit: 6 }), 6);
  assert.equal(metadataConcurrencyLimit({ maxConcurrency: "4" }), 4);
  assert.equal(metadataConcurrencyLimit({ concurrencyLimit: 0 }), null);
});

test("model concurrency decision enforces every scope and queue fairness", () => {
  const limits = { global: 4, provider: 2, agent: 1 };
  assert.deepEqual(evaluateModelCallConcurrency({
    limits,
    active: { global: 1, provider: 1, agent: 0 },
    hasEarlierScopeConflict: false
  }), {
    acquired: true,
    blockingScopes: []
  });
  assert.deepEqual(evaluateModelCallConcurrency({
    limits,
    active: { global: 4, provider: 2, agent: 1 },
    hasEarlierScopeConflict: true
  }), {
    acquired: false,
    blockingScopes: ["global", "provider", "agent", "earlier_request"]
  });
});

test("task execution queue state contract rejects incomplete queue data", () => {
  const valid = {
    version: "honeycomb.model-call-queue.v1",
    status: "queued",
    requestKey: "job:stage:1:route:0",
    idempotencyKey: "job:stage:1",
    routeIndex: 0,
    agentId: "image-agent",
    providerId: "provider-volcengine-ark",
    queuedAt: new Date().toISOString(),
    acquiredAt: null,
    leaseExpiresAt: null,
    globalPosition: 2,
    providerPosition: 1,
    agentPosition: 1,
    limits: { global: 4, provider: 2, agent: 1 },
    active: { global: 4, provider: 1, agent: 1 },
    blockingScopes: ["global", "agent"],
    retryAfterMs: 750
  };
  assert.deepEqual(parseTaskExecutionQueueState(valid), valid);
  assert.equal(parseTaskExecutionQueueState({ ...valid, providerId: null }), null);
});
