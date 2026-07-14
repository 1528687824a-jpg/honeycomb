import { randomUUID } from "node:crypto";
import { pool } from "./pool";

export type ModelCallStatus = "started" | "succeeded" | "failed" | "failed_unknown_outcome" | "cancelled";

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

export async function markModelCallStarted(input: {
  idempotencyKey: string;
  jobId: string;
  stageId?: string | null;
  attemptNo: number;
  actionType: string;
  agentId: string;
  agentSessionId?: string | null;
  requestHash?: string | null;
}): Promise<ModelCallRecord> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const jobResult = await client.query(
      `select status from agent.jobs where id = $1 for share`,
      [input.jobId]
    );
    const jobStatus = jobResult.rows[0]?.status;
    if (jobStatus === "cancelled") {
      throw new Error("job_cancelled");
    }
    if (!jobStatus || ["succeeded", "failed"].includes(jobStatus)) {
      throw new Error(`Model call could not start: ${input.idempotencyKey}`);
    }

    const result = await client.query(
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
        status
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'started')
      on conflict (idempotency_key) do update
        set status = case
              when agent.model_calls.status in ('failed', 'failed_unknown_outcome') then 'started'
              else agent.model_calls.status
            end,
            error = case
              when agent.model_calls.status in ('failed', 'failed_unknown_outcome') then null
              else agent.model_calls.error
            end,
            updated_at = now()
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
        input.requestHash ?? null
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
    return record;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markModelCallSucceeded(input: {
  idempotencyKey: string;
  responsePayload: Record<string, unknown>;
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
           updated_at = now()
       where idempotency_key = $1
         and status = 'started'
       returning *`,
      [
        input.idempotencyKey,
        cancelled ? "cancelled" : "succeeded",
        JSON.stringify(input.responsePayload)
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
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'failed',
         error = $2,
         updated_at = now()
     where idempotency_key = $1
       and status = 'started'
     returning *`,
    [input.idempotencyKey, sanitizePostgresText(input.error)]
  );

  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function markModelCallCancelled(input: {
  idempotencyKey: string;
  error?: string;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'cancelled',
         error = $2,
         updated_at = now()
     where idempotency_key = $1
       and status = 'started'
     returning *`,
    [input.idempotencyKey, sanitizePostgresText(input.error ?? "job_cancelled")]
  );
  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}

export async function markModelCallFailedUnknownOutcome(input: {
  idempotencyKey: string;
  error: string;
}): Promise<ModelCallRecord | null> {
  const result = await pool.query(
    `update agent.model_calls
     set status = 'failed_unknown_outcome',
         error = $2,
         updated_at = now()
     where idempotency_key = $1
       and status = 'started'
     returning *`,
    [input.idempotencyKey, sanitizePostgresText(input.error)]
  );

  return result.rows[0] ? toModelCallRecord(result.rows[0]) : null;
}
