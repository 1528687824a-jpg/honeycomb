export const RUNTIME_MAINTENANCE_VERSION = "honeycomb.runtime-maintenance.v1" as const;
export const RUNTIME_MAINTENANCE_ID = "automatic-runtime-recovery";
export const RUNTIME_MAINTENANCE_LOCK_KEY = "honeycomb.runtime-maintenance.v1";

export type RuntimeMaintenanceTrigger = "startup" | "interval" | "manual";
export type RuntimeMaintenanceRunStatus = "succeeded" | "partial" | "failed";
export type RuntimeMaintenanceStateStatus = "never_run" | "running" | RuntimeMaintenanceRunStatus;
export type RuntimeMaintenanceComponentStatus = "succeeded" | "partial" | "failed";

export type RuntimeMaintenanceConfig = {
  enabled: boolean;
  intervalSeconds: number;
  heartbeatTimeoutSeconds: number;
  heartbeatScanLimit: number;
  modelCallLeaseScanLimit: number;
  staleAfterSeconds: number;
};

export type RuntimeMaintenanceComponentResult = {
  status: RuntimeMaintenanceComponentStatus;
  scanned: number;
  details: Record<string, number>;
  errors: string[];
};

export type RuntimeMaintenanceRunResult = {
  version: typeof RUNTIME_MAINTENANCE_VERSION;
  runId: string;
  ownerId: string;
  trigger: RuntimeMaintenanceTrigger;
  status: RuntimeMaintenanceRunStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  modelCalls: RuntimeMaintenanceComponentResult;
  heartbeats: RuntimeMaintenanceComponentResult;
  errors: string[];
};

export type RuntimeMaintenanceState = {
  maintenanceId: string;
  status: RuntimeMaintenanceStateStatus;
  ownerId: string | null;
  runId: string | null;
  trigger: RuntimeMaintenanceTrigger | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSucceededAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastResult: RuntimeMaintenanceRunResult | null;
  totalRuns: number;
  consecutiveFailures: number;
  updatedAt: string;
};

export type RuntimeMaintenanceHealth =
  | "disabled"
  | "never_run"
  | "running"
  | "healthy"
  | "degraded"
  | "failed"
  | "stale";

export type RuntimeMaintenanceOverview = {
  version: typeof RUNTIME_MAINTENANCE_VERSION;
  checkedAt: string;
  config: RuntimeMaintenanceConfig;
  health: RuntimeMaintenanceHealth;
  state: RuntimeMaintenanceState | null;
};

export type RuntimeMaintenanceAttemptOutcome =
  | "completed"
  | "skipped_locked"
  | "skipped_not_due"
  | "disabled";

export type RuntimeMaintenanceAttempt = {
  version: typeof RUNTIME_MAINTENANCE_VERSION;
  checkedAt: string;
  outcome: RuntimeMaintenanceAttemptOutcome;
  result: RuntimeMaintenanceRunResult | null;
  state: RuntimeMaintenanceState | null;
};

function integerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const source = value === undefined || value.trim() === "" ? fallback : value;
  const parsed = Number(source);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), minimum), maximum);
}

function booleanValue(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function resolveRuntimeMaintenanceConfig(
  env: Record<string, string | undefined> = process.env
): RuntimeMaintenanceConfig {
  const intervalSeconds = integerInRange(
    env.HONEYCOMB_RUNTIME_MAINTENANCE_INTERVAL_SECONDS,
    30,
    10,
    3600
  );
  const defaultStaleAfterSeconds = Math.max(intervalSeconds * 3, 120);
  return {
    enabled: booleanValue(env.HONEYCOMB_RUNTIME_MAINTENANCE_ENABLED, true),
    intervalSeconds,
    heartbeatTimeoutSeconds: integerInRange(env.JOB_HEARTBEAT_TIMEOUT_SECONDS, 300, 10, 86400),
    heartbeatScanLimit: integerInRange(
      env.HONEYCOMB_RUNTIME_MAINTENANCE_HEARTBEAT_LIMIT,
      100,
      1,
      500
    ),
    modelCallLeaseScanLimit: integerInRange(
      env.HONEYCOMB_RUNTIME_MAINTENANCE_MODEL_CALL_LIMIT,
      100,
      1,
      500
    ),
    staleAfterSeconds: integerInRange(
      env.HONEYCOMB_RUNTIME_MAINTENANCE_STALE_SECONDS,
      defaultStaleAfterSeconds,
      30,
      86400
    )
  };
}

function ageSeconds(timestamp: string | null, now: string) {
  if (!timestamp) return Number.POSITIVE_INFINITY;
  const age = new Date(now).getTime() - new Date(timestamp).getTime();
  return Number.isFinite(age) ? Math.max(age / 1000, 0) : Number.POSITIVE_INFINITY;
}

export function classifyRuntimeMaintenanceHealth(input: {
  config: RuntimeMaintenanceConfig;
  state: RuntimeMaintenanceState | null;
  now?: string;
}): RuntimeMaintenanceHealth {
  if (!input.config.enabled) return "disabled";
  if (!input.state || input.state.status === "never_run") return "never_run";

  const now = input.now ?? new Date().toISOString();
  if (input.state.status === "running") {
    return ageSeconds(input.state.lastStartedAt, now) > input.config.staleAfterSeconds
      ? "stale"
      : "running";
  }
  if (input.state.status === "failed") return "failed";
  if (input.state.status === "partial") return "degraded";
  if (ageSeconds(input.state.lastCompletedAt, now) > input.config.staleAfterSeconds) return "stale";
  return "healthy";
}
