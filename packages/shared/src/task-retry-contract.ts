import { z } from "zod";
import {
  MODEL_CALL_FAILURE_CATEGORIES,
  type TaskExecutionRetryState
} from "./model-retry-policy";

export const taskExecutionRetryStateSchema = z.object({
  version: z.literal("honeycomb.model-retry.v1"),
  status: z.literal("waiting"),
  idempotencyKey: z.string().trim().min(1).max(1000),
  actionType: z.string().trim().min(1).max(100),
  agentId: z.string().trim().min(1).max(200),
  providerId: z.string().trim().min(1).max(200),
  routeIndex: z.number().int().min(0).max(1000),
  failedAttemptNo: z.number().int().min(1).max(5),
  nextAttemptNo: z.number().int().min(2).max(5),
  maxAttempts: z.number().int().min(2).max(5),
  failureCategory: z.enum(MODEL_CALL_FAILURE_CATEGORIES),
  reason: z.string().trim().min(1).max(500),
  delayMs: z.number().int().min(0).max(300_000),
  retryAfterMs: z.number().int().min(0).max(300_000).nullable(),
  retryAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).superRefine((value, context) => {
  if (value.nextAttemptNo !== value.failedAttemptNo + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextAttemptNo"],
      message: "nextAttemptNo must follow failedAttemptNo"
    });
  }
  if (value.nextAttemptNo > value.maxAttempts) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextAttemptNo"],
      message: "nextAttemptNo must not exceed maxAttempts"
    });
  }
});

export function parseTaskExecutionRetryState(value: unknown): TaskExecutionRetryState | null {
  const parsed = taskExecutionRetryStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
