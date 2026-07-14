import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  JobSpendBudget,
  ModelCallSpendStatus,
  SpendBudgetBlockingScope
} from "../../shared/src/types";
import {
  emptyJobSpendBudget,
  evaluateSpendReservation,
  optionalUsd,
  parseJobSpendBudget,
  resolveSpendLimitPolicy,
  roundUsd
} from "../../shared/src/spend-policy";
import {
  getProviderSpendEstimate,
  settleProviderSpendUsd,
  type ProviderSpendPricingBasis,
  type TokenUsageForPricing
} from "./pricing-policy";
import { pool } from "./pool";

const COMMITTED_SQL = `case
  when status in ('reserved', 'outcome_unknown') then reserved_usd
  when status in ('settled', 'settled_estimate') then coalesce(actual_usd, reserved_usd)
  else 0
end`;

export type ModelCallSpendRecord = {
  id: string;
  reservationKey: string;
  idempotencyKey: string;
  jobId: string | null;
  stageId: string | null;
  requesterId: string | null;
  providerId: string;
  model: string | null;
  agentId: string;
  actionType: string;
  routeIndex: number;
  routeAttemptNo: number;
  status: ModelCallSpendStatus;
  reservedUsd: number;
  actualUsd: number | null;
  currency: "USD";
  pricingSource: string | null;
  reservationBasis: ProviderSpendPricingBasis | null;
  usage: TokenUsageForPricing | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  releasedAt: string | null;
};

export type ModelCallSpendReservationResult = {
  enabled: boolean;
  allowed: boolean;
  reused: boolean;
  blockingScope: SpendBudgetBlockingScope | null;
  reason: string | null;
  reservationUsd: number | null;
  record: ModelCallSpendRecord | null;
  budget: JobSpendBudget;
};

export type StandaloneModelSpendReservationResult = {
  enabled: boolean;
  allowed: boolean;
  reused: boolean;
  blockingScope: SpendBudgetBlockingScope | null;
  reason: string | null;
  reservationUsd: number | null;
  record: ModelCallSpendRecord | null;
};

function toIso(value: unknown) {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: string | null | undefined) {
  return value?.replace(/\u0000/g, "").slice(0, 1_000) ?? null;
}

function pricingBasis(value: unknown): ProviderSpendPricingBasis | null {
  const record = recordValue(value);
  if (
    !record ||
    !["fixed_request", "request_cap", "token_bound"].includes(String(record.billing)) ||
    optionalUsd(record.reservationUsd) === null ||
    typeof record.source !== "string"
  ) {
    return null;
  }
  return {
    billing: record.billing as ProviderSpendPricingBasis["billing"],
    reservationUsd: optionalUsd(record.reservationUsd)!,
    perRequestUsd: optionalUsd(record.perRequestUsd),
    inputPerMillionUsd: optionalUsd(record.inputPerMillionUsd),
    outputPerMillionUsd: optionalUsd(record.outputPerMillionUsd),
    inputTokenCeiling: optionalUsd(record.inputTokenCeiling),
    outputTokenCeiling: optionalUsd(record.outputTokenCeiling),
    source: record.source
  };
}

function tokenUsage(value: unknown): TokenUsageForPricing | null {
  const record = recordValue(value);
  const promptTokens = Number(record?.promptTokens);
  const completionTokens = Number(record?.completionTokens);
  return Number.isFinite(promptTokens) && promptTokens >= 0 &&
    Number.isFinite(completionTokens) && completionTokens >= 0
    ? { promptTokens: Math.trunc(promptTokens), completionTokens: Math.trunc(completionTokens) }
    : null;
}

function toSpendRecord(row: any): ModelCallSpendRecord {
  return {
    id: row.id,
    reservationKey: row.reservation_key,
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id ?? null,
    stageId: row.stage_id ?? null,
    requesterId: row.requester_id === "__anonymous__" ? null : row.requester_id ?? null,
    providerId: row.provider_id,
    model: row.model ?? null,
    agentId: row.agent_id,
    actionType: row.action_type,
    routeIndex: Number(row.route_index),
    routeAttemptNo: Number(row.route_attempt_no),
    status: row.status,
    reservedUsd: Number(row.reserved_usd ?? 0),
    actualUsd: row.actual_usd === null ? null : Number(row.actual_usd),
    currency: "USD",
    pricingSource: row.pricing_source ?? null,
    reservationBasis: pricingBasis(row.reservation_basis),
    usage: tokenUsage(row.usage),
    note: row.note ?? null,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
    settledAt: toIso(row.settled_at),
    releasedAt: toIso(row.released_at)
  };
}

function utcDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function jobTotals(client: PoolClient, jobId: string) {
  const result = await client.query(
    `select
       coalesce(sum(actual_usd) filter (where status in ('settled', 'settled_estimate')), 0) as settled_usd,
       coalesce(sum(reserved_usd) filter (where status in ('reserved', 'outcome_unknown')), 0) as reserved_usd,
       coalesce(sum(${COMMITTED_SQL}), 0) as committed_usd
     from agent.model_call_spend
     where job_id = $1`,
    [jobId]
  );
  return {
    settledUsd: roundUsd(Number(result.rows[0]?.settled_usd ?? 0)),
    reservedUsd: roundUsd(Number(result.rows[0]?.reserved_usd ?? 0)),
    committedUsd: roundUsd(Number(result.rows[0]?.committed_usd ?? 0))
  };
}

async function persistBudgetSnapshot(
  client: PoolClient,
  input: {
    jobId: string;
    maxCostUsd: number | null;
    previous?: unknown;
    enabled?: boolean;
    blocked?: boolean;
    blockingScope?: SpendBudgetBlockingScope | null;
    blockingReason?: string | null;
    userDailyLimitUsd?: number | null;
    userDailyCommittedUsd?: number | null;
    providerId?: string | null;
    providerDailyLimitUsd?: number | null;
    providerDailyCommittedUsd?: number | null;
  }
) {
  const totals = await jobTotals(client, input.jobId);
  const previous = parseJobSpendBudget(input.previous, input.maxCostUsd);
  const maxCostUsd = input.maxCostUsd ?? previous.maxCostUsd;
  const userDailyLimitUsd = input.userDailyLimitUsd === undefined
    ? previous.userDailyLimitUsd
    : input.userDailyLimitUsd;
  const userDailyCommittedUsd = input.userDailyCommittedUsd === undefined
    ? previous.userDailyCommittedUsd
    : input.userDailyCommittedUsd;
  const providerDailyLimitUsd = input.providerDailyLimitUsd === undefined
    ? previous.providerDailyLimitUsd
    : input.providerDailyLimitUsd;
  const providerDailyCommittedUsd = input.providerDailyCommittedUsd === undefined
    ? previous.providerDailyCommittedUsd
    : input.providerDailyCommittedUsd;
  const exceededScope: SpendBudgetBlockingScope | null =
    maxCostUsd !== null && totals.committedUsd > maxCostUsd
      ? "job"
      : userDailyLimitUsd !== null && userDailyCommittedUsd !== null &&
          userDailyCommittedUsd > userDailyLimitUsd
        ? "user_daily"
        : providerDailyLimitUsd !== null && providerDailyCommittedUsd !== null &&
            providerDailyCommittedUsd > providerDailyLimitUsd
          ? "provider_daily"
          : null;
  const snapshot: JobSpendBudget = {
    version: "honeycomb.job-spend-budget.v1",
    enabled: input.enabled ?? previous.enabled,
    currency: "USD",
    maxCostUsd,
    ...totals,
    remainingUsd: maxCostUsd === null ? null : roundUsd(Math.max(0, maxCostUsd - totals.committedUsd)),
    blocked: exceededScope !== null || (input.blocked ?? previous.blocked),
    blockingScope: exceededScope ?? (input.blockingScope === undefined
      ? previous.blockingScope
      : input.blockingScope),
    blockingReason: exceededScope
      ? `${exceededScope}_spend_limit_exceeded_after_settlement`
      : input.blockingReason === undefined
        ? previous.blockingReason
        : input.blockingReason,
    userDailyLimitUsd,
    userDailyCommittedUsd,
    providerId: input.providerId === undefined ? previous.providerId : input.providerId,
    providerDailyLimitUsd,
    providerDailyCommittedUsd,
    updatedAt: new Date().toISOString()
  };
  await client.query(
    `update agent.jobs set spend_budget = $2::jsonb, updated_at = now() where id = $1`,
    [input.jobId, JSON.stringify(snapshot)]
  );
  return snapshot;
}

