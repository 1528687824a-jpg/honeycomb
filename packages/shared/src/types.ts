import type { TaskExecutionRetryState } from "./model-retry-policy";

export type { TaskExecutionRetryState } from "./model-retry-policy";

export type JobStatus =
  | "created"
  | "queued"
  | "planning"
  | "running"
  | "testing"
  | "fixing"
  | "waiting_for_human"
  | "succeeded"
  | "failed"
  | "cancelled";

export const JOB_STATUSES = [
  "created",
  "queued",
  "planning",
  "running",
  "testing",
  "fixing",
  "waiting_for_human",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export const JOB_HEARTBEAT_STATUSES = [
  "unknown",
  "healthy",
  "stalled",
  "paused",
  "terminal"
] as const;

export type JobHeartbeatStatus = (typeof JOB_HEARTBEAT_STATUSES)[number];

export const ROUTING_MODES = [
  "pipeline",
  "supervisor_pipeline",
  "classic_master_slave",
  "master_slave_discussion"
] as const;

export type RoutingMode = (typeof ROUTING_MODES)[number];

export const DEFAULT_ROUTING_MODE: RoutingMode = "supervisor_pipeline";
export const DEFAULT_MAX_MODEL_CALLS = 20;
export const DEFAULT_DISCUSSION_ROUNDS = 2;

export const PANEL_MESSAGE_INTENTS = ["chat", "task"] as const;
export type PanelMessageIntent = (typeof PANEL_MESSAGE_INTENTS)[number];

export const ORCHESTRATION_PLAN_SOURCES = [
  "panel-agent",
  "deterministic-fallback",
  "legacy-fallback"
] as const;
export type OrchestrationPlanSource = (typeof ORCHESTRATION_PLAN_SOURCES)[number];

export const TASK_DELIVERABLE_KINDS = ["text", "image", "video", "code", "file", "other"] as const;
export type TaskDeliverableKind = (typeof TASK_DELIVERABLE_KINDS)[number];

export const TASK_DELIVERY_TARGETS = ["conversation", "desktop", "workspace", "custom"] as const;
export type TaskDeliveryTarget = (typeof TASK_DELIVERY_TARGETS)[number];

export type TaskOrchestrationStage = {
  stageType: string;
  agentId: string;
  name: string;
  objective: string;
  acceptanceCriteria: string[];
  maxRetries: number;
};

export type TaskSkippedAgent = {
  agentId: string;
  reason: string;
};

export type TaskDeliverable = {
  kind: TaskDeliverableKind;
  description: string;
  required: boolean;
  format: string | null;
  width: number | null;
  height: number | null;
  target: TaskDeliveryTarget;
  targetPath: string | null;
};

export type TaskQualityGate = {
  enabled: boolean;
  agentId: string | null;
  acceptanceCriteria: string[];
};

export type TaskOrchestrationPlan = {
  version: "honeycomb.task-orchestration.v1";
  title: string;
  summary: string;
  routingMode: RoutingMode;
  selectedAgents: string[];
  skippedAgents: TaskSkippedAgent[];
  stages: TaskOrchestrationStage[];
  qualityGate: TaskQualityGate;
  deliverables: TaskDeliverable[];
  maxModelCalls: number;
  blockingQuestions: string[];
  rationale: string;
  source: OrchestrationPlanSource;
  generatedAt: string;
};

export type PanelOrchestrationResult = {
  intent: PanelMessageIntent;
  reply: string;
  plan: TaskOrchestrationPlan | null;
  source: OrchestrationPlanSource;
  degraded: boolean;
  warnings: string[];
};

export const CONVERSATION_MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export type ConversationMessageRole = (typeof CONVERSATION_MESSAGE_ROLES)[number];

export const CONVERSATION_MESSAGE_STATUSES = [
  "pending",
  "sent",
  "failed",
  "offline"
] as const;
export type ConversationMessageStatus = (typeof CONVERSATION_MESSAGE_STATUSES)[number];

export type ConversationAttachment = {
  id: string;
  name: string;
  path: string;
  addedAt: string;
};

export type ConversationProjectRecord = {
  id: string;
  name: string;
  workspacePath: string | null;
  pinned: boolean;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConversationRecord = {
  id: string;
  projectId: string;
  title: string;
  draft: string;
  attachments: ConversationAttachment[];
  pinned: boolean;
  unread: boolean;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessageRecord = {
  id: string;
  conversationId: string;
  role: ConversationMessageRole;
  body: string;
  status: ConversationMessageStatus;
  jobId: string | null;
  attachments: ConversationAttachment[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConversationProjectWithThreads = ConversationProjectRecord & {
  conversations: Array<ConversationRecord & { messages: ConversationMessageRecord[] }>;
};

export type ConversationWorkspaceSnapshot = {
  projects: ConversationProjectWithThreads[];
  generatedAt: string;
};

export const TASK_PREFLIGHT_STATUSES = ["ready", "blocked", "simulation"] as const;
export type TaskPreflightStatus = (typeof TASK_PREFLIGHT_STATUSES)[number];

export const TASK_PREFLIGHT_SEVERITIES = ["blocking", "warning"] as const;
export type TaskPreflightSeverity = (typeof TASK_PREFLIGHT_SEVERITIES)[number];

export type TaskPreflightIssue = {
  code: string;
  severity: TaskPreflightSeverity;
  agentId: string;
  providerId: string | null;
  model: string | null;
  message: string;
};

export type TaskPreflightRoute = {
  routeIndex: number;
  source: "primary" | "agent_metadata" | "provider_metadata";
  providerId: string | null;
  providerDisplayName: string | null;
  providerBaseUrl: string | null;
  providerVerificationStatus: string | null;
  verificationKind: string | null;
  model: string | null;
  ready: boolean;
  issues: TaskPreflightIssue[];
};

export type TaskPreflightAgent = {
  agentId: string;
  purpose: "production" | "quality_gate" | "synthesis";
  stageTypes: string[];
  ready: boolean;
  selectedRouteIndex: number | null;
  routes: TaskPreflightRoute[];
};

export type TaskExecutionPreflight = {
  version: "honeycomb.task-preflight.v1";
  status: TaskPreflightStatus;
  mode: "mock" | "real";
  runner: "mock" | "wsl" | "native" | "provider-direct";
  checkedAt: string;
  agents: TaskPreflightAgent[];
  blockingIssues: TaskPreflightIssue[];
  warnings: TaskPreflightIssue[];
};

export const MODEL_CALL_QUEUE_STATUSES = ["queued", "acquired"] as const;
export type ModelCallQueueStatus = (typeof MODEL_CALL_QUEUE_STATUSES)[number];

export const MODEL_CALL_QUEUE_BLOCKING_SCOPES = [
  "global",
  "provider",
  "agent",
  "earlier_request",
  "request_lease"
] as const;
export type ModelCallQueueBlockingScope = (typeof MODEL_CALL_QUEUE_BLOCKING_SCOPES)[number];

export type ModelCallConcurrencyLimits = {
  global: number;
  provider: number;
  agent: number;
};

export type ModelCallConcurrencyUsage = {
  global: number;
  provider: number;
  agent: number;
};

export type TaskExecutionQueueState = {
  version: "honeycomb.model-call-queue.v1";
  status: ModelCallQueueStatus;
  requestKey: string;
  idempotencyKey: string;
  routeIndex: number;
  agentId: string;
  providerId: string;
  queuedAt: string;
  acquiredAt: string | null;
  leaseExpiresAt: string | null;
  globalPosition: number;
  providerPosition: number;
  agentPosition: number;
  limits: ModelCallConcurrencyLimits;
  active: ModelCallConcurrencyUsage;
  blockingScopes: ModelCallQueueBlockingScope[];
  retryAfterMs: number;
};

export const INGRESS_ORIGINS = ["http", "feishu", "slack", "cli"] as const;

export type IngressOrigin = (typeof INGRESS_ORIGINS)[number];

export type JobRecord = {
  id: string;
  sessionId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  ingressOrigin: IngressOrigin;
  rawPrompt: string;
  displayTitle: string;
  orchestrationPlan: TaskOrchestrationPlan | null;
  orchestrationSource: OrchestrationPlanSource | null;
  executionPreflight: TaskExecutionPreflight | null;
  executionQueue: TaskExecutionQueueState | null;
  executionRetry: TaskExecutionRetryState | null;
  routingMode: RoutingMode;
  maxModelCalls: number;
  maxCostUsd: number | null;
  spendBudget: JobSpendBudget;
  classicFinalGateEnabled: boolean;
  discussionRounds: number;
  status: JobStatus;
  workflowId: string | null;
  heartbeatAt: string | null;
  heartbeatStatus: JobHeartbeatStatus;
  heartbeatSource: string | null;
  heartbeatNote: string | null;
  stalledAt: string | null;
  finalOutput: string | null;
  workdir: string | null;
  feishuChatId: string | null;
  feishuMessageId: string | null;
  requesterId: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  retentionUntil: string | null;
  cleanupStatus: "active" | "retained" | "eligible" | "cleaned" | "cleanup_failed";
  retentionPolicy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const TASK_PLAN_STATUSES = ["draft", "active", "completed", "archived"] as const;
export type TaskPlanStatus = (typeof TASK_PLAN_STATUSES)[number];

export const TASK_PLAN_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled"
] as const;
export type TaskPlanItemStatus = (typeof TASK_PLAN_ITEM_STATUSES)[number];

export type TaskPlanRecord = {
  id: string;
  jobId: string;
  title: string;
  summary: string | null;
  status: TaskPlanStatus;
  source: string;
  sourceArtifactId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type TaskPlanItemRecord = {
  id: string;
  planId: string;
  position: number;
  title: string;
  body: string | null;
  status: TaskPlanItemStatus;
  agentId: string | null;
  stageId: string | null;
  artifactId: string | null;
  acceptanceCriteria: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type TaskPlanWithItems = {
  plan: TaskPlanRecord;
  items: TaskPlanItemRecord[];
};

export const TOOL_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "consumed",
  "expired",
  "cancelled"
] as const;
export type ToolApprovalStatus = (typeof TOOL_APPROVAL_STATUSES)[number];

export const TOOL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export type ToolApprovalRecord = {
  id: string;
  jobId: string;
  sessionId: string;
  stageId: string | null;
  agentId: string;
  requesterActor: string;
  toolName: string;
  actionType: string;
  riskLevel: ToolRiskLevel;
  reason: string | null;
  command: string | null;
  target: string | null;
  input: Record<string, unknown>;
  policy: Record<string, unknown>;
  status: ToolApprovalStatus;
  decisionReason: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
};

export const PROVIDER_VERIFICATION_STATUSES = ["unknown", "succeeded", "failed"] as const;
export type ProviderVerificationStatus = (typeof PROVIDER_VERIFICATION_STATUSES)[number];

export type ModelProviderRecord = {
  id: string;
  displayName: string;
  baseUrl: string;
  defaultModel: string | null;
  apiKeyConfigured: boolean;
  apiKeyFingerprint: string | null;
  verificationStatus: ProviderVerificationStatus;
  lastVerifiedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const AGENT_SYNC_STATUSES = ["pending", "synced", "failed", "unknown"] as const;
export type AgentSyncStatus = (typeof AGENT_SYNC_STATUSES)[number];

export type AgentConfigRecord = {
  id: string;
  displayName: string;
  agentRole: string;
  required: boolean;
  enabled: boolean;
  providerId: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
  apiKeyFingerprint: string | null;
  workspacePath: string | null;
  promptTemplatePath: string | null;
  tools: string[];
  openclawSyncStatus: AgentSyncStatus;
  openclawAgentPath: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const MCP_SERVER_STATUSES = ["unknown", "available", "missing", "failed"] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export type SkillRegistryRecord = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  source: string;
  config: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type McpServerRecord = {
  id: string;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
  status: McpServerStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const MODEL_CALL_SPEND_STATUSES = [
  "reserved",
  "outcome_unknown",
  "settled",
  "settled_estimate",
  "released",
  "blocked"
] as const;
export type ModelCallSpendStatus = (typeof MODEL_CALL_SPEND_STATUSES)[number];

export type SpendBudgetBlockingScope =
  | "pricing"
  | "job"
  | "user_daily"
  | "provider_daily";

export type JobSpendBudget = {
  version: "honeycomb.job-spend-budget.v1";
  enabled: boolean;
  currency: "USD";
  maxCostUsd: number | null;
  settledUsd: number;
  reservedUsd: number;
  committedUsd: number;
  remainingUsd: number | null;
  blocked: boolean;
  blockingScope: SpendBudgetBlockingScope | null;
  blockingReason: string | null;
  userDailyLimitUsd: number | null;
  userDailyCommittedUsd: number | null;
  providerId: string | null;
  providerDailyLimitUsd: number | null;
  providerDailyCommittedUsd: number | null;
  updatedAt: string | null;
};

export type AgentMcpPolicyRecord = {
  id: string;
  agentId: string;
  serverId: string;
  enabled: boolean;
  allowToolsList: boolean;
  allowResourcesList: boolean;
  allowAllTools: boolean;
  allowedTools: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const SCHEDULE_TYPES = ["manual", "once", "daily", "interval"] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export const SCHEDULE_TASK_STATUSES = [
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "disabled"
] as const;
export type ScheduledTaskStatus = (typeof SCHEDULE_TASK_STATUSES)[number];

export type ScheduledTaskRecord = {
  id: string;
  title: string;
  prompt: string;
  scheduleType: ScheduleType;
  enabled: boolean;
  workspacePath: string | null;
  routingMode: RoutingMode;
  maxModelCalls: number;
  providerId: string | null;
  agentId: string | null;
  runAt: string | null;
  intervalSeconds: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: ScheduledTaskStatus;
  lastJobId: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const EXPERIENCE_STATUSES = ["candidate", "adopted", "rejected"] as const;
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

export const EXPERIENCE_KINDS = [
  "routing_outcome",
  "success_pattern",
  "failure_pattern",
  "agent_lesson",
  "user_preference"
] as const;
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

export const EXPERIENCE_SCOPES = [
  "routing_mode",
  "agent",
  "task_type",
  "project",
  "user_profile"
] as const;
export type ExperienceScope = (typeof EXPERIENCE_SCOPES)[number];

export type ExperienceRecord = {
  id: string;
  sourceJobId: string;
  kind: ExperienceKind;
  scope: ExperienceScope;
  scopeKey: string;
  status: ExperienceStatus;
  summary: string;
  evidence: Array<Record<string, unknown>>;
  confidence: number;
  utilityScore: number;
  decayScore: number;
  occurrenceCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  adoptedAt: string | null;
  rejectedAt: string | null;
  lastRecalledAt: string | null;
  recallCount: number;
  lastReinforcedAt: string | null;
};

export type CreateJobInput = {
  rawPrompt: string;
  displayTitle?: string;
  orchestrationPlan?: TaskOrchestrationPlan;
  conversationId?: string;
  sourceMessageId?: string;
  workdir?: string;
  ingressOrigin?: IngressOrigin;
  routingMode?: RoutingMode;
  maxModelCalls?: number;
  maxCostUsd?: number | null;
  classicFinalGateEnabled?: boolean;
  discussionRounds?: number;
  requesterId?: string;
  feishuChatId?: string;
  feishuMessageId?: string;
};

export type JobWorkflowInput = {
  jobId: string;
};

export type StageStatus =
  | "pending"
  | "running"
  | "test_pending"
  | "test_passed"
  | "test_failed"
  | "fixing"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "skipped";

export type TestVerdict = "PASS" | "FAIL_RETRYABLE" | "NEEDS_HUMAN";

export type ArtifactType =
  | "user_request"
  | "pipeline_plan"
  | "stage_input"
  | "stage_output"
  | "stage_summary"
  | "state_json"
  | "test_report"
  | "discussion_synthesis"
  | "session_summary"
  | "final_output"
  | "group_message"
  | "log";

export type StageDefinition = {
  stageType: string;
  agentId: string;
  name: string;
  acceptanceCriteria: string[];
  maxRetries?: number;
};

export type AgentClusterAgentConfig = {
  id: string;
  role: string;
  displayName: string;
  promptPath: string;
  capabilities: string[];
};

export type AgentClusterConfig = {
  schemaVersion: "agent-openclaw.cluster.v1";
  clusterId: string;
  name: string;
  description: string;
  defaultRoutingMode: RoutingMode;
  agents: AgentClusterAgentConfig[];
  stages: StageDefinition[];
  generatedAt: string;
  source: {
    planner: "mock" | "openai-compatible";
    answersPath?: string;
    model?: string;
  };
};

export type StageRecord = {
  id: string;
  jobId: string;
  stageIndex: number;
  stageType: string;
  agentId: string;
  name: string;
  status: StageStatus;
  inputArtifactId: string | null;
  outputArtifactId: string | null;
  acceptanceCriteria: string[];
  retryCount: number;
  maxRetries: number;
  originalAgentSessionId: string | null;
  originalTestSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactRecord = {
  id: string;
  jobId: string;
  stageId: string | null;
  type: ArtifactType;
  title: string | null;
  content: string | null;
  uri: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export const ARTIFACT_FILE_STATUSES = [
  "available",
  "remote_only",
  "download_failed",
  "missing"
] as const;
export type ArtifactFileStatus = (typeof ARTIFACT_FILE_STATUSES)[number];

export type ArtifactFileRecord = {
  id: string;
  artifactId: string;
  jobId: string;
  stageId: string | null;
  kind: "image" | "video";
  status: ArtifactFileStatus;
  filePath: string | null;
  externalUrl: string | null;
  fileName: string;
  mimeType: string | null;
  format: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  checksumSha256: string | null;
  source: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const ARTIFACT_DELIVERY_STATUSES = [
  "pending",
  "delivering",
  "succeeded",
  "failed",
  "cancelled"
] as const;
export type ArtifactDeliveryStatus = (typeof ARTIFACT_DELIVERY_STATUSES)[number];

export type ArtifactDeliveryRecord = {
  id: string;
  jobId: string;
  artifactFileId: string;
  deliverableIndex: number;
  required: boolean;
  target: TaskDeliveryTarget;
  targetPath: string | null;
  requestedFileName: string;
  status: ArtifactDeliveryStatus;
  attemptCount: number;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  expectedSizeBytes: number | null;
  expectedChecksumSha256: string | null;
  deliveredPath: string | null;
  deliveredSizeBytes: number | null;
  deliveredChecksumSha256: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type GroupMessageType =
  | "user_task"
  | "stage_output_to_test"
  | "test_pass_to_next_agent"
  | "test_fail_to_previous_agent"
  | "test_failed_waiting_for_user"
  | "pipeline_handoff"
  | "main_dispatch"
  | "discussion_handoff"
  | "final_test_pass"
  | "final_test_failed_waiting_for_user"
  | "final_output";

export type GroupMessageRecord = {
  id: string;
  jobId: string;
  stageId: string | null;
  senderAgentId: string;
  mentionAgentId: string | null;
  messageType: GroupMessageType;
  content: string;
  artifactId: string | null;
  feishuMessageId: string | null;
  createdAt: string;
};

export type OutboundMessage = {
  groupMessageId: string;
  jobId: string;
  stageId: string | null;
  ingressOrigin: IngressOrigin;
  senderAgentId: string;
  mentionAgentId: string | null;
  messageType: GroupMessageType;
  content: string;
  artifactId: string | null;
  feishuChatId: string | null;
  feishuMessageId: string | null;
};

export type DeliveryResult =
  | {
      adapter: string;
      mode: "available";
      messageId: string;
    }
  | {
      adapter: string;
      mode: "dry_run";
      messageId: string;
      reason: string;
    }
  | {
      adapter: string;
      mode: "sent";
      messageId: string;
      externalMessageId: string;
    }
  | {
      adapter: string;
      mode: "skipped";
      messageId: string;
      reason: string;
    };

export type EgressContext = {
  env: NodeJS.ProcessEnv;
};

export interface EgressAdapter {
  name: IngressOrigin;
  isEnabled(env: NodeJS.ProcessEnv): boolean;
  deliver(message: OutboundMessage, context: EgressContext): Promise<DeliveryResult>;
}

export interface IngressAdapter<App = unknown, Deps = unknown> {
  name: IngressOrigin;
  isEnabled(env: NodeJS.ProcessEnv): boolean;
  mount(app: App, deps: Deps): void;
}

export type AgentEventRecord = {
  id: string;
  sessionId: string;
  jobId: string;
  stageId: string | null;
  seq: number;
  actor: string;
  eventType: string;
  payload: Record<string, unknown>;
  artifactId: string | null;
  groupMessageId: string | null;
  feishuMessageId: string | null;
  createdAt: string;
};

export type StageRunResult = {
  attemptId: string;
  agentSessionId: string;
  outputArtifactId: string;
  outputPath: string;
  groupMessageId: string;
  summary: string;
};

export type TestReviewResult = {
  reviewId: string;
  testAgentSessionId: string;
  verdict: TestVerdict;
  issueCount: number;
  reportArtifactId: string;
  reportPath: string;
  groupMessageId: string;
};

export type FinalQualityGateResult = {
  reviewId: string;
  testAgentSessionId: string;
  verdict: TestVerdict;
  issueCount: number;
  reportArtifactId: string;
  reportPath: string;
  groupMessageId: string;
};

export type WorkspaceRegistrationRecord = {
  id: string;
  rootPath: string;
  rootPathKey: string;
  displayName: string | null;
  enabled: boolean;
  approvalId: string | null;
  registeredBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};
