import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  RUNTIME_MAINTENANCE_ID,
  RUNTIME_MAINTENANCE_LOCK_KEY,
  RUNTIME_MAINTENANCE_VERSION,
  classifyRuntimeMaintenanceHealth,
  type RuntimeMaintenanceAttempt,
  type RuntimeMaintenanceComponentResult,
  type RuntimeMaintenanceConfig,
  type RuntimeMaintenanceOverview,
  type RuntimeMaintenanceRunResult,
  type RuntimeMaintenanceState,
  type RuntimeMaintenanceTrigger
} from "../../shared/src/runtime-maintenance";
import { scanStalledJobHeartbeats } from "./jobs";
import { scanExpiredModelCallLeases } from "./model-call-leases";
import { pool } from "./pool";

type ModelCallScan = (input: { limit?: number }) => Promise<{
  scanned: number;
  providerResumeAvailable: number;
  reconciliationRequired: number;
  spendReconciled: number;
  errors: string[];
  summary: { expiredStarted: number };
}>;

type HeartbeatScan = (input: { timeoutSeconds?: number; limit?: number }) => Promise<{
  scanned: number;
  summary: { staleCandidates: number; stalled: number };
}>;

export type RuntimeMaintenanceComponentDependencies = {
  scanModelCalls?: ModelCallScan;
  scanHeartbeats?: HeartbeatScan;
  now?: () => Date;
};

export type RuntimeMaintenanceRunDependencies = RuntimeMaintenanceComponentDependencies & {
  maintenanceId?: string;
  lockKey?: string;
  createRunId?: () => string;
};

function iso(value: unknown) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\u0000/g, "")
    .slice(0, 2000);
}

function uniqueErrors(errors: string[]) {
  return [...new Set(errors.map((error) => safeError(error)).filter(Boolean))];
}

function toRuntimeMaintenanceState(row: any): RuntimeMaintenanceState {
  return {
    maintenanceId: row.maintenance_id,
    status: row.status,
    ownerId: row.owner_id ?? null,
    runId: row.run_id ?? null,
    trigger: row.trigger ?? null,
    lastStartedAt: iso(row.last_started_at),
    lastCompletedAt: iso(row.last_completed_at),
    lastSucceededAt: iso(row.last_succeeded_at),
    nextRunAt: iso(row.next_run_at),
    lastError: row.last_error ?? null,
    lastResult: row.last_result && Object.keys(row.last_result).length > 0
      ? row.last_result as RuntimeMaintenanceRunResult
      : null,
    totalRuns: Number(row.total_runs ?? 0),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    updatedAt: iso(row.updated_at)!
  };
}

async function ensureRuntimeMaintenanceState(client: PoolClient, maintenanceId: string) {
  await client.query(
    `insert into agent.runtime_maintenance_state (maintenance_id)
     values ($1)
     on conflict (maintenance_id) do nothing`,
    [maintenanceId]
  );
}

async function readRuntimeMaintenanceState(client: PoolClient, maintenanceId: string) {
  await ensureRuntimeMaintenanceState(client, maintenanceId);
  const result = await client.query(
    `select * from agent.runtime_maintenance_state where maintenance_id = $1`,
    [maintenanceId]
  );
  return result.rows[0] ? toRuntimeMaintenanceState(result.rows[0]) : null;
}

export async function getRuntimeMaintenanceState(
  maintenanceId = RUNTIME_MAINTENANCE_ID
): Promise<RuntimeMaintenanceState | null> {
  const client = await pool.connect();
  try {
    return await readRuntimeMaintenanceState(client, maintenanceId);
  } finally {
    client.release();
  }
}

function failedComponent(error: unknown): RuntimeMaintenanceComponentResult {
  return {
    status: "failed",
    scanned: 0,
    details: {},
    errors: [safeError(error)]
  };
}

