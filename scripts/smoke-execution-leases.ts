import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  claimJobWorkflowExecution,
  createJob,
  getJob,
  requestJobResume,
  setJobStatus
} from "../packages/db/src/jobs";
import {
  getModelCallByKey,
  markModelCallStarted,
  markModelCallSucceeded
} from "../packages/db/src/model-calls";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";

const marker = randomUUID().replace(/-/g, "");
let smokeJobId: string | null = null;

async function main() {
  await runMigrations();
  const job = await createJob({
    rawPrompt: `Execution lease smoke ${marker}`,
    displayTitle: "Execution lease smoke",
    ingressOrigin: "cli",
    requesterId: "execution-lease-smoke"
  });
  smokeJobId = job.id;

  const initialClaims = await Promise.all([
    claimJobWorkflowExecution({ jobId: job.id, workflowId: `workflow-a-${marker}` }),
    claimJobWorkflowExecution({ jobId: job.id, workflowId: `workflow-b-${marker}` })
  ]);
  assert.equal(initialClaims.filter((claim) => claim.claimed).length, 1);

  await setJobStatus(job.id, "waiting_for_human", { reason: "smoke_resume_race" });
  const resumeClaims = await Promise.all([
    requestJobResume({ jobId: job.id, workflowId: `resume-a-${marker}` }),
    requestJobResume({ jobId: job.id, workflowId: `resume-b-${marker}` })
  ]);
  assert.equal(resumeClaims.filter((claim) => claim.changed).length, 1);
  const resumed = resumeClaims.find((claim) => claim.changed);
  assert.ok(resumed?.job);
  assert.equal((await getJob(job.id))?.workflowId, resumed.workflowId);

  await setJobStatus(job.id, "running", { reason: "smoke_model_call_race" });
  const idempotencyKey = `${job.id}:stage-smoke:1:stage-agent`;
  const modelCallClaims = await Promise.all([
    markModelCallStarted({
      idempotencyKey,
      jobId: job.id,
      attemptNo: 1,
      actionType: "stage-agent",
      agentId: "image-agent",
      executionWorkflowId: resumed.workflowId,
      claimToken: "model-owner-a",
      leaseSeconds: 60
    }),
    markModelCallStarted({
      idempotencyKey,
      jobId: job.id,
      attemptNo: 1,
      actionType: "stage-agent",
      agentId: "image-agent",
      executionWorkflowId: resumed.workflowId,
      claimToken: "model-owner-b",
      leaseSeconds: 60
    })
  ]);
  assert.equal(modelCallClaims.filter((claim) => claim.claimAcquired).length, 1);
  assert.equal(modelCallClaims.filter((claim) => claim.claimReason === "in_progress").length, 1);

  const firstOwner = modelCallClaims.find((claim) => claim.claimAcquired)?.claimToken;
  assert.ok(firstOwner);
  await pool.query(
    `update agent.model_calls
     set lease_expires_at = now() - interval '1 second'
     where idempotency_key = $1`,
    [idempotencyKey]
  );
  const takeover = await markModelCallStarted({
    idempotencyKey,
    jobId: job.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "image-agent",
    executionWorkflowId: resumed.workflowId,
    claimToken: "provider-resume-owner",
    leaseSeconds: 60,
    allowExpiredStartedTakeover: true
  });
  assert.equal(takeover.claimAcquired, true);
  assert.equal(takeover.claimReason, "expired_provider_resume");

  await assert.rejects(
    markModelCallSucceeded({
      idempotencyKey,
      claimToken: firstOwner,
      responsePayload: { result: "stale owner must not win" }
    })
  );
  await markModelCallSucceeded({
    idempotencyKey,
    claimToken: takeover.claimToken,
    responsePayload: { result: "current owner completed" }
  });
  assert.equal((await getModelCallByKey(idempotencyKey))?.status, "succeeded");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    workflowId: resumed.workflowId,
    checked: [
      "single_initial_workflow_claim",
      "single_concurrent_resume_claim",
      "single_model_call_lease_owner",
      "expired_provider_task_takeover",
      "stale_model_call_owner_fenced"
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
  .then(async () => {
    await cleanup();
    await closePool();
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exitCode = 1;
  });
