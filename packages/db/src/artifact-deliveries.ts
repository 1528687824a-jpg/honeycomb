import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ArtifactDeliveryRecord,
  ArtifactDeliveryStatus,
  ArtifactFileRecord,
  ArtifactFileStatus,
  TaskDeliveryTarget
} from "../../shared/src/types";
import { summarizeArtifactDeliveryRecords } from "../../shared/src/artifact-delivery-state";
import { appendJobEvent } from "./jobs";
import { pool } from "./pool";

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalInteger(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function toArtifactFileRecord(row: any): ArtifactFileRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    jobId: row.job_id,
    stageId: row.stage_id ?? null,
    kind: row.kind,
    status: row.status,
    filePath: row.file_path ?? null,
    externalUrl: row.external_url ?? null,
    fileName: row.file_name,
    mimeType: row.mime_type ?? null,
    format: row.format ?? null,
    sizeBytes: optionalInteger(row.size_bytes),
    width: optionalInteger(row.width),
    height: optionalInteger(row.height),
    checksumSha256: row.checksum_sha256 ?? null,
    source: row.source ?? null,
    error: row.error ?? null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

function toArtifactDeliveryRecord(row: any): ArtifactDeliveryRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    artifactFileId: row.artifact_file_id,
    deliverableIndex: Number(row.deliverable_index),
    required: Boolean(row.required),
    target: row.target,
    targetPath: row.target_path ?? null,
    requestedFileName: row.requested_file_name,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    claimToken: row.claim_token ?? null,
    leaseExpiresAt: iso(row.lease_expires_at),
    expectedSizeBytes: optionalInteger(row.expected_size_bytes),
    expectedChecksumSha256: row.expected_checksum_sha256 ?? null,
    deliveredPath: row.delivered_path ?? null,
    deliveredSizeBytes: optionalInteger(row.delivered_size_bytes),
    deliveredChecksumSha256: row.delivered_checksum_sha256 ?? null,
    lastError: row.last_error ?? null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    completedAt: iso(row.completed_at)
  };
}

