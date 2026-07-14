import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createJob,
  getJob,
  setJobStatus
} from "../packages/db/src/jobs";
import {
  getModelCallByKey,
  listUnknownOutcomeModelCallsForJob,
  markModelCallFailedUnknownOutcome,
  markModelCallStarted,
  reconcileModelCallAsFailed,
  reconcileModelCallAsSucceeded,
  recordModelCallReconciliation,
  setModelCallRequestReference
} from "../packages/db/src/model-calls";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";
import type {
  ModelCallReconciliationState,
  ModelCallRequestReference
} from "../packages/shared/src/model-reconciliation";

const marker = randomUUID().replace(/-/g, "");
let smokeJobId: string | null = null;

function reconciliationState(
  status: ModelCallReconciliationState["status"],
  canResume: boolean
): ModelCallReconciliationState {
  const now = new Date().toISOString();
  return {
    version: "honeycomb.model-reconciliation.v1",
    status,
    source: status === "provider_pending" ? "provider_query" : "manual",
    providerStatus: status,
    providerHttpStatus: 200,
    reason: `smoke_${status}`,
    canResume,
    checkedAt: now,
    resolvedAt: canResume ? now : null
  };
}

async function main() {
  await runMigrations();
  const job = await createJob({
    rawPrompt: `Model reconciliation smoke ${marker}`,
    displayTitle: "Model reconciliation smoke",
    ingressOrigin: "cli",
    requesterId: "model-reconciliation-smoke"
  });
  smokeJobId = job.id;
  const idempotencyKey = `${job.id}:reconciliation-smoke`;
  const started = await markModelCallStarted({
    idempotencyKey,
    jobId: job.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "image-agent",
    agentSessionId: job.sessionId
  });
  const requestReference: ModelCallRequestReference = {
    version: "honeycomb.model-request-reference.v1",
    requestId: `${idempotencyKey}:route:0`,
    providerRequestId: "provider-request-smoke",
    providerTaskId: null,
    providerId: "provider-smoke",
    model: "image-model-smoke",
    kind: "image",
    runner: "provider-direct",
    routeIndex: 0,
    routeAttemptNo: 1,
    preparedAt: new Date().toISOString()
  };
  await setModelCallRequestReference({
    idempotencyKey,
    requestReference,
    claimToken: started.claimToken
  });
  await markModelCallFailedUnknownOutcome({
    idempotencyKey,
    error: "provider_result_unknown",
    claimToken: started.claimToken
  });
  await setJobStatus(job.id, "waiting_for_human", {
    reason: "model_call_reconciliation_required"
  });

  assert.equal((await listUnknownOutcomeModelCallsForJob(job.id)).length, 1);
  assert.equal((await getModelCallByKey(idempotencyKey))?.requestReference?.providerRequestId, "provider-request-smoke");

  await setJobStatus(job.id, "running", { reason: "simulate_unsafe_resume" });
  await assert.rejects(
    markModelCallStarted({
      idempotencyKey,
      jobId: job.id,
      attemptNo: 1,
      actionType: "stage-agent",
      agentId: "image-agent"
    }),
    /already failed_unknown_outcome/
  );
  await setJobStatus(job.id, "waiting_for_human", {
    reason: "model_call_reconciliation_required"
  });

  const pending = reconciliationState("provider_pending", false);
  await recordModelCallReconciliation({
    jobId: job.id,
    modelCallId: started.id,
    reconciliation: pending
  });
  assert.equal((await getModelCallByKey(idempotencyKey))?.reconciliation?.status, "provider_pending");

  const notAccepted = reconciliationState("confirmed_not_accepted", true);
  await reconcileModelCallAsFailed({
    jobId: job.id,
    modelCallId: started.id,
    error: "provider_confirmed_not_accepted",
    reconciliation: notAccepted
  });
  assert.equal((await getModelCallByKey(idempotencyKey))?.status, "failed");

  await setJobStatus(job.id, "running", { reason: "safe_resume_after_reconciliation" });
  const restarted = await markModelCallStarted({
    idempotencyKey,
    jobId: job.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "image-agent",
    agentSessionId: job.sessionId
  });
  assert.equal(restarted.status, "started");
  assert.equal(restarted.requestReference, null);
  assert.equal(restarted.reconciliation, null);

  await setModelCallRequestReference({
    idempotencyKey,
    requestReference,
    claimToken: restarted.claimToken
  });
  await markModelCallFailedUnknownOutcome({
    idempotencyKey,
    error: "provider_result_unknown_after_restart",
    claimToken: restarted.claimToken
  });
  const succeeded = reconciliationState("confirmed_succeeded", true);
  await reconcileModelCallAsSucceeded({
    jobId: job.id,
    modelCallId: started.id,
    reconciliation: succeeded,
    responsePayload: {
      result: {
        mode: "provider-direct",
        sessionId: job.sessionId,
        text: "recovered provider output",
        textSource: "provider:reconciled",
        usage: null,
        raw: null
      }
    }
  });
  assert.equal((await getModelCallByKey(idempotencyKey))?.status, "succeeded");
  assert.equal((await listUnknownOutcomeModelCallsForJob(job.id)).length, 0);
  assert.equal((await getJob(job.id))?.status, "running");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    checked: [
      "request_reference_persistence",
      "unsafe_unknown_outcome_restart_blocked",
      "pending_reconciliation_persistence",
      "confirmed_not_accepted_retry_unlock",
      "stale_reconciliation_reset",
      "recovered_success_reuse"
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