export async function executeRuntimeMaintenanceComponents(input: {
  runId: string;
  ownerId: string;
  trigger: RuntimeMaintenanceTrigger;
  config: RuntimeMaintenanceConfig;
  startedAt?: string;
  dependencies?: RuntimeMaintenanceComponentDependencies;
}): Promise<RuntimeMaintenanceRunResult> {
  const now = input.dependencies?.now ?? (() => new Date());
  const startedAt = input.startedAt ?? now().toISOString();
  const scanModelCalls = input.dependencies?.scanModelCalls ?? scanExpiredModelCallLeases;
  const scanHeartbeats = input.dependencies?.scanHeartbeats ?? scanStalledJobHeartbeats;

  let modelCalls: RuntimeMaintenanceComponentResult;
  try {
    const result = await scanModelCalls({ limit: input.config.modelCallLeaseScanLimit });
    const errors = uniqueErrors(result.errors);
    modelCalls = {
      status: errors.length > 0 ? "partial" : "succeeded",
      scanned: result.scanned,
      details: {
        providerResumeAvailable: result.providerResumeAvailable,
        reconciliationRequired: result.reconciliationRequired,
        spendReconciled: result.spendReconciled,
        remainingExpiredStarted: result.summary.expiredStarted
      },
      errors
    };
  } catch (error) {
    modelCalls = failedComponent(error);
  }

  let heartbeats: RuntimeMaintenanceComponentResult;
  try {
    const result = await scanHeartbeats({
      timeoutSeconds: input.config.heartbeatTimeoutSeconds,
      limit: input.config.heartbeatScanLimit
    });
    heartbeats = {
      status: "succeeded",
      scanned: result.scanned,
      details: {
        remainingStaleCandidates: result.summary.staleCandidates,
        totalStalled: result.summary.stalled
      },
      errors: []
    };
  } catch (error) {
    heartbeats = failedComponent(error);
  }

  const errors = uniqueErrors([...modelCalls.errors, ...heartbeats.errors]);
  const failedComponents = [modelCalls, heartbeats].filter((component) => component.status === "failed").length;
  const status = failedComponents === 2
    ? "failed" as const
    : modelCalls.status !== "succeeded" || heartbeats.status !== "succeeded"
      ? "partial" as const
      : "succeeded" as const;
  const completedAt = now().toISOString();

  return {
    version: RUNTIME_MAINTENANCE_VERSION,
    runId: input.runId,
    ownerId: input.ownerId,
    trigger: input.trigger,
    status,
    startedAt,
    completedAt,
    durationMs: Math.max(new Date(completedAt).getTime() - new Date(startedAt).getTime(), 0),
    modelCalls,
    heartbeats,
    errors
  };
}

async function markRunStarted(input: {
  client: PoolClient;
  maintenanceId: string;
  ownerId: string;
  runId: string;
  trigger: RuntimeMaintenanceTrigger;
  intervalSeconds: number;
}) {
  const result = await input.client.query(
    `update agent.runtime_maintenance_state
     set status = 'running',
         owner_id = $2,
         run_id = $3,
         trigger = $4,
         last_started_at = now(),
         next_run_at = now() + ($5::int * interval '1 second'),
         last_error = null,
         updated_at = now()
     where maintenance_id = $1
     returning *`,
    [input.maintenanceId, input.ownerId, input.runId, input.trigger, input.intervalSeconds]
  );
  return toRuntimeMaintenanceState(result.rows[0]);
}

async function markRunCompleted(input: {
  client: PoolClient;
  maintenanceId: string;
  result: RuntimeMaintenanceRunResult;
  intervalSeconds: number;
}) {
  const lastError = input.result.errors.length > 0 ? input.result.errors.join(" | ").slice(0, 4000) : null;
  const result = await input.client.query(
    `update agent.runtime_maintenance_state
     set status = $3,
         last_completed_at = $4::timestamptz,
         last_succeeded_at = case when $3 = 'succeeded' then $4::timestamptz else last_succeeded_at end,
         next_run_at = $4::timestamptz + ($5::int * interval '1 second'),
         last_error = $6,
         last_result = $7::jsonb,
         total_runs = total_runs + 1,
         consecutive_failures = case when $3 = 'succeeded' then 0 else consecutive_failures + 1 end,
         updated_at = now()
     where maintenance_id = $1
       and run_id = $2
     returning *`,
    [
      input.maintenanceId,
      input.result.runId,
      input.result.status,
      input.result.completedAt,
      input.intervalSeconds,
      lastError,
      JSON.stringify(input.result)
    ]
  );
  if (!result.rows[0]) throw new Error("runtime_maintenance_run_ownership_lost");
  return toRuntimeMaintenanceState(result.rows[0]);
}

