import {
  classifyModelCallLeaseRecovery,
  type ModelCallLeaseRecoveryClassification
} from "../../shared/src/execution-lease-policy";
import {
  projectJobExecutionState,
  type JobExecutionArtifactInventory,
  type JobExecutionModelCallActivity,
  type JobExecutionQueueActivity,
  type JobExecutionState
} from "../../shared/src/job-execution-state";
import { parseModelCallRequestReference } from "../../shared/src/model-reconciliation";
import {
  expirePendingToolApprovals,
  listPendingToolApprovalsForJobs
} from "./approvals";
import { listArtifactDeliveriesForJobs } from "./artifact-deliveries";
import { getJobsByIds } from "./jobs";
import { getStagesForJobs } from "./pipeline";
import { getLatestPlansForJobs } from "./plans";
import { pool } from "./pool";

type ModelCallByJob = JobExecutionModelCallActivity & { jobId: string };
type QueueByJob = JobExecutionQueueActivity & { jobId: string };

function iso(value: unknown) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function latestTimestamp(values: unknown[]) {
  return values
    .filter(Boolean)
    .map((value) => iso(value))
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function groupByJob<T extends { jobId: string }>(entries: T[]) {
  const grouped = new Map<string, T[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.jobId) ?? [];
    current.push(entry);
    grouped.set(entry.jobId, current);
  }
  return grouped;
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

function toModelCallActivity(row: any, generatedAt: string): ModelCallByJob {
  const requestReference = parseModelCallRequestReference(row.request_reference);
  const status = row.status as JobExecutionModelCallActivity["status"];
  const leaseExpiresAt = iso(row.lease_expires_at);
  const recoveryStatus = row.lease_recovery_status ?? null;
  return {
    jobId: row.job_id,
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

function toQueueActivity(row: any): QueueByJob {
  return {
    jobId: row.job_id,
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

function toArtifactInventory(row: any): JobExecutionArtifactInventory {
  return {
    artifactCount: Number(row?.artifact_count ?? 0),
    fileCount: Number(row?.file_count ?? 0),
    availableFileCount: Number(row?.available_file_count ?? 0),
    failedFileCount: Number(row?.failed_file_count ?? 0),
    updatedAt: latestTimestamp([row?.artifact_updated_at, row?.file_updated_at])
  };
}

export async function getJobExecutionStates(jobIds: string[]): Promise<JobExecutionState[]> {
  const ids = [...new Set(jobIds.map((jobId) => jobId.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  if (ids.length > 200) throw new Error("job_execution_state_batch_too_large");

  const jobs = await getJobsByIds(ids);
  if (jobs.length === 0) return [];
  const foundIds = jobs.map((job) => job.id);
  const generatedAt = new Date().toISOString();
  await expirePendingToolApprovals(new Date(generatedAt), foundIds);

  const [
    stages,
    plans,
    approvals,
    deliveries,
    modelCallRows,
    queueRows,
    artifactRows
  ] = await Promise.all([
    getStagesForJobs(foundIds),
    getLatestPlansForJobs(foundIds),
    listPendingToolApprovalsForJobs(foundIds),
    listArtifactDeliveriesForJobs(foundIds),
    pool.query(
      `select *
       from agent.model_calls
       where job_id = any($1::text[])
         and status in ('started', 'retry_waiting', 'succeeded', 'failed', 'failed_unknown_outcome', 'cancelled')
       order by job_id, updated_at desc, id desc`,
      [foundIds]
    ),
    pool.query(
      `select *
       from agent.model_call_queue
       where job_id = any($1::text[])
         and status in ('queued', 'acquired')
         and (expires_at is null or expires_at > now())
       order by job_id, updated_at desc, id desc`,
      [foundIds]
    ),
    pool.query(
      `with requested(job_id) as (
         select unnest($1::text[])
       ), artifact_counts as (
         select job_id, count(*)::int as artifact_count, max(created_at) as artifact_updated_at
         from agent.artifacts
         where job_id = any($1::text[])
         group by job_id
       ), file_counts as (
         select
           job_id,
           count(*)::int as file_count,
           count(*) filter (where status = 'available')::int as available_file_count,
           count(*) filter (where status in ('download_failed', 'missing'))::int as failed_file_count,
           max(updated_at) as file_updated_at
         from agent.artifact_files
         where job_id = any($1::text[])
         group by job_id
       )
       select
         requested.job_id,
         coalesce(artifact_counts.artifact_count, 0)::int as artifact_count,
         artifact_counts.artifact_updated_at,
         coalesce(file_counts.file_count, 0)::int as file_count,
         coalesce(file_counts.available_file_count, 0)::int as available_file_count,
         coalesce(file_counts.failed_file_count, 0)::int as failed_file_count,
         file_counts.file_updated_at
       from requested
       left join artifact_counts using (job_id)
       left join file_counts using (job_id)`,
      [foundIds]
    )
  ]);

  const stagesByJob = groupByJob(stages);
  const plansByJob = new Map(plans.map((plan) => [plan.plan.jobId, plan]));
  const approvalsByJob = groupByJob(approvals);
  const deliveriesByJob = groupByJob(deliveries);
  const modelCallsByJob = groupByJob(
    modelCallRows.rows.map((row) => toModelCallActivity(row, generatedAt))
  );
  const queuesByJob = groupByJob(queueRows.rows.map(toQueueActivity));
  const artifactsByJob = new Map(
    artifactRows.rows.map((row) => [row.job_id, toArtifactInventory(row)])
  );

  return jobs.map((job) => projectJobExecutionState({
    generatedAt,
    job,
    stages: stagesByJob.get(job.id) ?? [],
    plan: plansByJob.get(job.id) ?? null,
    pendingApprovals: approvalsByJob.get(job.id) ?? [],
    modelCalls: modelCallsByJob.get(job.id) ?? [],
    queues: queuesByJob.get(job.id) ?? [],
    deliveries: deliveriesByJob.get(job.id) ?? [],
    artifacts: artifactsByJob.get(job.id) ?? toArtifactInventory(null)
  }));
}

export async function getJobExecutionState(jobId: string): Promise<JobExecutionState | null> {
  return (await getJobExecutionStates([jobId]))[0] ?? null;
}
