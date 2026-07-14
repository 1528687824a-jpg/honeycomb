import { z } from "zod";
import {
  MODEL_CALL_QUEUE_BLOCKING_SCOPES,
  MODEL_CALL_QUEUE_STATUSES,
  type TaskExecutionQueueState
} from "./types";

const concurrencyCounterSchema = z.object({
  global: z.number().int().min(0).max(100_000),
  provider: z.number().int().min(0).max(100_000),
  agent: z.number().int().min(0).max(100_000)
});

export const taskExecutionQueueStateSchema = z.object({
  version: z.literal("honeycomb.model-call-queue.v1"),
  status: z.enum(MODEL_CALL_QUEUE_STATUSES),
  requestKey: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().trim().min(1).max(1000),
  routeIndex: z.number().int().min(0).max(1000),
  agentId: z.string().trim().min(1).max(200),
  providerId: z.string().trim().min(1).max(200),
  queuedAt: z.string().datetime({ offset: true }),
  acquiredAt: z.string().datetime({ offset: true }).nullable(),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  globalPosition: z.number().int().min(0).max(100_000),
  providerPosition: z.number().int().min(0).max(100_000),
  agentPosition: z.number().int().min(0).max(100_000),
  limits: concurrencyCounterSchema,
  active: concurrencyCounterSchema,
  blockingScopes: z.array(z.enum(MODEL_CALL_QUEUE_BLOCKING_SCOPES)).max(10),
  retryAfterMs: z.number().int().min(1).max(60_000)
});

export function parseTaskExecutionQueueState(value: unknown): TaskExecutionQueueState | null {
  const parsed = taskExecutionQueueStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