export async function runRuntimeMaintenanceOnce(input: {
  ownerId: string;
  trigger: RuntimeMaintenanceTrigger;
  config: RuntimeMaintenanceConfig;
  force?: boolean;
  dependencies?: RuntimeMaintenanceRunDependencies;
}): Promise<RuntimeMaintenanceAttempt> {
  const checkedAt = new Date().toISOString();
  const maintenanceId = input.dependencies?.maintenanceId ?? RUNTIME_MAINTENANCE_ID;
  const lockKey = input.dependencies?.lockKey ?? RUNTIME_MAINTENANCE_LOCK_KEY;
  if (!input.config.enabled && !input.force) {
    return {
      version: RUNTIME_MAINTENANCE_VERSION,
      checkedAt,
      outcome: "disabled",
      result: null,
      state: await getRuntimeMaintenanceState(maintenanceId)
    };
  }

  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query(
      `select pg_try_advisory_lock(hashtext($1)) as acquired`,
      [lockKey]
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) {
      return {
        version: RUNTIME_MAINTENANCE_VERSION,
        checkedAt,
        outcome: "skipped_locked",
        result: null,
        state: await readRuntimeMaintenanceState(client, maintenanceId)
      };
    }

    const state = await readRuntimeMaintenanceState(client, maintenanceId);
    const databaseClock = await client.query(`select now() as now`);
    const databaseNow = iso(databaseClock.rows[0]?.now) ?? checkedAt;
    if (
      !input.force &&
      state?.nextRunAt &&
      new Date(state.nextRunAt).getTime() > new Date(databaseNow).getTime()
    ) {
      return {
        version: RUNTIME_MAINTENANCE_VERSION,
        checkedAt: databaseNow,
        outcome: "skipped_not_due",
        result: null,
        state
      };
    }

    const runId = input.dependencies?.createRunId?.() ?? randomUUID();
    const startedState = await markRunStarted({
      client,
      maintenanceId,
      ownerId: input.ownerId,
      runId,
      trigger: input.trigger,
      intervalSeconds: input.config.intervalSeconds
    });
    const result = await executeRuntimeMaintenanceComponents({
      runId,
      ownerId: input.ownerId,
      trigger: input.trigger,
      config: input.config,
      startedAt: startedState.lastStartedAt ?? databaseNow,
      dependencies: input.dependencies
    });
    const completedState = await markRunCompleted({
      client,
      maintenanceId,
      result,
      intervalSeconds: input.config.intervalSeconds
    });

    return {
      version: RUNTIME_MAINTENANCE_VERSION,
      checkedAt: result.completedAt,
      outcome: "completed",
      result,
      state: completedState
    };
  } finally {
    let releaseError: Error | undefined;
    if (acquired) {
      try {
        const unlocked = await client.query(
          `select pg_advisory_unlock(hashtext($1)) as unlocked`,
          [lockKey]
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          releaseError = new Error("runtime_maintenance_advisory_unlock_failed");
        }
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    client.release(releaseError);
  }
}

export async function getRuntimeMaintenanceOverview(
  config: RuntimeMaintenanceConfig,
  maintenanceId = RUNTIME_MAINTENANCE_ID
): Promise<RuntimeMaintenanceOverview> {
  const checkedAt = new Date().toISOString();
  const state = await getRuntimeMaintenanceState(maintenanceId);
  return {
    version: RUNTIME_MAINTENANCE_VERSION,
    checkedAt,
    config,
    health: classifyRuntimeMaintenanceHealth({ config, state, now: checkedAt }),
    state
  };
}
