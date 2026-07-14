import assert from "node:assert/strict";
import test from "node:test";
import { executeRuntimeMaintenanceComponents } from "../packages/db/src/runtime-maintenance";
import { startRuntimeMaintenanceRunner } from "../packages/runtime/src/runtime-maintenance-runner";
import {
  RUNTIME_MAINTENANCE_VERSION,
  classifyRuntimeMaintenanceHealth,
  resolveRuntimeMaintenanceConfig,
  type RuntimeMaintenanceAttempt,
  type RuntimeMaintenanceConfig,
  type RuntimeMaintenanceState
} from "../packages/shared/src/runtime-maintenance";

const config: RuntimeMaintenanceConfig = {
  enabled: true,
  intervalSeconds: 30,
  heartbeatTimeoutSeconds: 300,
  heartbeatScanLimit: 100,
  modelCallLeaseScanLimit: 100,
  staleAfterSeconds: 120
};

function state(overrides: Partial<RuntimeMaintenanceState> = {}): RuntimeMaintenanceState {
  return {
    maintenanceId: "automatic-runtime-recovery",
    status: "succeeded",
    ownerId: "api-1",
    runId: "run-1",
    trigger: "interval",
    lastStartedAt: "2026-07-14T11:59:58.000Z",
    lastCompletedAt: "2026-07-14T12:00:00.000Z",
    lastSucceededAt: "2026-07-14T12:00:00.000Z",
    nextRunAt: "2026-07-14T12:00:30.000Z",
    lastError: null,
    lastResult: null,
    totalRuns: 1,
    consecutiveFailures: 0,
    updatedAt: "2026-07-14T12:00:00.000Z",
    ...overrides
  };
}

test("runtime maintenance configuration has bounded production defaults", () => {
  assert.deepEqual(resolveRuntimeMaintenanceConfig({}), config);
  assert.equal(resolveRuntimeMaintenanceConfig({
    HONEYCOMB_RUNTIME_MAINTENANCE_STALE_SECONDS: ""
  }).staleAfterSeconds, 120);
  assert.deepEqual(resolveRuntimeMaintenanceConfig({
    HONEYCOMB_RUNTIME_MAINTENANCE_ENABLED: "off",
    HONEYCOMB_RUNTIME_MAINTENANCE_INTERVAL_SECONDS: "1",
    JOB_HEARTBEAT_TIMEOUT_SECONDS: "999999",
    HONEYCOMB_RUNTIME_MAINTENANCE_HEARTBEAT_LIMIT: "0",
    HONEYCOMB_RUNTIME_MAINTENANCE_MODEL_CALL_LIMIT: "900",
    HONEYCOMB_RUNTIME_MAINTENANCE_STALE_SECONDS: "20"
  }), {
    enabled: false,
    intervalSeconds: 10,
    heartbeatTimeoutSeconds: 86400,
    heartbeatScanLimit: 1,
    modelCallLeaseScanLimit: 500,
    staleAfterSeconds: 30
  });
});

test("runtime maintenance health distinguishes startup, active, failed, and stale state", () => {
  const now = "2026-07-14T12:00:30.000Z";
  assert.equal(classifyRuntimeMaintenanceHealth({ config: { ...config, enabled: false }, state: null, now }), "disabled");
  assert.equal(classifyRuntimeMaintenanceHealth({ config, state: null, now }), "never_run");
  assert.equal(classifyRuntimeMaintenanceHealth({
    config,
    state: state({ status: "running", lastStartedAt: "2026-07-14T12:00:20.000Z" }),
    now
  }), "running");
  assert.equal(classifyRuntimeMaintenanceHealth({
    config,
    state: state({ status: "running", lastStartedAt: "2026-07-14T11:57:00.000Z" }),
    now
  }), "stale");
  assert.equal(classifyRuntimeMaintenanceHealth({ config, state: state(), now }), "healthy");
  assert.equal(classifyRuntimeMaintenanceHealth({ config, state: state({ status: "partial" }), now }), "degraded");
  assert.equal(classifyRuntimeMaintenanceHealth({ config, state: state({ status: "failed" }), now }), "failed");
  assert.equal(classifyRuntimeMaintenanceHealth({
    config,
    state: state({ lastCompletedAt: "2026-07-14T11:57:00.000Z" }),
    now
  }), "stale");
});

