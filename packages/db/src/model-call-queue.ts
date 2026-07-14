import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  evaluateModelCallConcurrency
} from "../../shared/src/model-concurrency";
import type {
  ModelCallConcurrencyLimits,
  ModelCallConcurrencyUsage,
  ModelCallQueueBlockingScope,
  TaskExecutionQueueState
} from "../../shared/src/types";
import { pool } from "./pool";

type QueueRow = {
  id: string;
  request_key: string;
  idempotency_key: string;
  job_id: string;
  stage_id: string | null;
  route_index: number;
  agent_id: string;
  provider_id: string;
  status: "queued" | "acquired" | "released" | "expired" | "cancelled";
  lease_owner_id: string | null;
  queued_at: Date;
  acquired_at: Date | null;
  released_at: Date | null;
  expires_at: Date | null;
  global_limit: number;
  provider_limit: number;
  agent_limit: number;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function activeUsage(
  client: PoolClient,
  providerId: string,
  agentId: string
): Promise<ModelCallConcurrencyUsage> {
  const result = await client.query(
    `select
       count(*)::int as global_active,
       count(*) filter (where provider_id = $1)::int as provider_active,
       count(*) filter (where agent_id = $2)::int as agent_active
     from agent.model_call_queue
     where status = 'acquired'
       and expires_at > now()`,
    [providerId, agentId]
  );
  return {
    global: Number(result.rows[0]?.global_active ?? 0),
    provider: Number(result.rows[0]?.provider_active ?? 0),
    agent: Number(result.rows[0]?.agent_active ?? 0)
  };
}

async function queuePositions(
  client: PoolClient,
  row: QueueRow
) {
  const result = await client.query(
    `select
       count(*)::int as global_position,
       count(*) filter (where provider_id = $3)::int as provider_position,
       count(*) filter (where agent_id = $4)::int as agent_position,
       count(*) filter (
         where id <> $1 and (provider_id = $3 or agent_id = $4)
       )::int as earlier_scope_conflicts
     from agent.model_call_queue
     where status = 'queued'
       and (queued_at < $2 or (queued_at = $2 and id <= $1))`,
    [row.id, row.queued_at, row.provider_id, row.agent_id]
  );
  return {
    global: Number(result.rows[0]?.global_position ?? 1),
    provider: Number(result.rows[0]?.provider_position ?? 1),
    agent: Number(result.rows[0]?.agent_position ?? 1),
    earlierScopeConflicts: Number(result.rows[0]?.earlier_scope_conflicts ?? 0)
  };
}

function queueState(input: {
  row: QueueRow;
  status: "queued" | "acquired";
  active: ModelCallConcurrencyUsage;
  blockingScopes: ModelCallQueueBlockingScope[];
  positions?: { global: number; provider: number; agent: number };
  retryAfterMs: number;
}): TaskExecutionQueueState {
  return {
    version: "honeycomb.model-call-queue.v1",
    status: input.status,
    requestKey: input.row.request_key,
    idempotencyKey: input.row.idempotency_key,
    routeIndex: input.row.route_index,
    agentId: input.row.agent_id,
    providerId: input.row.provider_id,
    queuedAt: toIso(input.row.queued_at)!,
    acquiredAt: input.status === "acquired" ? toIso(input.row.acquired_at) : null,
    leaseExpiresAt: toIso(input.row.expires_at),
    globalPosition: input.positions?.global ?? 0,
    providerPosition: input.positions?.provider ?? 0,
    agentPosition: input.positions?.agent ?? 0,
    limits: {
      global: input.row.global_limit,
      provider: input.row.provider_limit,
      agent: input.row.agent_limit
    },
    active: input.active,
    blockingScopes: input.blockingScopes,
    retryAfterMs: input.retryAfterMs
  };
}

export async function tryAcquireModelCallSlot(input: {
  requestKey: string;
  idempotencyKey: string;
  jobId: string;
  stageId?: string | null;
  routeIndex: number;
  agentId: string;
  providerId: string;
  ownerId: string;
  limits: ModelCallConcurrencyLimits;
  queueLeaseSeconds: number;
  leaseSeconds: number;
  retryAfterMs: number;
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `select pg_advisory_xact_lock(hashtext('honeycomb.model-call-queue.v1'))`
    );
    await client.query(
      `with expired as (
         update agent.model_call_queue
         set status = 'expired',
             released_at = now(),
             lease_owner_id = null,
             updated_at = now(),
             last_error = 'lease_expired'
         where status in ('queued', 'acquired')
           and expires_at <= now()
         returning job_id, request_key
       )
       update agent.jobs job
       set execution_queue = null,
           updated_at = now()
       from expired
       where job.id = expired.job_id
         and job.execution_queue ->> 'requestKey' = expired.request_key`
    );

    let currentResult = await client.query(
      `select * from agent.model_call_queue where request_key = $1 for update`,
      [input.requestKey]
    );
    let row = currentResult.rows[0] as QueueRow | undefined;

    if (!row) {
      currentResult = await client.query(
        `insert into agent.model_call_queue (
           id, request_key, idempotency_key, job_id, stage_id, route_index,
           agent_id, provider_id, status, lease_owner_id, expires_at,
           global_limit, provider_limit, agent_limit
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9,
           now() + make_interval(secs => $10), $11, $12, $13
         )
         returning *`,
        [
          `MQ-${randomUUID().slice(0, 12).toUpperCase()}`,
          input.requestKey,
          input.idempotencyKey,
          input.jobId,
          input.stageId ?? null,
          input.routeIndex,
          input.agentId,
          input.providerId,
          input.ownerId,
          Math.max(1, Math.floor(input.queueLeaseSeconds)),
          input.limits.global,
          input.limits.provider,
          input.limits.agent
        ]
      );
      row = currentResult.rows[0] as QueueRow;
    } else if (row.status === "acquired") {
      const usage = await activeUsage(client, row.provider_id, row.agent_id);
      if (row.lease_owner_id === input.ownerId) {
        await client.query("commit");
        return {
          acquired: true,
          state: queueState({
            row,
            status: "acquired",
            active: usage,
            blockingScopes: [],
            retryAfterMs: input.retryAfterMs
          })
        };
      }
      await client.query("commit");
      return {
        acquired: false,
        state: queueState({
          row,
          status: "queued",
          active: usage,
          blockingScopes: ["request_lease"],
          positions: { global: 1, provider: 1, agent: 1 },
          retryAfterMs: input.retryAfterMs
        })
      };
    } else if (
      row.status === "queued" &&
      row.lease_owner_id &&
      row.lease_owner_id !== input.ownerId
    ) {
      const usage = await activeUsage(client, row.provider_id, row.agent_id);
      const positions = await queuePositions(client, row);
      await client.query("commit");
      return {
        acquired: false,
        state: queueState({
          row,
          status: "queued",
          active: usage,
          blockingScopes: ["request_lease"],
          positions,
          retryAfterMs: input.retryAfterMs
        })
      };
    } else {
      const resetQueueTime = row.status !== "queued";
      currentResult = await client.query(
        `update agent.model_call_queue
         set idempotency_key = $2,
             job_id = $3,
             stage_id = $4,
             route_index = $5,
             agent_id = $6,
             provider_id = $7,
             status = 'queued',
             lease_owner_id = $12,
             acquired_at = null,
             released_at = null,
             expires_at = now() + make_interval(secs => $13),
             queued_at = case when $11 then now() else queued_at end,
             global_limit = $8,
             provider_limit = $9,
             agent_limit = $10,
             updated_at = now(),
             last_error = null
         where request_key = $1
         returning *`,
        [
          input.requestKey,
          input.idempotencyKey,
          input.jobId,
          input.stageId ?? null,
          input.routeIndex,
          input.agentId,
          input.providerId,
          input.limits.global,
          input.limits.provider,
          input.limits.agent,
          resetQueueTime,
          input.ownerId,
          Math.max(1, Math.floor(input.queueLeaseSeconds))
        ]
      );
      row = currentResult.rows[0] as QueueRow;
    }

    const usage = await activeUsage(client, row.provider_id, row.agent_id);
    const positions = await queuePositions(client, row);
    const decision = evaluateModelCallConcurrency({
      limits: input.limits,
      active: usage,
      hasEarlierScopeConflict: positions.earlierScopeConflicts > 0
    });

    if (decision.acquired) {
      const acquiredResult = await client.query(
        `update agent.model_call_queue
         set status = 'acquired',
             lease_owner_id = $2,
             acquired_at = now(),
             expires_at = now() + make_interval(secs => $3),
             updated_at = now()
         where request_key = $1
           and status = 'queued'
         returning *`,
        [input.requestKey, input.ownerId, Math.max(1, Math.floor(input.leaseSeconds))]
      );
      row = acquiredResult.rows[0] as QueueRow;
      const acquiredUsage = await activeUsage(client, row.provider_id, row.agent_id);
      await client.query("commit");
      return {
        acquired: true,
        state: queueState({
          row,
          status: "acquired",
          active: acquiredUsage,
          blockingScopes: [],
          retryAfterMs: input.retryAfterMs
        })
      };
    }

    await client.query("commit");
    return {
      acquired: false,
      state: queueState({
        row,
        status: "queued",
        active: usage,
        blockingScopes: decision.blockingScopes,
        positions,
        retryAfterMs: input.retryAfterMs
      })
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseModelCallSlot(input: {
  requestKey: string;
  ownerId: string;
  reason?: string | null;
}) {
  const result = await pool.query(
    `update agent.model_call_queue
     set status = 'released',
         released_at = now(),
         expires_at = null,
         lease_owner_id = null,
         updated_at = now(),
         last_error = $3
     where request_key = $1
       and lease_owner_id = $2
       and status = 'acquired'
     returning id`,
    [input.requestKey, input.ownerId, input.reason ?? null]
  );
  return result.rowCount === 1;
}

export async function cancelModelCallQueueRequest(input: {
  requestKey: string;
  ownerId: string;
  reason: string;
}) {
  const result = await pool.query(
    `update agent.model_call_queue
     set status = 'cancelled',
         released_at = now(),
         expires_at = null,
         lease_owner_id = null,
         updated_at = now(),
         last_error = $3
     where request_key = $1
       and lease_owner_id = $2
       and status = 'queued'
     returning id`,
    [input.requestKey, input.ownerId, input.reason]
  );
  return result.rowCount === 1;
}

export async function getModelCallQueueOverview(limit = 100) {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const [summaryResult, itemsResult] = await Promise.all([
    pool.query(
      `select
         count(*) filter (where status = 'queued' and expires_at > now())::int as queued,
         count(*) filter (where status = 'acquired' and expires_at > now())::int as acquired
       from agent.model_call_queue`
    ),
    pool.query(
      `select
         id,
         request_key,
         idempotency_key,
         job_id,
         stage_id,
         route_index,
         agent_id,
         provider_id,
         status,
         queued_at,
         acquired_at,
         expires_at,
         global_limit,
         provider_limit,
         agent_limit
       from agent.model_call_queue
       where status in ('queued', 'acquired')
         and expires_at > now()
       order by queued_at asc, id asc
       limit $1`,
      [boundedLimit]
    )
  ]);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      queued: Number(summaryResult.rows[0]?.queued ?? 0),
      acquired: Number(summaryResult.rows[0]?.acquired ?? 0)
    },
    items: itemsResult.rows.map((row) => ({
      id: row.id as string,
      requestKey: row.request_key as string,
      idempotencyKey: row.idempotency_key as string,
      jobId: row.job_id as string,
      stageId: row.stage_id as string | null,
      routeIndex: Number(row.route_index),
      agentId: row.agent_id as string,
      providerId: row.provider_id as string,
      status: row.status as "queued" | "acquired",
      queuedAt: toIso(row.queued_at)!,
      acquiredAt: toIso(row.acquired_at),
      expiresAt: toIso(row.expires_at)!,
      limits: {
        global: Number(row.global_limit),
        provider: Number(row.provider_limit),
        agent: Number(row.agent_limit)
      }
    }))
  };
}