async function committedBeforeReservation(
  client: PoolClient,
  input: {
    reservationKey: string;
    jobId: string;
    requesterId: string;
    providerId: string;
    dayStart: Date;
  }
) {
  const result = await client.query(
    `select
       coalesce(sum(${COMMITTED_SQL}) filter (where job_id = $1), 0) as job_usd,
       coalesce(sum(${COMMITTED_SQL}) filter (
         where requester_id = $2 and created_at >= $5::timestamptz
       ), 0) as user_daily_usd,
       coalesce(sum(${COMMITTED_SQL}) filter (
         where provider_id = $3 and created_at >= $5::timestamptz
       ), 0) as provider_daily_usd
     from agent.model_call_spend
     where reservation_key <> $4`,
    [input.jobId, input.requesterId, input.providerId, input.reservationKey, input.dayStart.toISOString()]
  );
  return {
    jobUsd: roundUsd(Number(result.rows[0]?.job_usd ?? 0)),
    userDailyUsd: roundUsd(Number(result.rows[0]?.user_daily_usd ?? 0)),
    providerDailyUsd: roundUsd(Number(result.rows[0]?.provider_daily_usd ?? 0))
  };
}

async function dailyCommitments(
  client: PoolClient,
  input: { requesterId: string; providerId: string; dayStart?: Date }
) {
  const result = await client.query(
    `select
       coalesce(sum(${COMMITTED_SQL}) filter (where requester_id = $1), 0) as user_daily_usd,
       coalesce(sum(${COMMITTED_SQL}) filter (where provider_id = $2), 0) as provider_daily_usd
     from agent.model_call_spend
     where created_at >= $3::timestamptz`,
    [input.requesterId, input.providerId, utcDayStart(input.dayStart).toISOString()]
  );
  return {
    userDailyUsd: roundUsd(Number(result.rows[0]?.user_daily_usd ?? 0)),
    providerDailyUsd: roundUsd(Number(result.rows[0]?.provider_daily_usd ?? 0))
  };
}

