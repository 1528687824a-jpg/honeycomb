import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getRuntimeMaintenanceOverview,
  getRuntimeMaintenanceState,
  runRuntimeMaintenanceOnce,
  type RuntimeMaintenanceRunDependencies
} from "../packages/db/src/runtime-maintenance";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";
import type { RuntimeMaintenanceConfig } from "../packages/shared/src/runtime-maintenance";

const marker = randomUUID().replace(/-/g, "");
const maintenanceId = `runtime-maintenance-smoke-${marker}`;
const lockKey = `honeycomb.runtime-maintenance.smoke.${marker}`;
const config: RuntimeMaintenanceConfig = {
  enabled: true,
  intervalSeconds: 60,
  heartbeatTimeoutSeconds: 300,
  heartbeatScanLimit: 10,
  modelCallLeaseScanLimit: 10,
  staleAfterSeconds: 180
};
let runCounter = 0;
let modelCallScans = 0;
let heartbeatScans = 0;

function dependencies(overrides: Partial<RuntimeMaintenanceRunDependencies> = {}): RuntimeMaintenanceRunDependencies {
  return {
    maintenanceId,
    lockKey,
    createRunId: () => `run-${++runCounter}`,
    scanModelCalls: async () => {
      modelCallScans += 1;
      return {
        scanned: 2,
        providerResumeAvailable: 1,
        reconciliationRequired: 1,
        spendReconciled: 1,
        errors: [],
        summary: { expiredStarted: 0 }
      };
    },
    scanHeartbeats: async () => {
      heartbeatScans += 1;
      return { scanned: 1, summary: { staleCandidates: 0, stalled: 1 } };
    },
    ...overrides
  };
}

async function cleanup() {
  await pool.query(
    `delete from agent.runtime_maintenance_state where maintenance_id = $1`,
    [maintenanceId]
  );
}

async function main() {
  await runMigrations();
  await cleanup();

  const heldLock = await pool.connect();
  try {
    await heldLock.query(`select pg_advisory_lock(hashtext($1))`, [lockKey]);
    const skipped = await runRuntimeMaintenanceOnce({
      ownerId: "smoke-follower",
      trigger: "startup",
      config,
      dependencies: dependencies()
    });
    assert.equal(skipped.outcome, "skipped_locked");
    assert.equal(modelCallScans, 0);
    assert.equal(heartbeatScans, 0);
  } finally {
    await heldLock.query(`select pg_advisory_unlock(hashtext($1))`, [lockKey]);
    heldLock.release();
  }

  const first = await runRuntimeMaintenanceOnce({
    ownerId: "smoke-api",
    trigger: "startup",
    config,
    dependencies: dependencies()
  });
  assert.equal(first.outcome, "completed");
  assert.equal(first.result?.status, "succeeded");
  assert.equal(first.state?.totalRuns, 1);
  assert.equal(modelCallScans, 1);
  assert.equal(heartbeatScans, 1);

  const notDue = await runRuntimeMaintenanceOnce({
    ownerId: "smoke-worker",
    trigger: "interval",
    config,
    dependencies: dependencies()
  });
  assert.equal(notDue.outcome, "skipped_not_due");
  assert.equal(modelCallScans, 1);
  assert.equal(heartbeatScans, 1);

  const manual = await runRuntimeMaintenanceOnce({
    ownerId: "smoke-worker",
    trigger: "manual",
    config,
    force: true,
    dependencies: dependencies()
  });
  assert.equal(manual.outcome, "completed");
  assert.equal(manual.state?.totalRuns, 2);

  const partial = await runRuntimeMaintenanceOnce({
    ownerId: "smoke-api",
    trigger: "manual",
    config,
    force: true,
    dependencies: dependencies({
      scanHeartbeats: async () => {
        throw new Error("simulated heartbeat failure");
      }
    })
  });
  assert.equal(partial.result?.status, "partial");
  assert.equal(partial.state?.status, "partial");
  assert.equal(partial.state?.consecutiveFailures, 1);
  assert.match(partial.state?.lastError ?? "", /simulated heartbeat failure/);

  const state = await getRuntimeMaintenanceState(maintenanceId);
  const overview = await getRuntimeMaintenanceOverview(config, maintenanceId);
  assert.equal(state?.totalRuns, 3);
  assert.equal(overview.health, "degraded");

  console.log(JSON.stringify({
    ok: true,
    maintenanceId,
    checks: [
      "database_advisory_lock_prevents_parallel_cycle",
      "successful_result_is_persisted",
      "next_run_at_prevents_duplicate_interval_cycle",
      "manual_cycle_can_run_immediately",
      "partial_failure_is_persisted_for_diagnostics"
    ]
  }, null, 2));
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
