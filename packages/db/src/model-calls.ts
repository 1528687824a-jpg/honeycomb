import { randomUUID } from "node:crypto";
import {
  parseModelCallReconciliationState,
  parseModelCallRequestReference,
  type ModelCallReconciliationState,
  type ModelCallRequestReference
} from "../../shared/src/model-reconciliation";
import {
  resolveModelCallLeaseClaim,
  type ModelCallLeaseClaimDecision
} from "../../shared/src/execution-lease-policy";
import { pool } from "./pool";

export type ModelCallStatus =
  | "started"
  | "retry_waiting"
  | "succeeded"
  | "failed"
  | "failed_unknown_outcome"
  | "cancelled";

export type ModelCallRecord = {
  id: string;
  idempotencyKey: string;
  jobId: string;
  stageId: string | null;
  attemptNo: number;
  actionType: string;
  agentId: string;
  agentSessionId: string | null;
  requestHash: string | null;
  status: ModelCallStatus;
  responsePayload: Record<string, unknown> | null;
  requestReference: ModelCallRequestReference | null;
  reconciliation: ModelCallReconciliationState | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  leaseRecoveryStatus: string | null;
  leaseRecoveryCheckedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

function toModelCallRecord(row: any): ModelCallRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id,
    stageId: row.stage_id,
    attemptNo: row.attempt_no,
    actionType: row.action_type,
    agentId: row.agent_id,
    agentSessionId: row.agent_session_id,
    requestHash: row.request_hash,
    status: row.status,
    responsePayload: row.response_payload ?? null,
    requestReference: parseModelCallRequestReference(row.request_reference),
    reconciliation: parseModelCallReconciliationState(row.reconciliation),
    claimToken: row.claim_token ?? null,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    leaseRecoveryStatus: row.lease_recovery_status ?? null,
    leaseRecoveryCheckedAt: row.lease_recovery_checked_at?.toISOString() ?? null,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function sanitizePostgresText(value: string) {
  return value.replace(/\u0000/g, "");
}

export async function getModelCallByKey(idempotencyKey: string): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `select * from agent.model_calls where idempotency_key = $1`,
    [idempotencyKey]
  );

  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function countModelCallsForJob(jobId: string): Promise<number> {
  const result = await pool.query(`select count(*)::int as count from agent.model_calls where job_id = $1`, [
    jobId
  ]);

  return Number(result.rows[0]?.count ?? 0);
}

export type ModelCallStartRecord = ModelCallRecord & {
  claimAcquired: boolean;
  claimReason: ModelCallLeaseClaimDecision["reason"];
};

function normalizeLeaseSeconds(value?: number) {
  const fallback = Number(process.env.MODEL_CALL_LEASE_SECONDS ?? 900);
  const seconds = Number.isFinite(value ?? fallback) ? Number(value ?? fallback) : 900;
  return Math.min(Math.max(Math.trunc(seconds), 30), 86400);
}

