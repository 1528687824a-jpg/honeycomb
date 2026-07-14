import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyModelCallFailure,
  computeModelRetryDelay,
  parseRetryAfterMs,
  resolveModelRetryPolicy
} from "../packages/shared/src/model-retry-policy";
import {
  ModelCallExecutionError,
  classifyModelCallError,
  resolveModelCallRetryAction,
  shouldRetryModelCallStep,
  waitForModelRetry
} from "../apps/dbos-worker/src/model-call-retry";
import { parseTaskExecutionRetryState } from "../packages/shared/src/task-retry-contract";

test("model retry policy never retries authentication, quota, or invalid model failures", () => {
  for (const input of [
    { message: "invalid_api_token", statusCode: 401 },
    { message: "insufficient balance", statusCode: 402 },
    { message: "quota exhausted", statusCode: 429, providerCode: "insufficient_quota" },
    { message: "requested model not found", statusCode: 404 },
    { message: "bad request", statusCode: 400, providerCode: "model_not_found" },
    { message: "permission denied", statusCode: 403 }
  ]) {
    const result = classifyModelCallFailure(input);
    assert.equal(result.retryable, false);
    assert.equal(result.allowFailover, true);
    assert.equal(result.userActionRequired, true);
  }
  assert.equal(classifyModelCallFailure({
    message: "quota exhausted",
    statusCode: 429,
    providerCode: "insufficient_quota"
  }).category, "quota_or_billing");
  assert.equal(classifyModelCallFailure({
    message: "bad request",
    statusCode: 400,
    providerCode: "model_not_found"
  }).category, "model_or_endpoint");
});

test("model retry policy retries rate limits and provider server failures", () => {
  const limited = classifyModelCallFailure({
    message: "Too Many Requests",
    statusCode: 429,
    retryAfterMs: 4_000
  });
  assert.equal(limited.category, "rate_limited");
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterMs, 4_000);

  const unavailable = classifyModelCallFailure({ message: "unavailable", statusCode: 503 });
  assert.equal(unavailable.category, "provider_server");
  assert.equal(unavailable.retryable, true);
});

test("model retry policy distinguishes safe connection failures from unknown outcomes", () => {
  const refused = classifyModelCallFailure({
    message: "fetch failed",
    source: "provider_network",
    networkCode: "ECONNREFUSED"
  });
  assert.equal(refused.category, "network_transient");
  assert.equal(refused.retryable, true);
  assert.equal(refused.unknownOutcome, false);

  const connectTimeout = classifyModelCallFailure({
    message: "fetch failed",
    source: "provider_network",
    networkCode: "UND_ERR_CONNECT_TIMEOUT"
  });
  assert.equal(connectTimeout.category, "network_transient");
  assert.equal(connectTimeout.retryable, true);

  const reset = classifyModelCallFailure({
    message: "fetch failed",
    source: "provider_network",
    networkCode: "ECONNRESET"
  });
  assert.equal(reset.category, "network_unknown_outcome");
  assert.equal(reset.retryable, false);
  assert.equal(reset.allowFailover, false);
  assert.equal(reset.unknownOutcome, true);

  const timeout = classifyModelCallFailure({
    message: "provider_direct_timeout",
    source: "provider_timeout"
  });
  assert.equal(timeout.unknownOutcome, true);
  assert.equal(timeout.retryable, false);
});

test("Retry-After accepts seconds and HTTP dates", () => {
  const now = Date.UTC(2026, 6, 14, 12, 0, 0);
  assert.equal(parseRetryAfterMs("2.5", now), 2_500);
  assert.equal(parseRetryAfterMs("Tue, 14 Jul 2026 12:00:04 GMT", now), 4_000);
  assert.equal(parseRetryAfterMs("not-a-date", now), null);
  assert.equal(parseRetryAfterMs("9999", now, 10_000), 10_000);
});

