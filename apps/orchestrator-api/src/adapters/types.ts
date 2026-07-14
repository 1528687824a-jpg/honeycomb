import type express from "express";
import type {
  IngressAdapter,
  JobRecord,
  RoutingMode,
  TaskExecutionPreflight,
  TaskOrchestrationPlan
} from "../../../../packages/shared/src/types";

export type CreateJobForIngressInput = {
  rawPrompt: string;
  displayTitle?: string;
  orchestrationPlan?: TaskOrchestrationPlan;
  conversationId?: string;
  sourceMessageId?: string;
  workdir?: string;
  routingMode?: RoutingMode;
  maxModelCalls?: number;
  maxCostUsd?: number;
  classicFinalGateEnabled?: boolean;
  discussionRounds?: number;
  requesterId?: string;
  feishuChatId?: string;
  feishuMessageId?: string;
};

export type IngressDeps = {
  createJob(input: CreateJobForIngressInput & { ingressOrigin: "http" | "feishu" }): Promise<JobRecord>;
  getJobByFeishuMessageId(feishuMessageId: string): Promise<JobRecord | null>;
  startJob(job: JobRecord): Promise<{
    status: JobRecord["status"];
    workflowId: string | null;
    preflight: TaskExecutionPreflight | null;
  }>;
};

export type ExpressIngressAdapter = IngressAdapter<express.Express, IngressDeps>;