export async function markModelCallStarted(input: {
  idempotencyKey: string;
  jobId: string;
  stageId?: string | null;
  attemptNo: number;
  actionType: string;
  agentId: string;
  agentSessionId?: string | null;
  requestHash?: string | null;
  executionWorkflowId?: string | null;
  claimToken?: string;
  leaseSeconds?: number;
  allowExpiredStartedTakeover?: boolean;
}): Promise<ModelCallStartRecord> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [
      `honeycomb.model-call-lease.v1:${input.idempotencyKey}`
    ]);
    const jobResult = await client.query(
      `select status, workflow_id from agent.jobs where id = $1 for share`,
      [input.jobId]
    );
    const jobStatus = jobResult.rows[0]?.status;
    if (jobStatus === "cancelled") {
      throw new Error("job_cancelled");
    }
    if (!jobStatus || ![
      "created",
      "queued",
      "planning",
      "running",
      "testing",
      "fixing"
    ].includes(jobStatus)) {
      throw new Error(`Model call could not start: ${input.idempotencyKey}`);
    }
    if (
      (jobResult.rows[0]?.workflow_id ?? null) !== (input.executionWorkflowId ?? null)
    ) {
      throw new Error("job_execution_claim_lost");
    }

    const currentResult = await client.query(
      `select * from agent.model_calls where idempotency_key = $1 for update`,
      [input.idempotencyKey]
    );
    const current = currentResult.rows[0] ? toModelCallRecord(currentResult.rows[0]) : null;
    if (current && (
      current.jobId !== input.jobId ||
      current.stageId !== (input.stageId ?? null) ||
      current.attemptNo !== input.attemptNo ||
      current.actionType !== input.actionType ||
      current.agentId !== input.agentId ||
      (current.requestHash && input.requestHash && current.requestHash !== input.requestHash)
    )) {
      throw new Error(`model_call_identity_conflict: ${input.idempotencyKey}`);
    }
    const claimToken = input.claimToken ?? randomUUID();
    const claimDecision = resolveModelCallLeaseClaim({
      status: current?.status ?? null,
      currentClaimToken: current?.claimToken ?? null,
      requestedClaimToken: claimToken,
      leaseExpiresAt: current?.leaseExpiresAt ?? null,
      now: new Date().toISOString(),
      allowExpiredStartedTakeover: input.allowExpiredStartedTakeover ?? false
    });
    if (!claimDecision.allowed) {
      if (current?.status === "cancelled") {
        throw new Error("job_cancelled");
      }
      if (current?.status !== "started") {
        throw new Error(`Model call is already ${current?.status}: ${input.idempotencyKey}`);
      }
      await client.query("commit");
      return {
        ...current,
        claimAcquired: false,
        claimReason: claimDecision.reason
      };
    }

    const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds);
    const result = current
      ? await client.query(
          `update agent.model_calls
           set status = 'started',
               error = case when status in ('retry_waiting', 'failed') then null else error end,
               response_payload = case when status in ('retry_waiting', 'failed') then null else response_payload end,
               request_reference = case when status in ('retry_waiting', 'failed') then '{}'::jsonb else request_reference end,
               reconciliation = case when status in ('retry_waiting', 'failed') then '{}'::jsonb else reconciliation end,
               claim_token = $2,
               lease_expires_at = now() + ($3::int * interval '1 second'),
               lease_recovery_status = null,
               lease_recovery_checked_at = null,
               updated_at = now()
           where idempotency_key = $1
           returning *`,
          [input.idempotencyKey, claimToken, leaseSeconds]
        )
      : await client.query(
          `insert into agent.model_calls (
            id,
            idempotency_key,
            job_id,
            stage_id,
            attempt_no,
            action_type,
            agent_id,
            agent_session_id,
            request_hash,
            status,
            claim_token,
            lease_expires_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'started', $10, now() + ($11::int * interval '1 second'))
          returning *`,
          [
            `MC-${randomUUID().slice(0, 12).toUpperCase()}`,
            input.idempotencyKey,
            input.jobId,
            input.stageId ?? null,
            input.attemptNo,
            input.actionType,
            input.agentId,
            input.agentSessionId ?? null,
            input.requestHash ?? null,
            claimToken,
            leaseSeconds
          ]
        );
    const record = toModelCallRecord(result.rows[0]);
    if (record.status === "cancelled") {
      throw new Error("job_cancelled");
    }
    if (record.status !== "started") {
      throw new Error(`Model call is already ${record.status}: ${input.idempotencyKey}`);
    }
    await client.query("commit");
    return {
      ...record,
      claimAcquired: true,
      claimReason: claimDecision.reason
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getModelCallForJobById(
  jobId: string,
  modelCallId: string
): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `select * from agent.model_calls where id = $1 and job_id = $2`,
    [modelCallId, jobId]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function listUnknownOutcomeModelCallsForJob(
  jobId: string
): Promise<ModelCallRecord[]> {
  const result = await pool.query(
    `select *
     from agent.model_calls
     where job_id = $1
       and status = 'failed_unknown_outcome'
     order by updated_at desc, id desc`,
    [jobId]
  );
  return result.rows.map(toModelCallRecord);
}

export async function markModelCallSucceeded(input: {
  idempotencyKey: string;
  responsePayload: Record<string, unknown>;
  claimToken?: string | null;
}): Promise<ModelCallRecord> {
  const client = await pool.connect();
  let record: ModelCallRecord | null = null;
  try {
    await client.query("begin");
    const current = await client.query(
      `select model_call.*, job.status as job_status
       from agent.model_calls as model_call
       join agent.jobs as job on job.id = model_call.job_id
       where model_call.idempotency_key = $1
       for share of job`,
      [input.idempotencyKey]
    );
    if (!current.rows[0]) {
      throw new Error(`Model call not found: ${input.idempotencyKey}`);
    }
    if (current.rows[0].status === "cancelled") {
      throw new Error("job_cancelled");
    }
    if (current.rows[0].status !== "started") {
      throw new Error(`Model call is already ${current.rows[0].status}: ${input.idempotencyKey}`);
    }

    const cancelled = current.rows[0].job_status === "cancelled";
    const result = await client.query(
      `update agent.model_calls
       set status = $2,
           response_payload = case when $2 = 'cancelled' then response_payload else $3::jsonb end,
           error = case when $2 = 'cancelled' then 'job_cancelled' else null end,
           claim_token = null,
           lease_expires_at = null,
           lease_recovery_status = null,
           lease_recovery_checked_at = null,
           updated_at = now()
       where idempotency_key = $1
         and status = 'started'
         and claim_token = $4
       returning *`,
      [
        input.idempotencyKey,
        cancelled ? "cancelled" : "succeeded",
        JSON.stringify(input.responsePayload),
        input.claimToken ?? null
      ]
    );
    if (!result.rows[0]) {
      throw new Error(`Model call not found: ${input.idempotencyKey}`);
    }
    record = toModelCallRecord(result.rows[0]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (record.status === "cancelled") {
    throw new Error("job_cancelled");
  }
  return record;
}

export async function markModelCallFailed(input: {
  idempotencyKey: string;
  error: string;
  responsePayload?: Record<string, unknown> | null;
  claimToken?: string | null;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'failed',
         error = $2,
         response_payload = coalesce($3::jsonb, response_payload),
         claim_token = null,
         lease_expires_at = null,
         lease_recovery_status = null,
         lease_recovery_checked_at = null,
         updated_at = now()
     where idempotency_key = $1
       and status in ('started', 'retry_waiting')
       and claim_token = $4
     returning *`,
    [
      input.idempotencyKey,
      sanitizePostgresText(input.error),
      input.responsePayload ? JSON.stringify(input.responsePayload) : null,
      input.claimToken ?? null
    ]
  );

  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function markModelCallCancelled(input: {
  idempotencyKey: string;
  error?: string;
  claimToken?: string | null;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'cancelled',
         error = $2,
         claim_token = null,
         lease_expires_at = null,
         lease_recovery_status = null,
         lease_recovery_checked_at = null,
         updated_at = now()
     where idempotency_key = $1
       and status in ('started', 'retry_waiting')
       and claim_token = $3
     returning *`,
    [
      input.idempotencyKey,
      sanitizePostgresText(input.error ?? "job_cancelled"),
      input.claimToken ?? null
    ]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function markModelCallFailedUnknownOutcome(input: {
  idempotencyKey: string;
  error: string;
  responsePayload?: Record<string, unknown> | null;
  claimToken?: string | null;
  force?: boolean;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'failed_unknown_outcome',
         error = $2,
         response_payload = coalesce($3::jsonb, response_payload),
         claim_token = null,
         lease_expires_at = null,
         lease_recovery_status = case when $5::boolean then 'reconciliation_required' else null end,
         lease_recovery_checked_at = case when $5::boolean then now() else null end,
         updated_at = now()
     where idempotency_key = $1
       and status in ('started', 'retry_waiting')
       and (claim_token = $4 or $5::boolean)
     returning *`,
    [
      input.idempotencyKey,
      sanitizePostgresText(input.error),
      input.responsePayload ? JSON.stringify(input.responsePayload) : null,
      input.claimToken ?? null,
      input.force ?? false
    ]
  );

  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function markModelCallRetryWaiting(input: {
  idempotencyKey: string;
  error: string;
  responsePayload: Record<string, unknown>;
  claimToken?: string | null;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'retry_waiting',
         error = $2,
         response_payload = $3::jsonb,
         claim_token = null,
         lease_expires_at = null,
         lease_recovery_status = null,
         lease_recovery_checked_at = null,
         updated_at = now()
     where idempotency_key = $1
       and status = 'started'
       and claim_token = $4
     returning *`,
    [
      input.idempotencyKey,
      sanitizePostgresText(input.error),
      JSON.stringify(input.responsePayload),
      input.claimToken ?? null
    ]
  );

  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function setModelCallRequestReference(input: {
  idempotencyKey: string;
  requestReference: ModelCallRequestReference;
  claimToken?: string | null;
  leaseSeconds?: number;
}): Promise<ModelCallRecord | null> {
  const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds);
  const result = await pool.query(
    `update agent.model_calls
     set request_reference = $2::jsonb,
         lease_expires_at = case
           when $3::text is null then lease_expires_at
           else now() + ($4::int * interval '1 second')
         end,
         updated_at = now()
     where idempotency_key = $1
       and status = 'started'
       and claim_token = $3
     returning *`,
    [
      input.idempotencyKey,
      JSON.stringify(input.requestReference),
      input.claimToken ?? null,
      leaseSeconds
    ]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function renewModelCallLease(input: {
  idempotencyKey: string;
  claimToken: string;
  leaseSeconds?: number;
}) {
  const result = await pool.query(
    `update agent.model_calls
     set lease_expires_at = now() + ($3::int * interval '1 second'),
         updated_at = now()
     where idempotency_key = $1
       and status = 'started'
       and claim_token = $2
     returning *`,
    [input.idempotencyKey, input.claimToken, normalizeLeaseSeconds(input.leaseSeconds)]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function updateModelCallProviderTaskProgress(input: {
  idempotencyKey: string;
  providerTask: Record<string, unknown>;
  claimToken?: string | null;
  leaseSeconds?: number;
}): Promise<ModelCallRecord | null> {
  const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds);
  const result = await pool.query(
    `update agent.model_calls
     set response_payload = coalesce(response_payload, '{}'::jsonb)
           || jsonb_build_object('providerTask', $2::jsonb),
         lease_expires_at = case
           when $3::text is null then lease_expires_at
           else now() + ($4::int * interval '1 second')
         end,
         updated_at = now()
     where idempotency_key = $1
       and status = 'started'
       and claim_token = $3
     returning *`,
    [
      input.idempotencyKey,
      JSON.stringify(input.providerTask),
      input.claimToken ?? null,
      leaseSeconds
    ]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function recordModelCallReconciliation(input: {
  jobId: string;
  modelCallId: string;
  reconciliation: ModelCallReconciliationState;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set reconciliation = $3::jsonb,
         response_payload = coalesce(response_payload, '{}'::jsonb)
           || jsonb_build_object('reconciliation', $3::jsonb),
         updated_at = now()
     where id = $1
       and job_id = $2
       and status = 'failed_unknown_outcome'
     returning *`,
    [input.modelCallId, input.jobId, JSON.stringify(input.reconciliation)]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function reconcileModelCallAsFailed(input: {
  jobId: string;
  modelCallId: string;
  error: string;
  reconciliation: ModelCallReconciliationState;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'failed',
         error = $3,
         reconciliation = $4::jsonb,
         claim_token = null,
         lease_expires_at = null,
         lease_recovery_status = null,
         lease_recovery_checked_at = null,
         response_payload = coalesce(response_payload, '{}'::jsonb)
           || jsonb_build_object('reconciliation', $4::jsonb),
         updated_at = now()
     where id = $1
       and job_id = $2
       and status = 'failed_unknown_outcome'
     returning *`,
    [
      input.modelCallId,
      input.jobId,
      sanitizePostgresText(input.error),
      JSON.stringify(input.reconciliation)
    ]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function reconcileModelCallAsSucceeded(input: {
  jobId: string;
  modelCallId: string;
  responsePayload: Record<string, unknown>;
  reconciliation: ModelCallReconciliationState;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'succeeded',
         error = null,
         reconciliation = $3::jsonb,
         response_payload = $4::jsonb,
         claim_token = null,
         lease_expires_at = null,
         lease_recovery_status = null,
         lease_recovery_checked_at = null,
         updated_at = now()
     where id = $1
       and job_id = $2
       and status = 'failed_unknown_outcome'
     returning *`,
    [
      input.modelCallId,
      input.jobId,
      JSON.stringify(input.reconciliation),
      JSON.stringify({
        ...input.responsePayload,
        reconciliation: input.reconciliation
      })
    ]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}
