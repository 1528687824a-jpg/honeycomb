import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendJobEvent,
  createJob,
  getJob,
  setJobExecutionRetry,
  setJobStatus
} from "../packages/db/src/jobs";
import {
  getModelCallByKey,
  markModelCallFailedUnknownOutcome,
  markModelCallRetryWaiting,
  markModelCallStarted
} from "../packages/db/src/model-calls";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";
import { getRuntimeUsage } from "../packages/db/src/runtime";
import type { TaskExecutionRetryState } from "../packages/shared/src/model-retry-policy";

const marker = randomUUID().replace(/-/g, "");
let smokeJobId: string | null = null;

async function main() {
  await runMigrations();
  const job = await createJob({
    rawPrompt: `Model retry persistence smoke ${marker}`,
    displayTitle: "Model retry persistence smoke",
    ingressOrigin: "cli",
    requesterId: "model-retry-smoke"
  });
  smokeJobId = job.id;
  const idempotencyKey = `${job.id}:retry-smoke`;

  const started = await markModelCallStarted({
    idempotencyKey,
    jobId: job.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "image-agent"
  });
  const now = new Date();
  const retryState: TaskExecutionRetryState = {
    version: "honeycomb.model-retry.v1",
    status: "waiting",
    idempotencyKey,
    actionType: "stage-agent",
    agentId: "image-agent",
    providerId: "retry-smoke-provider",
    routeIndex: 0,
    failedAttemptNo: 1,
    nextAttemptNo: 2,
    maxAttempts: 3,
    failureCategory: "rate_limited",
    reason: "429 Too Many Requests",
    delayMs: 2_000,
    retryAfterMs: 2_000,
    retryAt: new Date(now.getTime() + 2_000).toISOString(),
    updatedAt: now.toISOString()
  };

  await markModelCallRetryWaiting({
    idempotencyKey,
    error: retryState.reason,
    responsePayload: { retryState, routeAttempts: [] },
    claimToken: started.claimToken
  });
  await setJobExecutionRetry(job.id, retryState);
  await appendJobEvent(job.id, "model_call.retry_scheduled", {
    idempotencyKey,
    failureCategory: retryState.failureCategory
  });

  assert.equal((await getModelCallByKey(idempotencyKey))?.status, "retry_waiting");
  assert.deepEqual((await getJob(job.id))?.executionRetry, retryState);
  const usage = await getRuntimeUsage();
  assert.equal(usage.summary.jobs.retrying >= 1, true);
  assert.equal(usage.summary.modelCalls.retryWaiting >= 1, true);
  assert.equal(usage.summary.modelCalls.retriesScheduled >= 1, true);

  const resumed = await markModelCallStarted({
    idempotencyKey,
    jobId: job.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "image-agent"
  });
  assert.equal(resumed.status, "started");
  assert.equal(resumed.responsePayload, null);

  await markModelCallFailedUnknownOutcome({
    idempotencyKey,
    error: "provider_result_unknown",
    claimToken: resumed.claimToken,
    responsePayload: {
      finalFailure: {
        category: "network_unknown_outcome",
        unknownOutcome: true
      }
    }
  });
  assert.equal((await getModelCallByKey(idempotencyKey))?.status, "failed_unknown_outcome");
  await setJobStatus(job.id, "waiting_for_human", {
    reason: "model_call_unknown_outcome: provider_result_unknown"
  });
  assert.equal((await getJob(job.id))?.executionRetry, null);

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    checked: [
      "retry_waiting_model_call_state",
      "persisted_job_retry_state",
      "runtime_retry_diagnostics",
      "retry_resume_transition",
      "unknown_outcome_pause"
    ]
  }, null, 2));
}

async function cleanup() {
  if (!smokeJobId) return;
  await pool.query(`delete from agent.model_calls where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.job_events where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.jobs where id = $1`, [smokeJobId]);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error(error));
    await closePool();
  });