test("retry delay uses exponential backoff, jitter, and provider minimum", () => {
  const policy = {
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2
  };
  assert.equal(computeModelRetryDelay({ retryNumber: 1, policy, random: () => 0.5 }), 1_000);
  assert.equal(computeModelRetryDelay({ retryNumber: 2, policy, random: () => 0.5 }), 2_000);
  assert.equal(computeModelRetryDelay({
    retryNumber: 1,
    retryAfterMs: 5_000,
    policy,
    random: () => 0
  }), 5_000);
});

test("retry policy environment settings are bounded", () => {
  assert.deepEqual(resolveModelRetryPolicy({}), {
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2
  });
  assert.deepEqual(resolveModelRetryPolicy({
    HONEYCOMB_MODEL_RETRY_MAX_ATTEMPTS: "99",
    HONEYCOMB_MODEL_RETRY_BASE_DELAY_MS: "10",
    HONEYCOMB_MODEL_RETRY_MAX_DELAY_MS: "999999",
    HONEYCOMB_MODEL_RETRY_JITTER_RATIO: "0.9"
  }), {
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 300_000,
    jitterRatio: 0.5
  });
});

test("worker error normalization preserves structured provider metadata", () => {
  const result = classifyModelCallError(Object.assign(new Error("rate limited"), {
    failureSource: "provider_http",
    statusCode: 429,
    providerCode: "rate_limit_exceeded",
    retryAfterMs: 3_000
  }));
  assert.equal(result.category, "rate_limited");
  assert.equal(result.providerCode, "rate_limit_exceeded");
  assert.equal(result.retryAfterMs, 3_000);
});

test("retry action retries safely before failover and stops unknown outcomes", () => {
  const retryable = classifyModelCallFailure({ message: "busy", statusCode: 503 });
  assert.equal(resolveModelCallRetryAction({
    decision: retryable,
    routeAttemptNo: 1,
    maxAttempts: 3
  }), "retry");
  assert.equal(resolveModelCallRetryAction({
    decision: retryable,
    routeAttemptNo: 3,
    maxAttempts: 3
  }), "failover");

  const unknownOutcome = classifyModelCallFailure({
    message: "socket reset",
    source: "provider_network",
    networkCode: "ECONNRESET"
  });
  assert.equal(resolveModelCallRetryAction({
    decision: unknownOutcome,
    routeAttemptNo: 1,
    maxAttempts: 3
  }), "stop_unknown_outcome");
});

test("persisted task retry state accepts only the bounded public contract", () => {
  const retryState = {
    version: "honeycomb.model-retry.v1" as const,
    status: "waiting" as const,
    idempotencyKey: "job:stage:1:stage-agent",
    actionType: "stage-agent",
    agentId: "image-agent",
    providerId: "volcengine",
    routeIndex: 0,
    failedAttemptNo: 1,
    nextAttemptNo: 2,
    maxAttempts: 3,
    failureCategory: "rate_limited" as const,
    reason: "429 Too Many Requests",
    delayMs: 2_000,
    retryAfterMs: 2_000,
    retryAt: "2026-07-14T12:00:02.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z"
  };
  assert.deepEqual(parseTaskExecutionRetryState(retryState), retryState);
  assert.equal(parseTaskExecutionRetryState({ ...retryState, maxAttempts: 10 }), null);
  assert.equal(parseTaskExecutionRetryState({ ...retryState, nextAttemptNo: 3 }), null);
  assert.equal(parseTaskExecutionRetryState({ ...retryState, failureCategory: "secret_failure" }), null);
});

test("DBOS retries infrastructure failures but not classified model failures", () => {
  const decision = classifyModelCallFailure({ message: "invalid key", statusCode: 401 });
  assert.equal(shouldRetryModelCallStep(new ModelCallExecutionError("invalid key", decision)), false);
  assert.equal(shouldRetryModelCallStep(new Error("job_cancelled")), false);
  assert.equal(shouldRetryModelCallStep(new Error("postgres connection interrupted")), true);
});

test("retry waits can be interrupted by job cancellation", async () => {
  const controller = new AbortController();
  const pending = waitForModelRetry(5_000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { message: "job_cancelled" });
});