test("runtime maintenance runs specific model-call recovery before generic heartbeat scanning", async () => {
  const calls: string[] = [];
  const times = [
    new Date("2026-07-14T12:00:00.000Z"),
    new Date("2026-07-14T12:00:02.000Z")
  ];
  const result = await executeRuntimeMaintenanceComponents({
    runId: "run-success",
    ownerId: "api-1",
    trigger: "interval",
    config,
    dependencies: {
      now: () => times.shift() ?? new Date("2026-07-14T12:00:02.000Z"),
      scanModelCalls: async () => {
        calls.push("model_calls");
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
        calls.push("heartbeats");
        return { scanned: 1, summary: { staleCandidates: 0, stalled: 2 } };
      }
    }
  });

  assert.deepEqual(calls, ["model_calls", "heartbeats"]);
  assert.equal(result.status, "succeeded");
  assert.equal(result.durationMs, 2000);
  assert.equal(result.modelCalls.details.providerResumeAvailable, 1);
  assert.equal(result.heartbeats.details.totalStalled, 2);
});

test("runtime maintenance preserves partial results and records component errors", async () => {
  const result = await executeRuntimeMaintenanceComponents({
    runId: "run-partial",
    ownerId: "worker-1",
    trigger: "startup",
    config,
    dependencies: {
      scanModelCalls: async () => ({
        scanned: 1,
        providerResumeAvailable: 0,
        reconciliationRequired: 1,
        spendReconciled: 0,
        errors: ["spend ledger unavailable"],
        summary: { expiredStarted: 0 }
      }),
      scanHeartbeats: async () => {
        throw new Error("heartbeat query failed");
      }
    }
  });

  assert.equal(result.status, "partial");
  assert.equal(result.modelCalls.status, "partial");
  assert.equal(result.heartbeats.status, "failed");
  assert.deepEqual(result.errors, ["spend ledger unavailable", "heartbeat query failed"]);
});

test("runtime maintenance reports a failed run only when both components fail", async () => {
  const result = await executeRuntimeMaintenanceComponents({
    runId: "run-failed",
    ownerId: "worker-1",
    trigger: "interval",
    config,
    dependencies: {
      scanModelCalls: async () => { throw new Error("model scan failed"); },
      scanHeartbeats: async () => { throw new Error("heartbeat scan failed"); }
    }
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.errors, ["model scan failed", "heartbeat scan failed"]);
});

test("runtime maintenance runner coalesces local triggers and waits during shutdown", async () => {
  let calls = 0;
  let finish: ((attempt: RuntimeMaintenanceAttempt) => void) | null = null;
  const pending = new Promise<RuntimeMaintenanceAttempt>((resolve) => {
    finish = resolve;
  });
  const attempt: RuntimeMaintenanceAttempt = {
    version: RUNTIME_MAINTENANCE_VERSION,
    checkedAt: "2026-07-14T12:00:00.000Z",
    outcome: "skipped_not_due",
    result: null,
    state: state()
  };
  const runner = startRuntimeMaintenanceRunner({
    instanceKind: "test",
    ownerId: "test-owner",
    config: { ...config, intervalSeconds: 3600 },
    runImmediately: false,
    runOnce: async () => {
      calls += 1;
      return pending;
    }
  });

  const first = runner.triggerNow("manual", true);
  const second = runner.triggerNow("interval", false);
  assert.strictEqual(first, second);
  assert.equal(runner.isRunning(), true);
  assert.equal(calls, 1);
  const stopping = runner.stop();
  assert.equal(runner.isRunning(), true);
  finish!(attempt);
  await stopping;
  assert.equal(runner.isRunning(), false);
  assert.equal(await runner.triggerNow("manual", true), null);
});

test("disabled automatic maintenance still permits an explicit manual run", async () => {
  const calls: Array<{ trigger: string; force: boolean | undefined }> = [];
  const runner = startRuntimeMaintenanceRunner({
    instanceKind: "test-disabled",
    ownerId: "test-disabled-owner",
    config: { ...config, enabled: false },
    runImmediately: true,
    runOnce: async (input) => {
      calls.push({ trigger: input.trigger, force: input.force });
      return {
        version: RUNTIME_MAINTENANCE_VERSION,
        checkedAt: "2026-07-14T12:00:00.000Z",
        outcome: "completed",
        result: null,
        state: state()
      };
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  await runner.triggerNow();
  assert.deepEqual(calls, [{ trigger: "manual", force: true }]);
  await runner.stop();
});
