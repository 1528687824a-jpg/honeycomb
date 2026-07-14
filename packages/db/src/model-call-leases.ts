import { parseModelCallRequestReference } from "../../shared/src/model-reconciliation";
import {
  classifyModelCallLeaseRecovery,
  type ModelCallLeaseRecoveryClassification
} from "../../shared/src/execution-lease-policy";
import { appendJobEvent } from "./jobs";
import { markModelCallSpendOutcomeUnknown } from "./model-call-spend";
import { pool } from "./pool";

const ACTIVE_JOB_STATUSES = ["created", "queued", "planning", "running", "testing", "fixing"];
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export type ModelCallLeaseEntry = {
  modelCallId: string;
  idempotencyKey: string;
  jobId: string;
  stageId: string | null;
  actionType: string;
  agentId: string;
  status: string;
  leaseExpiresAt: string | null;
  recoveryStatus: string | null;
  recoveryCheckedAt: string | null;
  classification: ModelCallLeaseRecoveryClassification;
  providerId: string | null;
  model: string | null;
  providerTaskId: string | null;
  error: string | null;
  updatedAt: string;
};

export type ModelCallLeaseSummary = {
  checkedAt: string;
  started: number;
  active: number;
  expiredStarted: number;
  missingLease: number;
  providerResumeAvailable: number;
  reconciliationRequired: number;
  recent: ModelCallLeaseEntry[];
};

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : null;
}

function toLeaseEntry(row: any, checkedAt: string): ModelCallLeaseEntry {
  const requestReference = parseModelCallRequestReference(row.request_reference);
  const classification = row.lease_recovery_status === "reconciliation_required" || (
    row.status === "started" && TERMINAL_JOB_STATUSES.has(row.job_status)
  )
    ? "reconciliation_required"
    : classifyModelCallLeaseRecovery({
        status: row.status,
        leaseExpiresAt: iso(row.lease_expires_at),
        now: checkedAt,
        requestReference
      });
  return {
    modelCallId: row.id,
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id,
    stageId: row.stage_id ?? null,
    actionType: row.action_type,
    agentId: row.agent_id,
    status: row.status,
    leaseExpiresAt: iso(row.lease_expires_at),
    recoveryStatus: row.lease_recovery_status ?? null,
    recoveryCheckedAt: iso(row.lease_recovery_checked_at),
    classification,
    providerId: requestReference?.providerId ?? null,
    model: requestReference?.model ?? null,
    providerTaskId: requestReference?.providerTaskId ?? null,
    error: row.error ?? null,
    updatedAt: row.updated_at.toISOString()
  };
}

function normalizeLimit(value?: number) {
  return Math.min(Math.max(Math.trunc(value ?? 50), 1), 500);
}

export async function getModelCallLeaseSummary(input: {
  limit?: number;
  jobId?: string;
} = {}): Promise<ModelCallLeaseSummary> {
  const checkedAt = new Date().toISOString();
  const limit = Math.min(normalizeLimit(input.limit), 100);
  const jobWhere = input.jobId ? "where mc.job_id = $1" : "";
  const jobAnd = input.jobId ? "and mc.job_id = $1" : "";
  const limitParameter = input.jobId ? "$2" : "$1";
  const countValues = input.jobId ? [input.jobId] : [];
  const recentValues = input.jobId ? [input.jobId, limit] : [limit];
  const providerResumeSql = `
    j.status not in ('succeeded', 'failed', 'cancelled')
    and coalesce(mc.request_reference ->> 'runner', '') = 'provider-direct'
    and coalesce(mc.request_reference ->> 'kind', '') = 'video'
    and nullif(btrim(mc.request_reference ->> 'providerTaskId'), '') is not null`;
  const [counts, recent] = await Promise.all([
    pool.query(
      `select
         count(*) filter (where mc.status = 'started')::int as started,
         count(*) filter (
           where mc.status = 'started' and mc.lease_expires_at > now()
         )::int as active,
         count(*) filter (
           where mc.status = 'started' and (mc.lease_expires_at is null or mc.lease_expires_at <= now())
         )::int as expired_started,
         count(*) filter (
           where mc.status = 'started' and mc.lease_expires_at is null
         )::int as missing_lease,
         count(*) filter (
           where mc.status = 'started'
             and (mc.lease_expires_at is null or mc.lease_expires_at <= now())
             and ${providerResumeSql}
         )::int as provider_resume_available,
         count(*) filter (
           where (
             mc.status = 'started'
             and (mc.lease_expires_at is null or mc.lease_expires_at <= now())
             and not (${providerResumeSql})
           ) or (
             mc.status = 'failed_unknown_outcome'
             and mc.lease_recovery_status = 'reconciliation_required'
           )
         )::int as reconciliation_required
       from agent.model_calls mc
       join agent.jobs j on j.id = mc.job_id
       ${jobWhere}`,
      countValues
    ),
    pool.query(
      `select mc.*, j.status as job_status
       from agent.model_calls mc
       join agent.jobs j on j.id = mc.job_id
       where ((
           mc.status = 'started'
           and (mc.lease_expires_at is null or mc.lease_expires_at <= now())
         ) or mc.lease_recovery_status = 'reconciliation_required')
         ${jobAnd}
       order by coalesce(mc.lease_recovery_checked_at, mc.lease_expires_at, mc.updated_at) desc
       limit ${limitParameter}`,
      recentValues
    )
  ]);
  const row = counts.rows[0] ?? {};
  return {
    checkedAt,
    started: Number(row.started ?? 0),
    active: Number(row.active ?? 0),
    expiredStarted: Number(row.expired_started ?? 0),
    missingLease: Number(row.missing_lease ?? 0),
    providerResumeAvailable: Number(row.provider_resume_available ?? 0),
    reconciliationRequired: Number(row.reconciliation_required ?? 0),
    recent: recent.rows.map((entry) => toLeaseEntry(entry, checkedAt))
  };
}