export async function reserveModelCallSpend(input: {
  reservationKey: string;
  idempotencyKey: string;
  jobId: string;
  stageId?: string | null;
  providerId: string;
  model?: string | null;
  agentId: string;
  actionType: string;
  routeIndex: number;
  routeAttemptNo: number;
  kind: "chat" | "image" | "video" | "openclaw";
  inputTokenCeiling?: number | null;
  outputTokenCeiling?: number | null;
  now?: Date;
}): Promise<ModelCallSpendReservationResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('agent.model_call_spend_budget_v1'))`);
    const jobResult = await client.query(
      `select requester_id, max_cost_usd, spend_budget from agent.jobs where id = $1 for update`,
      [input.jobId]
    );
    if (!jobResult.rows[0]) {
      throw new Error(`Job not found: ${input.jobId}`);
    }
    const providerResult = await client.query(
      `select metadata from agent.model_providers where id = $1`,
      [input.providerId]
    );
    const providerMetadata = recordValue(providerResult.rows[0]?.metadata) ?? {};
    const maxCostUsd = optionalUsd(jobResult.rows[0].max_cost_usd);
    const policy = resolveSpendLimitPolicy({
      jobLimitUsd: maxCostUsd,
      providerMetadata
    });
    const previousBudget = jobResult.rows[0].spend_budget;
    const requesterId = jobResult.rows[0].requester_id?.trim() || "__anonymous__";
    if (!policy.enabled) {
      await client.query(
        `update agent.model_call_spend
         set status = 'released', actual_usd = 0,
             note = 'spend_limits_disabled_before_dispatch',
             released_at = now(), updated_at = now()
         where reservation_key = $1 and status = 'reserved'`,
        [input.reservationKey]
      );
      const budget = await persistBudgetSnapshot(client, {
        jobId: input.jobId,
        maxCostUsd,
        previous: previousBudget,
        enabled: false,
        blocked: false,
        blockingScope: null,
        blockingReason: null
      });
      await client.query("commit");
      return {
        enabled: false,
        allowed: true,
        reused: false,
        blockingScope: null,
        reason: null,
        reservationUsd: null,
        record: null,
        budget
      };
    }

    const existingResult = await client.query(
      `select * from agent.model_call_spend where reservation_key = $1 for update`,
      [input.reservationKey]
    );
    const existing = existingResult.rows[0] ? toSpendRecord(existingResult.rows[0]) : null;
    if (existing?.status === "reserved") {
      const commitments = await committedBeforeReservation(client, {
        reservationKey: input.reservationKey,
        jobId: input.jobId,
        requesterId,
        providerId: input.providerId,
        dayStart: utcDayStart(input.now)
      });
      const decision = evaluateSpendReservation({
        policy,
        commitments,
        reservationUsd: existing.reservedUsd
      });
      if (!decision.allowed) {
        const blockedResult = await client.query(
          `update agent.model_call_spend
           set status = 'blocked', actual_usd = null, note = $2,
               released_at = null, updated_at = now()
           where id = $1 returning *`,
          [existing.id, decision.reason]
        );
        const budget = await persistBudgetSnapshot(client, {
          jobId: input.jobId,
          maxCostUsd: policy.jobLimitUsd,
          previous: previousBudget,
          enabled: true,
          blocked: true,
          blockingScope: decision.blockingScope,
          blockingReason: decision.reason,
          userDailyLimitUsd: policy.userDailyLimitUsd,
          userDailyCommittedUsd: commitments.userDailyUsd,
          providerId: input.providerId,
          providerDailyLimitUsd: policy.providerDailyLimitUsd,
          providerDailyCommittedUsd: commitments.providerDailyUsd
        });
        await client.query("commit");
        return {
          enabled: true,
          allowed: false,
          reused: true,
          blockingScope: decision.blockingScope,
          reason: decision.reason,
          reservationUsd: existing.reservedUsd,
          record: toSpendRecord(blockedResult.rows[0]),
          budget
        };
      }
      const reusedResult = await client.query(
        `update agent.model_call_spend
         set created_at = now(), updated_at = now()
         where id = $1 returning *`,
        [existing.id]
      );
      const reusedRecord = toSpendRecord(reusedResult.rows[0]);
      const budget = await persistBudgetSnapshot(client, {
        jobId: input.jobId,
        maxCostUsd: policy.jobLimitUsd,
        previous: previousBudget,
        enabled: true,
        blocked: false,
        blockingScope: null,
        blockingReason: null,
        userDailyLimitUsd: policy.userDailyLimitUsd,
        userDailyCommittedUsd: decision.projected.userDailyUsd,
        providerId: input.providerId,
        providerDailyLimitUsd: policy.providerDailyLimitUsd,
        providerDailyCommittedUsd: decision.projected.providerDailyUsd
      });
      await client.query("commit");
      return {
        enabled: true,
        allowed: true,
        reused: true,
        blockingScope: null,
        reason: null,
        reservationUsd: existing.reservedUsd,
        record: reusedRecord,
        budget
      };
    }
    if (existing?.status === "outcome_unknown" || existing?.status === "settled" || existing?.status === "settled_estimate") {
      const budget = await persistBudgetSnapshot(client, {
        jobId: input.jobId,
        maxCostUsd: policy.jobLimitUsd,
        previous: previousBudget,
        enabled: true,
        blocked: true,
        blockingScope: "pricing",
        blockingReason: "spend_reservation_already_consumed_or_unknown"
      });
      await client.query("commit");
      return {
        enabled: true,
        allowed: false,
        reused: true,
        blockingScope: "pricing",
        reason: "spend_reservation_already_consumed_or_unknown",
        reservationUsd: existing.reservedUsd,
        record: existing,
        budget
      };
    }

    const estimate = getProviderSpendEstimate({
      metadata: providerMetadata,
      model: input.model,
      kind: input.kind,
      inputTokenCeiling: input.inputTokenCeiling,
      outputTokenCeiling: input.outputTokenCeiling
    });
    const commitments = await committedBeforeReservation(client, {
      reservationKey: input.reservationKey,
      jobId: input.jobId,
      requesterId,
      providerId: input.providerId,
      dayStart: utcDayStart(input.now)
    });
    const decision = evaluateSpendReservation({
      policy,
      commitments,
      reservationUsd: estimate?.amountUsd ?? null
    });
    const status: ModelCallSpendStatus = decision.allowed ? "reserved" : "blocked";
    const upsertResult = await client.query(
      `insert into agent.model_call_spend (
        id, reservation_key, idempotency_key, job_id, stage_id, requester_id,
        provider_id, model, agent_id, action_type, route_index, route_attempt_no,
        status, reserved_usd, pricing_source, reservation_basis, note
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16::jsonb, $17
      )
      on conflict (reservation_key) do update set
        status = excluded.status,
        reserved_usd = excluded.reserved_usd,
        pricing_source = excluded.pricing_source,
        reservation_basis = excluded.reservation_basis,
        note = excluded.note,
        actual_usd = null,
        usage = '{}'::jsonb,
        settled_at = null,
        released_at = null,
        created_at = now(),
        updated_at = now()
      returning *`,
      [
        `MCS-${randomUUID().slice(0, 12).toUpperCase()}`,
        input.reservationKey,
        input.idempotencyKey,
        input.jobId,
        input.stageId ?? null,
        requesterId,
        input.providerId,
        input.model ?? null,
        input.agentId,
        input.actionType,
        input.routeIndex,
        input.routeAttemptNo,
        status,
        estimate?.amountUsd ?? 0,
        estimate?.source ?? null,
        JSON.stringify(estimate?.basis ?? {}),
        safeText(decision.reason)
      ]
    );
    const budget = await persistBudgetSnapshot(client, {
      jobId: input.jobId,
      maxCostUsd: policy.jobLimitUsd,
      previous: previousBudget,
      enabled: true,
      blocked: !decision.allowed,
      blockingScope: decision.blockingScope,
      blockingReason: decision.reason,
      userDailyLimitUsd: policy.userDailyLimitUsd,
      userDailyCommittedUsd: decision.allowed
        ? decision.projected.userDailyUsd
        : commitments.userDailyUsd,
      providerId: input.providerId,
      providerDailyLimitUsd: policy.providerDailyLimitUsd,
      providerDailyCommittedUsd: decision.allowed
        ? decision.projected.providerDailyUsd
        : commitments.providerDailyUsd
    });
    await client.query("commit");
    return {
      enabled: true,
      allowed: decision.allowed,
      reused: false,
      blockingScope: decision.blockingScope,
      reason: decision.reason,
      reservationUsd: estimate?.amountUsd ?? null,
      record: toSpendRecord(upsertResult.rows[0]),
      budget
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reserveStandaloneModelSpend(input: {
  reservationKey: string;
  requesterId?: string | null;
  providerId: string;
  model?: string | null;
  agentId: string;
  actionType: string;
  kind: "chat" | "image" | "video" | "openclaw";
  inputTokenCeiling?: number | null;
  outputTokenCeiling?: number | null;
  now?: Date;
}): Promise<StandaloneModelSpendReservationResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('agent.model_call_spend_budget_v1'))`);
    const providerResult = await client.query(
      `select metadata from agent.model_providers where id = $1`,
      [input.providerId]
    );
    const providerMetadata = recordValue(providerResult.rows[0]?.metadata) ?? {};
    const policy = resolveSpendLimitPolicy({
      providerMetadata,
      includeDefaultJobLimit: false
    });
    if (!policy.enabled) {
      await client.query(
        `update agent.model_call_spend
         set status = 'released', actual_usd = 0,
             note = 'spend_limits_disabled_before_dispatch',
             released_at = now(), updated_at = now()
         where reservation_key = $1 and status = 'reserved'`,
        [input.reservationKey]
      );
      await client.query("commit");
      return {
        enabled: false,
        allowed: true,
        reused: false,
        blockingScope: null,
        reason: null,
        reservationUsd: null,
        record: null
      };
    }

    const requesterId = input.requesterId?.trim() || "__anonymous__";
    const existingResult = await client.query(
      `select * from agent.model_call_spend where reservation_key = $1 for update`,
      [input.reservationKey]
    );
    const existing = existingResult.rows[0] ? toSpendRecord(existingResult.rows[0]) : null;
    const commitments = await committedBeforeReservation(client, {
      reservationKey: input.reservationKey,
      jobId: "__standalone__",
      requesterId,
      providerId: input.providerId,
      dayStart: utcDayStart(input.now)
    });
    if (existing?.status === "reserved") {
      const decision = evaluateSpendReservation({
        policy,
        commitments,
        reservationUsd: existing.reservedUsd
      });
      if (decision.allowed) {
        const reusedResult = await client.query(
          `update agent.model_call_spend
           set created_at = now(), updated_at = now()
           where id = $1 returning *`,
          [existing.id]
        );
        await client.query("commit");
        return {
          enabled: true,
          allowed: true,
          reused: true,
          blockingScope: null,
          reason: null,
          reservationUsd: existing.reservedUsd,
          record: toSpendRecord(reusedResult.rows[0])
        };
      }
      const blockedResult = await client.query(
        `update agent.model_call_spend
         set status = 'blocked', actual_usd = null, note = $2,
             released_at = null, updated_at = now()
         where id = $1 returning *`,
        [existing.id, decision.reason]
      );
      await client.query("commit");
      return {
        enabled: true,
        allowed: false,
        reused: true,
        blockingScope: decision.blockingScope,
        reason: decision.reason,
        reservationUsd: existing.reservedUsd,
        record: toSpendRecord(blockedResult.rows[0])
      };
    }
    if (existing?.status === "outcome_unknown" || existing?.status === "settled" || existing?.status === "settled_estimate") {
      await client.query("commit");
      return {
        enabled: true,
        allowed: false,
        reused: true,
        blockingScope: "pricing",
        reason: "spend_reservation_already_consumed_or_unknown",
        reservationUsd: existing.reservedUsd,
        record: existing
      };
    }

    const estimate = getProviderSpendEstimate({
      metadata: providerMetadata,
      model: input.model,
      kind: input.kind,
      inputTokenCeiling: input.inputTokenCeiling,
      outputTokenCeiling: input.outputTokenCeiling
    });
    const decision = evaluateSpendReservation({
      policy,
      commitments,
      reservationUsd: estimate?.amountUsd ?? null
    });
    const status: ModelCallSpendStatus = decision.allowed ? "reserved" : "blocked";
    const result = await client.query(
      `insert into agent.model_call_spend (
        id, reservation_key, idempotency_key, job_id, stage_id, requester_id,
        provider_id, model, agent_id, action_type, route_index, route_attempt_no,
        status, reserved_usd, pricing_source, reservation_basis, note
      ) values (
        $1, $2, $2, null, null, $3, $4, $5, $6, $7, 0, 1,
        $8, $9, $10, $11::jsonb, $12
      )
      on conflict (reservation_key) do update set
        status = excluded.status,
        reserved_usd = excluded.reserved_usd,
        pricing_source = excluded.pricing_source,
        reservation_basis = excluded.reservation_basis,
        note = excluded.note,
        actual_usd = null,
        usage = '{}'::jsonb,
        settled_at = null,
        released_at = null,
        created_at = now(),
        updated_at = now()
      returning *`,
      [
        `MCS-${randomUUID().slice(0, 12).toUpperCase()}`,
        input.reservationKey,
        requesterId,
        input.providerId,
        input.model ?? null,
        input.agentId,
        input.actionType,
        status,
        estimate?.amountUsd ?? 0,
        estimate?.source ?? null,
        JSON.stringify(estimate?.basis ?? {}),
        safeText(decision.reason)
      ]
    );
    await client.query("commit");
    return {
      enabled: true,
      allowed: decision.allowed,
      reused: false,
      blockingScope: decision.blockingScope,
      reason: decision.reason,
      reservationUsd: estimate?.amountUsd ?? null,
      record: toSpendRecord(result.rows[0])
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function claimModelCallSpendDispatch(input: {
  reservationKey: string;
  note?: string | null;
}): Promise<ModelCallSpendRecord | null> {
  const result = await pool.query(
    `update agent.model_call_spend
     set status = 'outcome_unknown', note = $2, updated_at = now()
     where reservation_key = $1 and status = 'reserved'
     returning *`,
    [input.reservationKey, safeText(input.note) ?? "provider_dispatch_started"]
  );
  return result.rows[0] ? toSpendRecord(result.rows[0]) : null;
}

async function transitionSpend(input: {
  reservationKey?: string;
  idempotencyKey?: string;
  transition: "release" | "unknown" | "settle";
  usage?: TokenUsageForPricing | null;
  note?: string | null;
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('agent.model_call_spend_budget_v1'))`);
    const where = input.reservationKey ? "reservation_key = $1" : "idempotency_key = $1";
    const key = input.reservationKey ?? input.idempotencyKey;
    if (!key) {
      throw new Error("spend_transition_key_required");
    }
    const currentResult = await client.query(
      `select * from agent.model_call_spend
       where ${where} and status in ('reserved', 'outcome_unknown')
       order by created_at desc
       for update`,
      [key]
    );
    const changed: ModelCallSpendRecord[] = [];
    for (const row of currentResult.rows) {
      const current = toSpendRecord(row);
      let result;
      if (input.transition === "settle") {
        const basis = current.reservationBasis;
        const actualUsd = basis
          ? settleProviderSpendUsd(basis, input.usage)
          : current.reservedUsd;
        const settledStatus: ModelCallSpendStatus = input.usage || basis?.billing === "fixed_request"
          ? "settled"
          : "settled_estimate";
        result = await client.query(
          `update agent.model_call_spend
           set status = $2,
               actual_usd = $3,
               usage = $4::jsonb,
               note = $5,
               settled_at = now(),
               released_at = null,
               updated_at = now()
           where id = $1 returning *`,
          [row.id, settledStatus, actualUsd, JSON.stringify(input.usage ?? {}), safeText(input.note)]
        );
      } else if (input.transition === "unknown") {
        result = await client.query(
          `update agent.model_call_spend
           set status = 'outcome_unknown', note = $2, updated_at = now()
           where id = $1 returning *`,
          [row.id, safeText(input.note) ?? "provider_outcome_unknown"]
        );
      } else {
        result = await client.query(
          `update agent.model_call_spend
           set status = 'released', actual_usd = 0, note = $2,
               released_at = now(), updated_at = now()
           where id = $1 returning *`,
          [row.id, safeText(input.note) ?? "provider_request_not_charged"]
        );
      }
      changed.push(toSpendRecord(result.rows[0]));
    }
    const jobIds = [...new Set(changed
      .map((entry) => entry.jobId)
      .filter((jobId): jobId is string => Boolean(jobId)))];
    for (const jobId of jobIds) {
      const jobResult = await client.query(
        `select max_cost_usd, spend_budget from agent.jobs where id = $1 for update`,
        [jobId]
      );
      if (!jobResult.rows[0]) continue;
      const scopeEntry = changed.find((entry) => entry.jobId === jobId)!;
      const daily = await dailyCommitments(client, {
        requesterId: scopeEntry.requesterId ?? "__anonymous__",
        providerId: scopeEntry.providerId
      });
      await persistBudgetSnapshot(client, {
        jobId,
        maxCostUsd: optionalUsd(jobResult.rows[0].max_cost_usd),
        previous: jobResult.rows[0].spend_budget,
        blocked: false,
        blockingScope: null,
        blockingReason: null,
        userDailyCommittedUsd: daily.userDailyUsd,
        providerId: scopeEntry.providerId,
        providerDailyCommittedUsd: daily.providerDailyUsd
      });
    }
    await client.query("commit");
    return changed;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function releaseModelCallSpend(input: {
  reservationKey: string;
  note?: string | null;
}) {
  return transitionSpend({ ...input, transition: "release" });
}

export function releaseModelCallSpendByIdempotency(input: {
  idempotencyKey: string;
  note?: string | null;
}) {
  return transitionSpend({ ...input, transition: "release" });
}

export function markModelCallSpendOutcomeUnknown(input: {
  reservationKey?: string;
  idempotencyKey?: string;
  note?: string | null;
}) {
  return transitionSpend({ ...input, transition: "unknown" });
}

export function settleModelCallSpend(input: {
  reservationKey: string;
  usage?: TokenUsageForPricing | null;
  note?: string | null;
}) {
  return transitionSpend({ ...input, transition: "settle" });
}

export function settleModelCallSpendByIdempotency(input: {
  idempotencyKey: string;
  usage?: TokenUsageForPricing | null;
  note?: string | null;
}) {
  return transitionSpend({ ...input, transition: "settle" });
}

export async function listModelCallSpendForJob(jobId: string): Promise<ModelCallSpendRecord[]> {
  const result = await pool.query(
    `select * from agent.model_call_spend where job_id = $1 order by created_at, id`,
    [jobId]
  );
  return result.rows.map(toSpendRecord);
}

export async function getJobSpendBudget(jobId: string): Promise<JobSpendBudget | null> {
  const result = await pool.query(
    `select max_cost_usd, spend_budget from agent.jobs where id = $1`,
    [jobId]
  );
  if (!result.rows[0]) return null;
  const maxCostUsd = optionalUsd(result.rows[0].max_cost_usd);
  return parseJobSpendBudget(result.rows[0].spend_budget, maxCostUsd) ??
    emptyJobSpendBudget(maxCostUsd);
}
