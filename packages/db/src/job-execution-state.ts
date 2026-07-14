import {
  classifyModelCallLeaseRecovery,
  type ModelCallLeaseRecoveryClassification
} from "../../shared/src/execution-lease-policy";
import {
  projectJobExecutionState,
  type JobExecutionModelCallActivity,
  type JobExecutionQueueActivity,
  type JobExecutionState
} from "../../shared/src/job-execution-state";
import { parseModelCallRequestReference } from "../../shared/src/model-reconciliation";
import { expirePendingToolApprovals, listToolApprovals } from "./approvals";
import { listArtifactDeliveriesForJob } from "./artifact-deliveries";
import { getJob } from "./jobs";
import { getStagesForJob } from "./pipeline";
import { getPlan, listPlans } from "./plans";
import { pool } from "./pool";

function iso(value: unknown) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function modelCallClassification(input: {
  status: JobExecutionModelCallActivity["status"];
  leaseExpiresAt: string | null;
  recoveryStatus: string | null;
  generatedAt: string;
  requestReference: ReturnType<typeof parseModelCallRequestReference>;
}): ModelCallLeaseRecoveryClassification {
  if (input.status === "failed_unknown_outcome") return "reconciliation_required";
  if (input.status === "started" && input.recoveryStatus === "provider_resume_available") {
    return "provider_resume_available";
  }
  if (input.status === "started" && input.recoveryStatus === "reconciliation_required") {
    return "reconciliation_required";
  }
  return classifyModelCallLeaseRecovery({
    status: input.status,
    leaseExpiresAt: input.leaseExpiresAt,
    now: input.generatedAt,
    requestReference: input.requestReference
  });
}

function toModelCallActivity(row: any, generatedAt: string): JobExecutionModelCallActivity {
  const requestReference = parseModelCallRequestReference(row.request_reference);
  const status = row.status as JobExecutionModelCallActivity["status"];
  const leaseExpiresAt = iso(row.lease_expires_at);
  const recoveryStatus = row.lease_recovery_status ?? null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    stageId: row.stage_id ?? null,
    agentId: row.agent_id,
    actionType: row.action_type,
    status,
    classification: modelCallClassification({
      status,
      leaseExpiresAt,
      recoveryStatus,
      generatedAt,
      requestReference
    }),
    providerId: requestReference?.providerId ?? null,
    model: requestReference?.model ?? null,
    leaseExpiresAt,
    recoveryStatus,
    error: row.error ?? null,
    updatedAt: iso(row.updated_at)!
  };
}

function toQueueActivity(row: any): JobExecutionQueueActivity {
  return {
    id: row.id,
    requestKey: row.request_key,
    stageId: row.stage_id ?? null,
    agentId: row.agent_id,
    providerId: row.provider_id,
    status: row.status,
    queuedAt: iso(row.queued_at)!,
    acquiredAt: iso(row.acquired_at),
    expiresAt: iso(row.expires_at),
    updatedAt: iso(row.updated_at)!
  };
}

export async function getJobExecutionState(jobId: string): Promise<JobExecutionState | null> {
  const job = await getJob(jobId);
  if (!job) return null;

  const generatedAt = new Date().toISOString();
  await expirePendingToolApprovals(new Date(generatedAt), job.id);
  const [
    stages,
    plans,
    approvals,
    deliveries,
    modelCalls,
    queues,
    artifactInventory
  ] = await Promise.all([
    getStagesForJob(job.id),
    listPlans({ jobId: job.id, limit: 1 }),
    listToolApprovals({ jobId: job.id, status: "pending", limit: 200 }),
    listArtifactDeliveriesForJob(job.id),
    pool.query(
      `select *
       from agent.model_calls
       where job_id = $1
         and status in ('started', 'retry_waiting', 'succeeded', 'failed', 'failed_unknown_outcome', 'cancelled')
       order by updated_at desc, id desc`,
      [job.id]
    ),
    pool.query(
      `select *
       from agent.model_call_queue
       where job_id = $1
         and status in ('queued', 'acquired')
         and (expires_at is null or expires_at > now())
       order by updated_at desc, id desc`,
      [job.id]
    ),
    pool.query(
      `select
         (select count(*)::int from agent.artifacts where job_id = $1) as artifact_count,
         count(*)::int as file_count,
         count(*) filter (where status = 'available')::int as available_file_count,
         count(*) filter (where status in ('download_failed', 'missing'))::int as failed_file_count
       from agent.artifact_files
       where job_id = $1`,
      [job.id]
    )
  ]);
  const plan = plans.plans[0] ? await getPlan(plans.plans[0].id) : null;
  const artifactRow = artifactInventory.rows[0] ?? {};

  return projectJobExecutionState({
    generatedAt,
    job,
    stages,
    plan,
    pendingApprovals: approvals.approvals,
    modelCalls: modelCalls.rows.map((row) => toModelCallActivity(row, generatedAt)),
    queues: queues.rows.map(toQueueActivity),
    deliveries,
    artifacts: {
      artifactCount: Number(artifactRow.artifact_count ?? 0),
      fileCount: Number(artifactRow.file_count ?? 0),
      availableFileCount: Number(artifactRow.available_file_count ?? 0),
      failedFileCount: Number(artifactRow.failed_file_count ?? 0)
    }
  });
}
