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
  markModelCallSucceeded,
  reconcileModelCallAsFailed,
  setModelCallRequestReference
} from "../packages/db/src/model-calls";
import { scanExpiredModelCallLeases } from "../packages/db/src/model-call-leases";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";

const marker = randomUUID().replace(/-/g, "");
const smokeJobIds: string[] = [];

async function main() {
  await runMigrations();
  const job = await createJob({
    rawPrompt: `Execution lease smoke ${marker}`,
    displayTitle: "Execution lease smoke",
    ingressOrigin: "cli",
    requesterId: "execution-lease-smoke"
  });
  smokeJobIds.push(job.id);

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

  const ambiguousJob = await createJob({
    rawPrompt: `Expired ordinary model call ${marker}`,
    displayTitle: "Expired ordinary model call",
    ingressOrigin: "cli",
    requesterId: "execution-lease-smoke"
  });
  smokeJobIds.push(ambiguousJob.id);
  const ambiguousWorkflowId = `ambiguous-workflow-${marker}`;
  await claimJobWorkflowExecution({
    jobId: ambiguousJob.id,
    workflowId: ambiguousWorkflowId
  });
  await setJobStatus(ambiguousJob.id, "running", { reason: "lease_scan_smoke" });
  const ambiguousKey = `${ambiguousJob.id}:ordinary-expired`;
  await markModelCallStarted({
    idempotencyKey: ambiguousKey,
    jobId: ambiguousJob.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "writing-agent",
    executionWorkflowId: ambiguousWorkflowId,
    claimToken: "ordinary-expired-owner",
    leaseSeconds: 30
  });

  const videoJob = await createJob({
    rawPrompt: `Expired provider video task ${marker}`,
    displayTitle: "Expired provider video task",
    ingressOrigin: "cli",
    requesterId: "execution-lease-smoke"
  });
  smokeJobIds.push(videoJob.id);
  const videoWorkflowId = `video-workflow-${marker}`;
  await claimJobWorkflowExecution({ jobId: videoJob.id, workflowId: videoWorkflowId });
  await setJobStatus(videoJob.id, "running", { reason: "lease_scan_smoke" });
  const videoKey = `${videoJob.id}:video-expired`;
  const videoStarted = await markModelCallStarted({
    idempotencyKey: videoKey,
    jobId: videoJob.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "video-agent",
    executionWorkflowId: videoWorkflowId,
    claimToken: "video-expired-owner",
    leaseSeconds: 30
  });
  await setModelCallRequestReference({
    idempotencyKey: videoKey,
    claimToken: videoStarted.claimToken,
    requestReference: {
      version: "honeycomb.model-request-reference.v1",
      requestId: `${videoKey}:route:0`,
      providerRequestId: "video-request-smoke",
      providerTaskId: "video-task-smoke",
      providerId: "video-provider-smoke",
      model: "video-model-smoke",
      kind: "video",
      runner: "provider-direct",
      routeIndex: 0,
      routeAttemptNo: 1,
      preparedAt: new Date().toISOString()
    }
  });

  await pool.query(
    `update agent.model_calls
     set lease_expires_at = now() - interval '1 second'
     where idempotency_key = any($1::text[])`,
    [[ambiguousKey, videoKey]]
  );
  const ambiguousScan = await scanExpiredModelCallLeases({
    limit: 20,
    jobId: ambiguousJob.id
  });
  const videoScan = await scanExpiredModelCallLeases({
    limit: 20,
    jobId: videoJob.id
  });
  assert.equal(ambiguousScan.reconciliationRequired, 1);
  assert.equal(videoScan.providerResumeAvailable, 1);
  assert.deepEqual([...ambiguousScan.errors, ...videoScan.errors], []);
  assert.equal((await getModelCallByKey(ambiguousKey))?.status, "failed_unknown_outcome");
  assert.equal((await getJob(ambiguousJob.id))?.status, "waiting_for_human");
  const reconciledAmbiguous = await reconcileModelCallAsFailed({
    jobId: ambiguousJob.id,
    modelCallId: (await getModelCallByKey(ambiguousKey))!.id,
    error: "smoke_reconciled_provider_outcome",
    reconciliation: {
      version: "honeycomb.model-reconciliation.v1",
      status: "confirmed_failed",
      source: "manual",
      checkedAt: new Date().toISOString(),
      providerStatus: "failed",
      providerHttpStatus: null,
      reason: "smoke_reconciled_provider_outcome",
      canResume: true,
      resolvedAt: new Date().toISOString()
    }
  });
  assert.equal(reconciledAmbiguous?.leaseRecoveryStatus, null);
  const scannedVideo = await getModelCallByKey(videoKey);
  assert.equal(scannedVideo?.status, "started");
  assert.equal(scannedVideo?.claimToken, null);
  assert.equal(scannedVideo?.leaseRecoveryStatus, "provider_resume_available");
  assert.equal((await getJob(videoJob.id))?.heartbeatStatus, "stalled");
  assert.equal((await scanExpiredModelCallLeases({
    limit: 20,
    jobId: videoJob.id
  })).scanned, 0);

  const videoTakeover = await markModelCallStarted({
    idempotencyKey: videoKey,
    jobId: videoJob.id,
    attemptNo: 1,
    actionType: "stage-agent",
    agentId: "video-agent",
    executionWorkflowId: videoWorkflowId,
    claimToken: "video-resume-owner",
    leaseSeconds: 60,
    allowExpiredStartedTakeover: true
  });
  assert.equal(videoTakeover.claimAcquired, true);
  assert.equal(videoTakeover.leaseRecoveryStatus, null);

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    workflowId: resumed.workflowId,
    checked: [
      "single_initial_workflow_claim",
      "single_concurrent_resume_claim",
      "single_model_call_lease_owner",
      "expired_provider_task_takeover",
      "stale_model_call_owner_fenced",
      "ordinary_expired_call_requires_reconciliation",
      "completed_reconciliation_clears_recovery_marker",
      "expired_video_task_remains_resumable",
      "lease_scan_recovery_status",
      "job_scoped_scan_is_idempotent"
    ]
  }, null, 2));
}

async function cleanup() {
  for (const jobId of [...smokeJobIds].reverse()) {
    await pool.query(`delete from agent.model_call_spend where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.model_calls where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.agent_events where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.job_events where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.jobs where id = $1`, [jobId]);
  }
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
