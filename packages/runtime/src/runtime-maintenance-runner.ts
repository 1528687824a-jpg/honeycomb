import { randomUUID } from "node:crypto";
import {
  resolveRuntimeMaintenanceConfig,
  type RuntimeMaintenanceAttempt,
  type RuntimeMaintenanceConfig,
  type RuntimeMaintenanceTrigger
} from "../../shared/src/runtime-maintenance";
import { runRuntimeMaintenanceOnce } from "../../db/src/runtime-maintenance";

type RunOnce = typeof runRuntimeMaintenanceOnce;

export type RuntimeMaintenanceRunner = {
  ownerId: string;
  config: RuntimeMaintenanceConfig;
  triggerNow: (trigger?: RuntimeMaintenanceTrigger, force?: boolean) => Promise<RuntimeMaintenanceAttempt | null>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
};

export function createRuntimeMaintenanceOwnerId(instanceKind: string) {
  const kind = instanceKind.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60) || "runtime";
  return `${kind}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function logAttempt(attempt: RuntimeMaintenanceAttempt) {
  if (attempt.outcome !== "completed" || !attempt.result) return;
  const scanned = attempt.result.modelCalls.scanned + attempt.result.heartbeats.scanned;
  if (attempt.result.status !== "succeeded") {
    console.error(
      `Honeycomb runtime maintenance ${attempt.result.status}: ${attempt.result.errors.join(" | ") || "component failure"}`
    );
  } else if (scanned > 0) {
    console.log(
      `Honeycomb runtime maintenance classified ${attempt.result.modelCalls.scanned} model call(s) and ${attempt.result.heartbeats.scanned} stalled job(s)`
    );
  }
}

export function startRuntimeMaintenanceRunner(input: {
  instanceKind: string;
  ownerId?: string;
  config?: RuntimeMaintenanceConfig;
  runImmediately?: boolean;
  runOnce?: RunOnce;
}): RuntimeMaintenanceRunner {
  const config = input.config ?? resolveRuntimeMaintenanceConfig();
  const ownerId = input.ownerId ?? createRuntimeMaintenanceOwnerId(input.instanceKind);
  const runOnce = input.runOnce ?? runRuntimeMaintenanceOnce;
  let stopped = false;
  let current: Promise<RuntimeMaintenanceAttempt | null> | null = null;

  const triggerNow = (
    trigger: RuntimeMaintenanceTrigger = "manual",
    force = trigger === "manual"
  ): Promise<RuntimeMaintenanceAttempt | null> => {
    if (stopped) return Promise.resolve(null);
    if (current) return current;

    current = runOnce({ ownerId, trigger, config, force })
      .then((attempt) => {
        logAttempt(attempt);
        return attempt;
      })
      .catch((error) => {
        console.error("Honeycomb runtime maintenance tick failed", error);
        throw error;
      })
      .finally(() => {
        current = null;
      });
    return current;
  };

  let timer: NodeJS.Timeout | null = null;
  if (config.enabled) {
    timer = setInterval(() => {
      void triggerNow("interval", false).catch(() => undefined);
    }, config.intervalSeconds * 1000);
    timer.unref();
    if (input.runImmediately ?? true) {
      void triggerNow("startup", false).catch(() => undefined);
    }
  }

  return {
    ownerId,
    config,
    triggerNow,
    isRunning: () => current !== null,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await current?.catch(() => undefined);
    }
  };
}
