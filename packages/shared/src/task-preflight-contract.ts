import { z } from "zod";
import {
  TASK_PREFLIGHT_SEVERITIES,
  TASK_PREFLIGHT_STATUSES,
  type TaskExecutionPreflight
} from "./types";

const issueSchema = z.object({
  code: z.string().trim().min(1).max(160),
  severity: z.enum(TASK_PREFLIGHT_SEVERITIES),
  agentId: z.string().trim().min(1).max(160),
  providerId: z.string().trim().min(1).max(160).nullable(),
  model: z.string().trim().min(1).max(500).nullable(),
  message: z.string().trim().min(1).max(1000)
});

const routeSchema = z.object({
  routeIndex: z.number().int().min(0).max(1000),
  source: z.enum(["primary", "agent_metadata", "provider_metadata"]),
  providerId: z.string().trim().min(1).max(160).nullable(),
  providerDisplayName: z.string().trim().min(1).max(300).nullable(),
  providerBaseUrl: z.string().trim().min(1).max(4000).nullable(),
  providerVerificationStatus: z.string().trim().min(1).max(100).nullable(),
  verificationKind: z.string().trim().min(1).max(100).nullable(),
  model: z.string().trim().min(1).max(500).nullable(),
  ready: z.boolean(),
  issues: z.array(issueSchema).max(100)
});

const agentSchema = z.object({
  agentId: z.string().trim().min(1).max(160),
  purpose: z.enum(["production", "quality_gate", "synthesis"]),
  stageTypes: z.array(z.string().trim().min(1).max(160)).max(100),
  ready: z.boolean(),
  selectedRouteIndex: z.number().int().min(0).max(1000).nullable(),
  routes: z.array(routeSchema).min(1).max(100)
});

export const taskExecutionPreflightSchema = z.object({
  version: z.literal("honeycomb.task-preflight.v1"),
  status: z.enum(TASK_PREFLIGHT_STATUSES),
  mode: z.enum(["mock", "real"]),
  runner: z.enum(["mock", "wsl", "native", "provider-direct"]),
  checkedAt: z.string().datetime({ offset: true }),
  agents: z.array(agentSchema).max(100),
  blockingIssues: z.array(issueSchema).max(500),
  warnings: z.array(issueSchema).max(500)
});

export function parseTaskExecutionPreflight(value: unknown): TaskExecutionPreflight | null {
  const parsed = taskExecutionPreflightSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