type ProcessedLease = {
  modelCallId: string;
  idempotencyKey: string;
  jobId: string;
  stageId: string | null;
  actionType: string;
  agentId: string;
  classification: "provider_resume_available" | "reconciliation_required";
  providerTaskId: string | null;
};

export async function scanExpiredModelCallLeases(input: {
  limit?: number;
  jobId?: string;
} = {}) {
  const limit = normalizeLimit(input.limit);
  const checkedAt = new Date().toISOString();
  const candidates = await pool.query(
    `select mc.id, mc.idempotency_key, mc.job_id
     from agent.model_calls mc
     join agent.jobs j on j.id = mc.job_id
     where mc.status = 'started'
       and (mc.lease_expires_at is null or mc.lease_expires_at <= now())
       and ($2::text is null or mc.job_id = $2)
       and (
         mc.lease_recovery_status is distinct from 'provider_resume_available'
         or j.status in ('succeeded', 'failed', 'cancelled')
       )
     order by coalesce(mc.lease_expires_at, mc.updated_at) asc, mc.id asc
     limit $1`,
    [limit, input.jobId ?? null]
  );
  const client = await pool.connect();
  const processed: ProcessedLease[] = [];
  try {
    for (const candidate of candidates.rows) {
      await client.query("begin");
      let transactionOpen = true;
      try {
        const lock = await client.query(
          `select pg_try_advisory_xact_lock(hashtext($1)) as acquired`,
          [`honeycomb.model-call-lease.v1:${candidate.idempotency_key}`]
        );
        if (!lock.rows[0]?.acquired) {
          await client.query("rollback");
          transactionOpen = false;
          continue;
        }

        // Match execution/cancellation lock order: job first, then model call.
        const jobResult = await client.query(
          `select status from agent.jobs where id = $1 for update`,
          [candidate.job_id]
        );
        const current = await client.query(
          `select *
           from agent.model_calls
           where id = $1
             and status = 'started'
             and (lease_expires_at is null or lease_expires_at <= now())
           for update`,
          [candidate.id]
        );
        const row = current.rows[0];
        const jobStatus = jobResult.rows[0]?.status;
        if (
          !row ||
          !jobStatus ||
          (
            row.lease_recovery_status === "provider_resume_available" &&
            !TERMINAL_JOB_STATUSES.has(jobStatus)
          )
        ) {
          await client.query("rollback");
          transactionOpen = false;
          continue;
        }

        const requestReference = parseModelCallRequestReference(row.request_reference);
        const classified = TERMINAL_JOB_STATUSES.has(jobStatus)
          ? "reconciliation_required"
          : classifyModelCallLeaseRecovery({
              status: row.status,
              leaseExpiresAt: iso(row.lease_expires_at),
              now: checkedAt,
              requestReference
            });
        const classification = classified === "provider_resume_available"
          ? "provider_resume_available"
          : "reconciliation_required";
        const recoveryPayload = {
          classification,
          checkedAt,
          previousLeaseExpiresAt: iso(row.lease_expires_at),
          providerTaskId: requestReference?.providerTaskId ?? null
        };

        if (classification === "provider_resume_available") {
          await client.query(
            `update agent.model_calls
             set claim_token = null,
                 lease_recovery_status = 'provider_resume_available',
                 lease_recovery_checked_at = now(),
                 response_payload = coalesce(response_payload, '{}'::jsonb)
                   || jsonb_build_object('leaseRecovery', $2::jsonb),
                 updated_at = now()
             where id = $1 and status = 'started'`,
            [row.id, JSON.stringify(recoveryPayload)]
          );
          await client.query(
            `update agent.jobs
             set heartbeat_status = 'stalled',
                 heartbeat_source = 'model_call.lease_scan',
                 heartbeat_note = 'provider_video_resume_available',
                 stalled_at = coalesce(stalled_at, now()),
                 updated_at = now()
             where id = $1 and status = any($2::text[])`,
            [row.job_id, ACTIVE_JOB_STATUSES]
          );
        } else {
          await client.query(
            `update agent.model_calls
             set status = 'failed_unknown_outcome',
                 error = 'model_call_lease_expired_outcome_unknown',
                 claim_token = null,
                 lease_expires_at = null,
                 lease_recovery_status = 'reconciliation_required',
                 lease_recovery_checked_at = now(),
                 response_payload = coalesce(response_payload, '{}'::jsonb)
                   || jsonb_build_object('leaseRecovery', $2::jsonb),
                 updated_at = now()
             where id = $1 and status = 'started'`,
            [row.id, JSON.stringify(recoveryPayload)]
          );
          await client.query(
            `update agent.jobs
             set status = 'waiting_for_human',
                 heartbeat_at = now(),
                 heartbeat_status = 'paused',
                 heartbeat_source = 'model_call.lease_scan',
                 heartbeat_note = 'model_call_reconciliation_required',
                 stalled_at = null,
                 updated_at = now()
             where id = $1
               and status not in ('succeeded', 'failed', 'cancelled')`,
            [row.job_id]
          );
        }

        await client.query("commit");
        transactionOpen = false;
        processed.push({
          modelCallId: row.id,
          idempotencyKey: row.idempotency_key,
          jobId: row.job_id,
          stageId: row.stage_id ?? null,
          actionType: row.action_type,
          agentId: row.agent_id,
          classification,
          providerTaskId: requestReference?.providerTaskId ?? null
        });
      } catch (error) {
        if (transactionOpen) {
          await client.query("rollback").catch(() => undefined);
        }
        throw error;
      }
    }
  } finally {
    client.release();
  }

  const eventErrors: string[] = [];
  for (const entry of processed) {
    await appendJobEvent(
      entry.jobId,
      entry.classification === "provider_resume_available"
        ? "model_call.lease_expired_provider_resume_available"
        : "model_call.lease_expired_reconciliation_required",
      {
        modelCallId: entry.modelCallId,
        idempotencyKey: entry.idempotencyKey,
        actionType: entry.actionType,
        agentId: entry.agentId,
        providerTaskId: entry.providerTaskId,
        checkedAt
      },
      { actor: "lease-monitor", stageId: entry.stageId }
    ).catch((error) => {
      eventErrors.push(error instanceof Error ? error.message : String(error));
    });
  }

  const pendingSpend = await pool.query(
    `select idempotency_key
     from agent.model_calls
     where status = 'failed_unknown_outcome'
       and lease_recovery_status = 'reconciliation_required'
       and ($2::text is null or job_id = $2)
     order by lease_recovery_checked_at asc nulls first
     limit $1`,
    [limit, input.jobId ?? null]
  );
  let spendReconciled = 0;
  const spendErrors: string[] = [];
  for (const row of pendingSpend.rows) {
    try {
      await markModelCallSpendOutcomeUnknown({
        idempotencyKey: row.idempotency_key,
        note: "model_call_lease_expired_outcome_unknown"
      });
      spendReconciled += 1;
    } catch (error) {
      spendErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    checkedAt,
    scanned: processed.length,
    providerResumeAvailable: processed.filter(
      (entry) => entry.classification === "provider_resume_available"
    ).length,
    reconciliationRequired: processed.filter(
      (entry) => entry.classification === "reconciliation_required"
    ).length,
    spendReconciled,
    errors: [...eventErrors, ...spendErrors],
    processed,
    summary: await getModelCallLeaseSummary({
      limit: Math.min(limit, 100),
      jobId: input.jobId
    })
  };
}