export async function upsertArtifactFile(input: {
  id: string;
  artifactId: string;
  jobId: string;
  stageId?: string | null;
  kind: "image" | "video";
  status: ArtifactFileStatus;
  filePath?: string | null;
  externalUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  format?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  checksumSha256?: string | null;
  source?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const result = await pool.query(
    `insert into agent.artifact_files (
       id, artifact_id, job_id, stage_id, kind, status, file_path, external_url,
       file_name, mime_type, format, size_bytes, width, height, checksum_sha256,
       source, error, metadata
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18::jsonb
     )
     on conflict (id) do update
       set artifact_id = excluded.artifact_id,
           job_id = excluded.job_id,
           stage_id = excluded.stage_id,
           kind = excluded.kind,
           status = excluded.status,
           file_path = excluded.file_path,
           external_url = excluded.external_url,
           file_name = excluded.file_name,
           mime_type = excluded.mime_type,
           format = excluded.format,
           size_bytes = excluded.size_bytes,
           width = excluded.width,
           height = excluded.height,
           checksum_sha256 = excluded.checksum_sha256,
           source = excluded.source,
           error = excluded.error,
           metadata = excluded.metadata,
           updated_at = now()
     returning *`,
    [
      input.id,
      input.artifactId,
      input.jobId,
      input.stageId ?? null,
      input.kind,
      input.status,
      input.filePath ?? null,
      input.externalUrl ?? null,
      input.fileName?.trim() || path.basename(input.filePath ?? "") || `${input.kind}-artifact`,
      input.mimeType ?? null,
      input.format ?? null,
      input.sizeBytes ?? null,
      input.width ?? null,
      input.height ?? null,
      input.checksumSha256 ?? null,
      input.source ?? null,
      input.error ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  const file = toArtifactFileRecord(result.rows[0]);
  await appendJobEvent(
    input.jobId,
    "artifact.file_upserted",
    {
      artifactFileId: file.id,
      artifactId: file.artifactId,
      stageId: file.stageId,
      kind: file.kind,
      status: file.status,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
      checksumSha256: file.checksumSha256
    },
    { actor: "artifact-store", stageId: file.stageId, artifactId: file.artifactId }
  );
  return file;
}

export async function getArtifactFileForJob(jobId: string, artifactFileId: string) {
  const result = await pool.query(
    `select * from agent.artifact_files where job_id = $1 and id = $2`,
    [jobId, artifactFileId]
  );
  return result.rows[0] ? toArtifactFileRecord(result.rows[0]) : null;
}

export async function listArtifactFilesForJob(jobId: string) {
  const result = await pool.query(
    `select * from agent.artifact_files where job_id = $1 order by created_at, id`,
    [jobId]
  );
  return result.rows.map(toArtifactFileRecord);
}

export async function ensureArtifactDelivery(input: {
  id: string;
  jobId: string;
  artifactFileId: string;
  deliverableIndex: number;
  required: boolean;
  target: TaskDeliveryTarget;
  targetPath?: string | null;
  requestedFileName: string;
  initialStatus?: Extract<ArtifactDeliveryStatus, "pending" | "succeeded">;
  expectedSizeBytes?: number | null;
  expectedChecksumSha256?: string | null;
  deliveredPath?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const status = input.initialStatus ?? "pending";
  const result = await pool.query(
    `insert into agent.artifact_deliveries (
       id, job_id, artifact_file_id, deliverable_index, required, target,
       target_path, requested_file_name, status, expected_size_bytes,
       expected_checksum_sha256, delivered_path, delivered_size_bytes,
       delivered_checksum_sha256, completed_at, metadata
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       case when $9 = 'succeeded' then $10 else null end,
       case when $9 = 'succeeded' then $11 else null end,
       case when $9 = 'succeeded' then now() else null end,
       $13::jsonb
     )
     on conflict (job_id, deliverable_index) do update
       set artifact_file_id = excluded.artifact_file_id,
           required = excluded.required,
           target = excluded.target,
           target_path = excluded.target_path,
           requested_file_name = excluded.requested_file_name,
           expected_size_bytes = excluded.expected_size_bytes,
           expected_checksum_sha256 = excluded.expected_checksum_sha256,
           status = case
             when agent.artifact_deliveries.status = 'succeeded'
              and agent.artifact_deliveries.artifact_file_id = excluded.artifact_file_id
              and agent.artifact_deliveries.target = excluded.target
              and agent.artifact_deliveries.target_path is not distinct from excluded.target_path
              and agent.artifact_deliveries.expected_size_bytes is not distinct from excluded.expected_size_bytes
              and agent.artifact_deliveries.expected_checksum_sha256 is not distinct from excluded.expected_checksum_sha256
             then 'succeeded'
             else excluded.status
           end,
           attempt_count = case
             when agent.artifact_deliveries.artifact_file_id = excluded.artifact_file_id
              and agent.artifact_deliveries.target = excluded.target
              and agent.artifact_deliveries.target_path is not distinct from excluded.target_path
              and agent.artifact_deliveries.expected_size_bytes is not distinct from excluded.expected_size_bytes
              and agent.artifact_deliveries.expected_checksum_sha256 is not distinct from excluded.expected_checksum_sha256
             then agent.artifact_deliveries.attempt_count
             else 0
           end,
           claim_token = null,
           lease_expires_at = null,
           delivered_path = case
             when agent.artifact_deliveries.status = 'succeeded'
              and agent.artifact_deliveries.artifact_file_id = excluded.artifact_file_id
              and agent.artifact_deliveries.target = excluded.target
              and agent.artifact_deliveries.target_path is not distinct from excluded.target_path
              and agent.artifact_deliveries.expected_size_bytes is not distinct from excluded.expected_size_bytes
              and agent.artifact_deliveries.expected_checksum_sha256 is not distinct from excluded.expected_checksum_sha256
             then agent.artifact_deliveries.delivered_path
             else excluded.delivered_path
           end,
           delivered_size_bytes = case
             when agent.artifact_deliveries.status = 'succeeded'
              and agent.artifact_deliveries.artifact_file_id = excluded.artifact_file_id
              and agent.artifact_deliveries.target = excluded.target
              and agent.artifact_deliveries.target_path is not distinct from excluded.target_path
              and agent.artifact_deliveries.expected_size_bytes is not distinct from excluded.expected_size_bytes
              and agent.artifact_deliveries.expected_checksum_sha256 is not distinct from excluded.expected_checksum_sha256
             then agent.artifact_deliveries.delivered_size_bytes
             else excluded.delivered_size_bytes
           end,
           delivered_checksum_sha256 = case
             when agent.artifact_deliveries.status = 'succeeded'
              and agent.artifact_deliveries.artifact_file_id = excluded.artifact_file_id
              and agent.artifact_deliveries.target = excluded.target
              and agent.artifact_deliveries.target_path is not distinct from excluded.target_path
              and agent.artifact_deliveries.expected_size_bytes is not distinct from excluded.expected_size_bytes
              and agent.artifact_deliveries.expected_checksum_sha256 is not distinct from excluded.expected_checksum_sha256
             then agent.artifact_deliveries.delivered_checksum_sha256
             else excluded.delivered_checksum_sha256
           end,
           last_error = null,
           completed_at = case
             when agent.artifact_deliveries.status = 'succeeded'
              and agent.artifact_deliveries.artifact_file_id = excluded.artifact_file_id
              and agent.artifact_deliveries.target = excluded.target
              and agent.artifact_deliveries.target_path is not distinct from excluded.target_path
              and agent.artifact_deliveries.expected_size_bytes is not distinct from excluded.expected_size_bytes
              and agent.artifact_deliveries.expected_checksum_sha256 is not distinct from excluded.expected_checksum_sha256
             then agent.artifact_deliveries.completed_at
             else excluded.completed_at
           end,
           metadata = excluded.metadata,
           updated_at = now()
     returning *`,
    [
      input.id,
      input.jobId,
      input.artifactFileId,
      input.deliverableIndex,
      input.required,
      input.target,
      input.targetPath ?? null,
      input.requestedFileName,
      status,
      input.expectedSizeBytes ?? null,
      input.expectedChecksumSha256 ?? null,
      input.deliveredPath ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  const delivery = toArtifactDeliveryRecord(result.rows[0]);
  await appendJobEvent(
    input.jobId,
    "artifact.delivery_planned",
    {
      deliveryId: delivery.id,
      artifactFileId: delivery.artifactFileId,
      deliverableIndex: delivery.deliverableIndex,
      target: delivery.target,
      targetPath: delivery.targetPath,
      status: delivery.status,
      requestedFileName: delivery.requestedFileName
    },
    { actor: "artifact-delivery" }
  );
  return delivery;
}

export async function listArtifactDeliveriesForJob(jobId: string) {
  const result = await pool.query(
    `select * from agent.artifact_deliveries where job_id = $1 order by deliverable_index, id`,
    [jobId]
  );
  return result.rows.map(toArtifactDeliveryRecord);
}

export async function getArtifactDeliveryForJob(jobId: string, deliveryId: string) {
  const result = await pool.query(
    `select * from agent.artifact_deliveries where job_id = $1 and id = $2`,
    [jobId, deliveryId]
  );
  return result.rows[0] ? toArtifactDeliveryRecord(result.rows[0]) : null;
}

export async function getArtifactDeliverySummary(jobId: string) {
  const deliveries = await listArtifactDeliveriesForJob(jobId);
  return {
    deliveries,
    ...summarizeArtifactDeliveryRecords(deliveries)
  };
}

export async function claimArtifactDelivery(input: {
  jobId: string;
  deliveryId: string;
  leaseSeconds?: number;
  retryDelaySeconds?: number;
}) {
  const claimToken = randomUUID();
  const leaseSeconds = Math.max(30, Math.min(1_800, Math.floor(input.leaseSeconds ?? 300)));
  const retryDelaySeconds = Math.max(0, Math.min(300, Math.floor(input.retryDelaySeconds ?? 15)));
  const result = await pool.query(
    `update agent.artifact_deliveries d
     set status = 'delivering',
         attempt_count = attempt_count + 1,
         claim_token = $3,
         lease_expires_at = now() + ($4 * interval '1 second'),
         last_error = null,
         updated_at = now()
     where d.job_id = $1
       and d.id = $2
       and d.required
       and (
         d.status = 'pending'
         or (d.status = 'failed' and d.updated_at <= now() - ($5 * interval '1 second'))
         or (d.status = 'delivering' and d.lease_expires_at < now())
       )
       and exists (
         select 1 from agent.jobs j
         where j.id = d.job_id and j.status not in ('succeeded', 'failed', 'cancelled')
       )
     returning d.*`,
    [input.jobId, input.deliveryId, claimToken, leaseSeconds, retryDelaySeconds]
  );
  if (!result.rows[0]) {
    return {
      claimed: false as const,
      claimToken: null,
      delivery: await getArtifactDeliveryForJob(input.jobId, input.deliveryId)
    };
  }
  const delivery = toArtifactDeliveryRecord(result.rows[0]);
  await appendJobEvent(
    input.jobId,
    "artifact.delivery_claimed",
    {
      deliveryId: delivery.id,
      artifactFileId: delivery.artifactFileId,
      attemptCount: delivery.attemptCount,
      leaseExpiresAt: delivery.leaseExpiresAt
    },
    { actor: "desktop-delivery" }
  );
  return { claimed: true as const, claimToken, delivery };
}

export async function completeArtifactDelivery(input: {
  jobId: string;
  deliveryId: string;
  claimToken: string;
  deliveredPath: string;
  deliveredSizeBytes: number;
  deliveredChecksumSha256?: string | null;
}) {
  const result = await pool.query(
    `update agent.artifact_deliveries
     set status = 'succeeded',
         delivered_path = $4,
         delivered_size_bytes = $5,
         delivered_checksum_sha256 = $6,
         claim_token = null,
         lease_expires_at = null,
         last_error = null,
         completed_at = now(),
         updated_at = now()
     where job_id = $1
       and id = $2
       and status = 'delivering'
       and claim_token = $3
       and lease_expires_at >= now()
       and (expected_size_bytes is null or expected_size_bytes = $5)
       and (
         expected_checksum_sha256 is null
         or lower(expected_checksum_sha256) = lower(coalesce($6, ''))
       )
     returning *`,
    [
      input.jobId,
      input.deliveryId,
      input.claimToken,
      input.deliveredPath,
      input.deliveredSizeBytes,
      input.deliveredChecksumSha256 ?? null
    ]
  );
  if (!result.rows[0]) {
    return { completed: false as const, delivery: await getArtifactDeliveryForJob(input.jobId, input.deliveryId) };
  }
  const delivery = toArtifactDeliveryRecord(result.rows[0]);
  await appendJobEvent(
    input.jobId,
    "artifact.delivery_succeeded",
    {
      deliveryId: delivery.id,
      artifactFileId: delivery.artifactFileId,
      target: delivery.target,
      deliveredPath: delivery.deliveredPath,
      deliveredSizeBytes: delivery.deliveredSizeBytes,
      deliveredChecksumSha256: delivery.deliveredChecksumSha256,
      attemptCount: delivery.attemptCount
    },
    { actor: "desktop-delivery" }
  );
  return { completed: true as const, delivery };
}

export async function failArtifactDelivery(input: {
  jobId: string;
  deliveryId: string;
  claimToken: string;
  error: string;
}) {
  const result = await pool.query(
    `update agent.artifact_deliveries
     set status = 'failed',
         claim_token = null,
         lease_expires_at = null,
         last_error = $4,
         updated_at = now()
     where job_id = $1
       and id = $2
       and status = 'delivering'
       and claim_token = $3
     returning *`,
    [input.jobId, input.deliveryId, input.claimToken, input.error.slice(0, 1000)]
  );
  if (!result.rows[0]) {
    return { failed: false as const, delivery: await getArtifactDeliveryForJob(input.jobId, input.deliveryId) };
  }
  const delivery = toArtifactDeliveryRecord(result.rows[0]);
  await appendJobEvent(
    input.jobId,
    "artifact.delivery_failed",
    {
      deliveryId: delivery.id,
      artifactFileId: delivery.artifactFileId,
      target: delivery.target,
      error: delivery.lastError,
      attemptCount: delivery.attemptCount
    },
    { actor: "desktop-delivery" }
  );
  return { failed: true as const, delivery };
}

export async function claimJobArtifactDeliveryFinalization(jobId: string) {
  const result = await pool.query(
    `update agent.jobs j
     set heartbeat_at = now(),
         heartbeat_status = 'healthy',
         heartbeat_source = 'artifact.delivery_resuming',
         heartbeat_note = 'artifact_delivery_resuming',
         updated_at = now()
     where j.id = $1
       and j.status = 'waiting_for_human'
       and j.heartbeat_note in (
         'artifact_delivery_pending',
         'artifact_delivery_failed',
         'artifact_delivery_resume_failed'
       )
       and exists (
         select 1 from agent.artifact_deliveries d
         where d.job_id = j.id and d.required and d.status <> 'cancelled'
       )
       and not exists (
         select 1 from agent.artifact_deliveries d
         where d.job_id = j.id and d.required and d.status not in ('succeeded', 'cancelled')
       )
     returning j.id`,
    [jobId]
  );
  if (!result.rows[0]) return false;
  await appendJobEvent(
    jobId,
    "artifact.delivery_finalization_claimed",
    {},
    { actor: "artifact-delivery" }
  ).catch(() => undefined);
  return true;
}
