import { randomUUID } from "node:crypto";
import {
  appendJobEvent,
  clearJobExecutionQueue,
  getJob,
  recordJobHeartbeat,
  setJobExecutionQueue
} from "../../../packages/db/src/jobs";
import {
  cancelModelCallQueueRequest,
  releaseModelCallSlot as releasePersistedModelCallSlot,
  tryAcquireModelCallSlot
} from "../../../packages/db/src/model-call-queue";
import { resolveModelCallConcurrencyPolicy } from "../../../packages/shared/src/model-concurrency";
import type { AgentRuntimeSecrets } from "./agent-runtime";

export type ModelCallQueueActionType =
  | "stage-agent"
  | "test-agent"
  | "main-agent-synthesis"
  | "final-test-agent";

export type ModelCallSlotLease = {
  requestKey: string;
  ownerId: string;
  waitedMs: number;
};

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function safeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\u0000/g, "");
}

async function heartbeat(
  jobId: string,
  source: string,
  note?: string | null,
  stageId?: string | null
) {
  await recordJobHeartbeat({
    jobId,
    source,
    note,
    stageId: stageId ?? null
  });
}

export async function acquireModelCallSlot(input: {
  idempotencyKey: string;
  jobId: string;
  stageId?: string | null;
  routeIndex: number;
  route: AgentRuntimeSecrets;
  timeoutSeconds: number;
  actionType: ModelCallQueueActionType;
}): Promise<ModelCallSlotLease | null> {
  if (process.env.OPENCLAW_AGENT_MODE !== "real") {
    return null;
  }
  if (!input.route.providerId) {
    throw new Error("provider_not_bound");
  }

  const policy = resolveModelCallConcurrencyPolicy({
    providerLimitOverride: input.route.providerConcurrencyLimit,
    agentLimitOverride: input.route.agentConcurrencyLimit
  });
  const requestKey = `${input.idempotencyKey}:route:${input.routeIndex}`;
  const ownerId = randomUUID();
  const startedAt = Date.now();
  let waitingEventSent = false;
  let lastQueueSignature = "";
  let lastQueuePersistedAt = 0;
  let lastHeartbeatAt = 0;

  while (true) {
    const job = await getJob(input.jobId);
    if (!job || job.status === "cancelled") {
      const cancelled = await cancelModelCallQueueRequest({
        requestKey,
        ownerId,
        reason: "job_cancelled"
      });
      if (cancelled) {
        await clearJobExecutionQueue(input.jobId, requestKey);
      }
      throw new Error("job_cancelled");
    }

    const attempt = await tryAcquireModelCallSlot({
      requestKey,
      idempotencyKey: input.idempotencyKey,
      jobId: input.jobId,
      stageId: input.stageId,
      routeIndex: input.routeIndex,
      agentId: input.route.honeycombAgentId,
      providerId: input.route.providerId,
      ownerId,
      limits: policy.limits,
      queueLeaseSeconds: policy.queueHeartbeatTtlSeconds,
      leaseSeconds: input.timeoutSeconds + policy.leaseGraceSeconds,
      retryAfterMs: policy.pollMs
    });
    const signature = JSON.stringify({
      status: attempt.state.status,
      globalPosition: attempt.state.globalPosition,
      providerPosition: attempt.state.providerPosition,
      agentPosition: attempt.state.agentPosition,
      blockingScopes: attempt.state.blockingScopes,
      active: attempt.state.active
    });
    if (signature !== lastQueueSignature || Date.now() - lastQueuePersistedAt >= 10_000) {
      await setJobExecutionQueue(input.jobId, attempt.state);
      lastQueueSignature = signature;
      lastQueuePersistedAt = Date.now();
    }

    if (attempt.acquired) {
      const waitedMs = Date.now() - startedAt;
      await appendJobEvent(input.jobId, "model_call.queue_acquired", {
        stageId: input.stageId ?? null,
        actionType: input.actionType,
        agentId: input.route.honeycombAgentId,
        providerId: input.route.providerId,
        requestKey,
        routeIndex: input.routeIndex,
        waitedMs,
        limits: attempt.state.limits,
        active: attempt.state.active
      });
      return { requestKey, ownerId, waitedMs };
    }

    if (!waitingEventSent) {
      await appendJobEvent(input.jobId, "model_call.queue_waiting", {
        stageId: input.stageId ?? null,
        actionType: input.actionType,
        agentId: input.route.honeycombAgentId,
        providerId: input.route.providerId,
        requestKey,
        routeIndex: input.routeIndex,
        positions: {
          global: attempt.state.globalPosition,
          provider: attempt.state.providerPosition,
          agent: attempt.state.agentPosition
        },
        blockingScopes: attempt.state.blockingScopes,
        limits: attempt.state.limits,
        active: attempt.state.active
      });
      waitingEventSent = true;
    }

    if (Date.now() - lastHeartbeatAt >= 10_000) {
      await heartbeat(
        input.jobId,
        `model_call.${input.actionType}.queued`,
        `${input.route.honeycombAgentId} waiting for ${input.route.providerId}`,
        input.stageId ?? null
      );
      lastHeartbeatAt = Date.now();
    }

    if (Date.now() - startedAt >= policy.waitTimeoutMs) {
      const cancelled = await cancelModelCallQueueRequest({
        requestKey,
        ownerId,
        reason: "queue_wait_timeout"
      });
      if (cancelled) {
        await clearJobExecutionQueue(input.jobId, requestKey);
      }
      await appendJobEvent(input.jobId, "model_call.queue_timeout", {
        stageId: input.stageId ?? null,
        actionType: input.actionType,
        agentId: input.route.honeycombAgentId,
        providerId: input.route.providerId,
        requestKey,
        waitedMs: Date.now() - startedAt
      });
      throw new Error("model_call_queue_timeout");
    }

    await wait(policy.pollMs);
  }
}

export async function releaseModelCallSlot(input: {
  jobId: string;
  stageId?: string | null;
  actionType: ModelCallQueueActionType;
  route: AgentRuntimeSecrets;
  lease: ModelCallSlotLease | null;
  reason?: string | null;
}) {
  if (!input.lease) return;
  try {
    const released = await releasePersistedModelCallSlot({
      requestKey: input.lease.requestKey,
      ownerId: input.lease.ownerId,
      reason: input.reason ?? null
    });
    if (!released) {
      await appendJobEvent(input.jobId, "model_call.queue_release_skipped", {
        stageId: input.stageId ?? null,
        actionType: input.actionType,
        agentId: input.route.honeycombAgentId,
        providerId: input.route.providerId,
        requestKey: input.lease.requestKey,
        reason: "lease_ownership_changed_or_expired"
      });
      return;
    }
    await clearJobExecutionQueue(input.jobId, input.lease.requestKey);
    await appendJobEvent(input.jobId, "model_call.queue_released", {
      stageId: input.stageId ?? null,
      actionType: input.actionType,
      agentId: input.route.honeycombAgentId,
      providerId: input.route.providerId,
      requestKey: input.lease.requestKey,
      waitedMs: input.lease.waitedMs,
      reason: input.reason ?? null
    });
  } catch (error) {
    await appendJobEvent(input.jobId, "model_call.queue_release_failed", {
      stageId: input.stageId ?? null,
      actionType: input.actionType,
      agentId: input.route.honeycombAgentId,
      providerId: input.route.providerId,
      requestKey: input.lease.requestKey,
      error: safeErrorMessage(error)
    }).catch(() => undefined);
  }
}
