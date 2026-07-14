import "dotenv/config";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { z } from "zod";
import {
  archiveJobSession,
  appendJobEvent,
  cancelJob,
  ConversationSourceMessageConflictError,
  ConversationSourceMessageNotFoundError,
  createJob,
  getJob,
  getJobByFeishuMessageId,
  getJobBySessionId,
  getJobHeartbeatSummary,
  InvalidJobListCursorError,
  listJobs,
  requestJobResume,
  scanStalledJobHeartbeats,
  restoreJobSession,
  setJobExecutionPreflight,
  setJobStatus
} from "../../../packages/db/src/jobs";
import {
  ConversationRecordConflictError,
  ConversationRecordDeletedError,
  deleteConversation,
  deleteConversationProject,
  getConversation,
  getConversationProject,
  getConversationWorkspaceSnapshot,
  listConversationMessages,
  listConversationProjects,
  listConversations,
  patchConversation,
  patchConversationMessage,
  patchConversationProject,
  syncConversationWorkspaceSnapshot,
  upsertConversation,
  upsertConversationMessage,
  upsertConversationProject
} from "../../../packages/db/src/conversations";
import {
  consumeToolApproval,
  createToolApprovalRequest,
  decideToolApproval,
  expirePendingToolApprovals,
  getToolApproval,
  listToolApprovals
} from "../../../packages/db/src/approvals";
import {
  getModelCallForJobById,
  listUnknownOutcomeModelCallsForJob,
  markModelCallFailedUnknownOutcome,
  reconcileModelCallAsFailed,
  reconcileModelCallAsSucceeded,
  recordModelCallReconciliation,
  type ModelCallRecord
} from "../../../packages/db/src/model-calls";
import { getModelCallQueueOverview } from "../../../packages/db/src/model-call-queue";
import {
  claimModelCallSpendDispatch,
  getJobSpendBudget,
  listModelCallSpendForJob,
  markModelCallSpendOutcomeUnknown,
  releaseModelCallSpendByIdempotency,
  reserveStandaloneModelSpend,
  settleModelCallSpendByIdempotency
} from "../../../packages/db/src/model-call-spend";
import {
  listExperiences,
  recordExperienceRecall,
  setExperienceStatus
} from "../../../packages/db/src/experience";
import {
  getArtifactForJob,
  getGroupMessagesForJob,
  getJobDetails,
  getJobTimeline,
  InvalidTimelineCursorError,
  listArtifactsForJob
} from "../../../packages/db/src/pipeline";
import {
  claimArtifactDelivery,
  claimJobArtifactDeliveryFinalization,
  completeArtifactDelivery,
  failArtifactDelivery,
  getArtifactDeliverySummary,
  getArtifactFileForJob,
  listArtifactDeliveriesForJob,
  listArtifactFilesForJob
} from "../../../packages/db/src/artifact-deliveries";
import {
  createPlanForJob,
  createPlanItem,
  getPlan,
  listPlans,
  updatePlan,
  updatePlanItem
} from "../../../packages/db/src/plans";
import {
  compressSession,
  getRuntimeUsage,
  getSessionEvents,
  getSessionEventsAfter,
  listRuntimeLogs,
  listSessions
} from "../../../packages/db/src/runtime";
import {
  ensureDefaultAgentConfigs,
  getAgentConfig,
  getModelProvider,
  listAgentConfigs,
  listModelProviders,
  patchAgentConfig,
  patchModelProvider,
  seedDefaultAgentConfigs,
  upsertAgentConfig,
  upsertModelProvider
} from "../../../packages/db/src/config-registry";
import {
  getArtifactDestinationGrant,
  listArtifactDestinationGrants,
  revokeArtifactDestinationGrant,
  upsertArtifactDestinationGrant
} from "../../../packages/db/src/artifact-destination-grants";
import {
  getRegisteredWorkspace,
  getRegisteredWorkspaceByRootKey,
  listRegisteredWorkspaces,
  markRegisteredWorkspaceUsed,
  revokeRegisteredWorkspace,
  upsertRegisteredWorkspace
} from "../../../packages/db/src/workspace-registry";
import {
  getAgentMcpPolicyFor,
  getMcpServer,
  isAgentMcpPolicyAllowed,
  listAgentMcpPolicies,
  listMcpServers,
  listSkills,
  patchAgentMcpPolicy,
  patchMcpServer,
  patchSkill,
  upsertAgentMcpPolicy,
  upsertMcpServer,
  upsertSkill
} from "../../../packages/db/src/tool-registry";
import {
  getScheduledTask,
  listDueScheduledTasks,
  listScheduledTasks,
  markScheduledTaskTriggered,
  patchScheduledTask,
  upsertScheduledTask
} from "../../../packages/db/src/schedules";
import {
  formatWorkspaceCommand,
  getWorkspaceGitStatus,
  inspectWorkspace,
  listWorkspaceFiles,
  prepareWorkspaceFileWrite,
  readWorkspaceFile,
  resolveWorkspaceDirectoryTarget,
  runWorkspaceCommand,
  writeWorkspaceFile,
  WorkspacePathError
} from "./workspaces";
import {
  normalizeWorkspaceRegistrationTarget,
  normalizeWorkspaceRootPath,
  workspaceApprovalTarget,
  workspaceRootKey
} from "./workspace-security";
import {
  buildWebSearchUrl,
  formatBrowserSnapshotCommand,
  formatWebFetchCommand,
  formatWebSearchCommand,
  normalizeWebFetchUrl,
  runBrowserSnapshot,
  runWebFetch,
  runWebSearch,
  WebFetchError
} from "./web-tools";
import {
  ArtifactDestinationPathError,
  artifactDestinationApprovalTarget,
  artifactDestinationRootKey,
  normalizeArtifactDestinationApprovalTarget,
  normalizeArtifactDestinationRootPath
} from "../../../packages/shared/src/artifact-destination-policy";
import {
  EXPERIENCE_STATUSES,
  INGRESS_ORIGINS,
  JOB_STATUSES,
  MCP_SERVER_STATUSES,
  PROVIDER_VERIFICATION_STATUSES,
  ROUTING_MODES,
  AGENT_SYNC_STATUSES,
  CONVERSATION_MESSAGE_ROLES,
  CONVERSATION_MESSAGE_STATUSES,
  SCHEDULE_TASK_STATUSES,
  SCHEDULE_TYPES,
  TASK_PLAN_ITEM_STATUSES,
  TASK_PLAN_STATUSES,
  TOOL_APPROVAL_STATUSES,
  TOOL_RISK_LEVELS,
  type AgentConfigRecord,
  type ArtifactDeliveryRecord,
  type ArtifactFileRecord,
  type ExperienceRecord,
  type ExperienceStatus,
  type ModelProviderRecord,
  type ToolApprovalRecord
} from "../../../packages/shared/src/types";
import { buildPanelAgentPromptFiles } from "../../../packages/shared/src/panel-agent-prompt-designer";
import {
  formatPanelPromptSnapshot,
  loadPanelPromptSnapshot,
  type PanelPromptSnapshot
} from "./panel-prompt-context";
import {
  buildDeterministicPanelResult,
  panelOrchestrationJsonInstruction,
  parsePanelOrchestrationOutput
} from "../../../packages/shared/src/orchestration-contract";
import {
  selectAgentModelVerificationKind,
  type AgentModelVerificationKind
} from "../../../packages/shared/src/agent-model-kind";
import {
  normalizeOpenClawAgentRunner,
  resolveOpenClawAgentRunner
} from "../../../packages/shared/src/openclaw-runner";
import {
  parseProviderUnknownOutcomePolicy,
  type ModelCallReconciliationState,
  type ModelCallReconciliationStatus
} from "../../../packages/shared/src/model-reconciliation";
import {
  cancelJobWorkflow,
  launchDbos,
  startJobWorkflow
} from "../../dbos-worker/src/dbos-runtime";
import { ingressAdapters } from "./adapters";
import { getRuntimeCapabilities } from "./capabilities";
import { discoverOpenClawRuntime } from "./openclaw-runtime";
import {
  getOpenClawRuntimeControlStatus,
  runOpenClawRuntimeCommand,
  type OpenClawRuntimeAction
} from "./openclaw-runtime-control";
import {
  applyOpenClawSyncPlan,
  buildOpenClawSyncPlan,
  OpenClawSyncSafetyError,
  validateOpenClawSync
} from "./openclaw-sync";
import {
  fingerprintSecret,
  getProviderApiKeyStatus,
  readProviderApiKey,
  saveProviderApiKey
} from "../../../packages/runtime/src/local-secrets";
import { preflightTaskExecution } from "../../../packages/runtime/src/task-preflight";
import {
  verifyOpenAiCompatibleImageGenerationProvider,
  verifyOpenAiCompatibleProvider,
  verifyOpenAiCompatibleVideoGenerationProvider,
  type ProviderVerificationResult
} from "./provider-verification";
import {
  inferOpenAiCompatibleProviderForModel
} from "./provider-inference";
import {
  withLiveProviderSecretStatus,
  withLiveProviderSecretStatuses
} from "./provider-secret-status";
import { checkMcpCommand } from "./mcp-diagnostics";
import { requireApiToken, timingSafeEqualString } from "./api-auth";
import {
  evaluateAgentNetworkPolicy,
  type AgentNetworkOperation
} from "./network-policy";
import {
  formatMcpListCommand,
  formatMcpListTarget,
  formatMcpToolCommand,
  formatMcpToolTarget,
  McpToolError,
  runMcpResourcesList,
  runMcpToolCall,
  runMcpToolsList
} from "./mcp-tools";
import { closeAllMcpSessions, invalidateMcpSession } from "./mcp-sessions";
import { closePool } from "../../../packages/db/src/pool";
import { getRuntimeDiagnostics } from "./runtime-diagnostics";
import {
  listRuntimeRepairActions,
  RUNTIME_REPAIR_ACTION_IDS,
  runRuntimeRepairAction
} from "./runtime-repair";
import { extractArtifactFileRefs, resolveArtifactFilePath } from "./artifact-files";
import {
  queryProviderUnknownOutcome,
  recoverProviderMediaArtifacts,
  type ProviderReconciliationResult
} from "./model-call-reconciliation";

const unstickModelCallSchema = z.object({
  jobId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  reason: z.string().optional(),
  restartWorkflow: z.boolean().optional().default(false)
});

const reconcileUnknownOutcomeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("query_provider")
  }),
  z.object({
    action: z.literal("keep_waiting"),
    reason: z.string().trim().min(1).max(500).optional()
  }),
  z.object({
    action: z.literal("confirm_not_accepted"),
    reason: z.string().trim().min(3).max(500)
  }),
  z.object({
    action: z.literal("confirm_failed"),
    reason: z.string().trim().min(3).max(500)
  }),
  z.object({
    action: z.literal("confirm_succeeded"),
    recoveredText: z.string().trim().min(1).max(200_000),
    reason: z.string().trim().min(3).max(500).optional()
  })
]);

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(2000).optional()
});

const runtimeLogsQuerySchema = z.object({
  source: z.enum(["job_event", "agent_event", "model_call"]).optional(),
  jobId: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(300).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

const runtimeUsageQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional()
});

const artifactFileIndexSchema = z.coerce.number().int().min(0).max(10000);
const artifactDeliveryClaimSchema = z.object({
  leaseSeconds: z.number().int().min(30).max(1800).optional()
});
const artifactDeliveryCompleteSchema = z.object({
  claimToken: z.string().uuid(),
  deliveredPath: z.string().trim().min(1).max(2000),
  deliveredSizeBytes: z.number().int().min(0).max(2_000_000_000),
  deliveredChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional()
});
const artifactDeliveryFailSchema = z.object({
  claimToken: z.string().uuid(),
  error: z.string().trim().min(1).max(1000)
});

const jobHeartbeatQuerySchema = z.object({
  timeoutSeconds: z.coerce.number().int().min(10).max(86400).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const jobHeartbeatScanSchema = z.object({
  timeoutSeconds: z.number().int().min(10).max(86400).optional(),
  limit: z.number().int().min(1).max(500).optional()
});

const runtimeDiagnosticsQuerySchema = z.object({
  openClawRootPath: z.string().trim().min(1).max(2000).optional()
});

const runtimeRepairSchema = z.object({
  action: z.enum(RUNTIME_REPAIR_ACTION_IDS),
  rootPath: z.string().trim().min(1).max(2000).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  providerId: z.string().trim().min(1).max(160).nullable().optional(),
  model: z.string().trim().min(1).max(300).nullable().optional(),
  panelAgentName: z.string().trim().min(1).max(200).optional(),
  allowDiscoveredUserRuntime: z.boolean().optional()
});

const openClawRuntimeQuerySchema = z.object({
  rootPath: z.string().trim().min(1).max(2000).optional()
});

const openClawSyncSchema = z.object({
  rootPath: z.string().trim().min(1).max(2000).optional(),
  allowDiscoveredUserRuntime: z.boolean().optional()
});

const openClawRuntimeActionSchema = z.object({
  action: z.enum(["status", "start", "restart", "stop"])
});

const openClawRuntimeCommandSchema = z.object({
  rootPath: z.string().trim().min(1).max(2000).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional()
});

const providerSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  displayName: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().url().max(1000),
  defaultModel: z.string().trim().min(1).max(300).nullable().optional(),
  apiKey: z.string().min(1).max(10000).optional(),
  verify: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
});

const patchProviderSchema = providerSchema.partial().extend({
  verificationStatus: z.enum(PROVIDER_VERIFICATION_STATUSES).optional(),
  lastError: z.string().trim().max(1000).nullable().optional()
});

const verifyProviderSchema = z.object({
  apiKey: z.string().min(1).max(10000).optional(),
  model: z.string().trim().min(1).max(300).optional()
});

const verifyProvidersBatchSchema = z.object({
  providerIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  providers: z.array(z.object({
    providerId: z.string().trim().min(1).max(160),
    apiKey: z.string().min(1).max(10000).optional(),
    model: z.string().trim().min(1).max(300).optional()
  })).max(50).optional(),
  timeoutMs: z.number().int().min(500).max(60000).optional()
});

const agentConfigSchema = z.object({
  id: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(200),
  agentRole: z.string().trim().min(1).max(120),
  required: z.boolean().optional(),
  enabled: z.boolean().optional(),
  providerId: z.string().trim().min(1).max(160).nullable().optional(),
  model: z.string().trim().min(1).max(300).nullable().optional(),
  apiKeyConfigured: z.boolean().optional(),
  workspacePath: z.string().trim().min(1).max(2000).nullable().optional(),
  promptTemplatePath: z.string().trim().min(1).max(2000).nullable().optional(),
  tools: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  openclawSyncStatus: z.enum(AGENT_SYNC_STATUSES).optional(),
  openclawAgentPath: z.string().trim().min(1).max(2000).nullable().optional(),
  lastError: z.string().trim().max(1000).nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});

const patchAgentConfigSchema = agentConfigSchema.partial().omit({ id: true });

const seedDefaultAgentsSchema = z.object({
  panelAgentName: z.string().trim().min(1).max(200).optional(),
  providerId: z.string().trim().min(1).max(160).nullable().optional(),
  model: z.string().trim().min(1).max(300).nullable().optional()
});

const agentModelConfigSchema = z.object({
  model: z.string().trim().min(1).max(300),
  apiKey: z.string().min(1).max(10000).optional(),
  providerId: z.string().trim().min(1).max(160).optional(),
  openClawRootPath: z.string().trim().min(1).max(2000).optional(),
  allowDiscoveredUserRuntime: z.boolean().optional()
});

const panelChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  body: z.string().trim().min(1).max(12000)
});

const panelChatSchema = z.object({
  message: z.string().trim().min(1).max(12000),
  messages: z.array(panelChatMessageSchema).max(30).optional(),
  supervisorName: z.string().trim().min(1).max(200).optional(),
  projectPath: z.string().trim().max(2000).optional(),
  projectName: z.string().trim().max(300).optional(),
  latestJobId: z.string().trim().max(160).optional(),
  sourceMessageId: z.string().trim().min(1).max(200).optional(),
  requesterId: z.string().trim().min(1).max(200).optional(),
  maxModelCalls: z.number().int().min(1).max(100).optional(),
  outputStyle: z.enum(["concise", "detailed", "warm", "formal"]).optional(),
  language: z.enum(["en", "zh"]).optional()
});

const modelCallQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional()
});

const conversationIdSchema = z.string().trim().min(1).max(200);
const conversationTimestampSchema = z.string().datetime({ offset: true });
const conversationMetadataSchema = z.record(z.unknown()).default({});
const conversationAttachmentSchema = z.object({
  id: conversationIdSchema,
  name: z.string().trim().min(1).max(500),
  path: z.string().trim().min(1).max(4000),
  addedAt: conversationTimestampSchema
});
const conversationMessageSnapshotSchema = z.object({
  id: conversationIdSchema,
  conversationId: conversationIdSchema.optional(),
  role: z.enum(CONVERSATION_MESSAGE_ROLES),
  body: z.string().max(100_000),
  status: z.enum(CONVERSATION_MESSAGE_STATUSES).default("sent"),
  jobId: z.string().trim().min(1).max(200).nullable().optional(),
  attachments: z.array(conversationAttachmentSchema).max(100).default([]),
  metadata: conversationMetadataSchema,
  createdAt: conversationTimestampSchema,
  updatedAt: conversationTimestampSchema
});
const conversationSnapshotSchema = z.object({
  id: conversationIdSchema,
  projectId: conversationIdSchema.optional(),
  title: z.string().trim().min(1).max(500),
  draft: z.string().max(100_000).default(""),
  attachments: z.array(conversationAttachmentSchema).max(100).default([]),
  pinned: z.boolean().default(false),
  unread: z.boolean().default(false),
  archivedAt: conversationTimestampSchema.nullable().default(null),
  metadata: conversationMetadataSchema,
  createdAt: conversationTimestampSchema,
  updatedAt: conversationTimestampSchema,
  messages: z.array(conversationMessageSnapshotSchema).max(10_000).default([])
});
const conversationProjectSnapshotSchema = z.object({
  id: conversationIdSchema,
  name: z.string().trim().min(1).max(300),
  workspacePath: z.string().trim().max(4000).nullable().default(null),
  pinned: z.boolean().default(false),
  archivedAt: conversationTimestampSchema.nullable().default(null),
  metadata: conversationMetadataSchema,
  createdAt: conversationTimestampSchema,
  updatedAt: conversationTimestampSchema,
  conversations: z.array(conversationSnapshotSchema).max(2000).default([])
});
const conversationWorkspaceSnapshotSchema = z.object({
  projects: z.array(conversationProjectSnapshotSchema).max(1000),
  generatedAt: conversationTimestampSchema.optional().default(() => new Date().toISOString())
});
const listConversationRecordsSchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
});
const createConversationProjectSchema = z.object({
  id: conversationIdSchema.optional(),
  name: z.string().trim().min(1).max(300),
  workspacePath: z.string().trim().max(4000).nullable().optional(),
  pinned: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
});
const patchConversationProjectSchema = createConversationProjectSchema
  .omit({ id: true })
  .partial()
  .extend({ archivedAt: conversationTimestampSchema.nullable().optional() })
  .refine((input) => Object.keys(input).length > 0, "at least one field is required");
const createConversationSchema = z.object({
  id: conversationIdSchema.optional(),
  title: z.string().trim().min(1).max(500),
  draft: z.string().max(100_000).optional(),
  attachments: z.array(conversationAttachmentSchema).max(100).optional(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
});
const patchConversationSchema = createConversationSchema
  .omit({ id: true })
  .partial()
  .extend({ archivedAt: conversationTimestampSchema.nullable().optional() })
  .refine((input) => Object.keys(input).length > 0, "at least one field is required");
const createConversationMessageSchema = z.object({
  id: conversationIdSchema.optional(),
  role: z.enum(CONVERSATION_MESSAGE_ROLES),
  body: z.string().max(100_000),
  status: z.enum(CONVERSATION_MESSAGE_STATUSES).optional(),
  jobId: z.string().trim().min(1).max(200).nullable().optional(),
  attachments: z.array(conversationAttachmentSchema).max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: conversationTimestampSchema.optional(),
  updatedAt: conversationTimestampSchema.optional()
});
const patchConversationMessageSchema = z
  .object({
    status: z.enum(CONVERSATION_MESSAGE_STATUSES).optional(),
    jobId: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .refine((input) => Object.keys(input).length > 0, "at least one field is required");
const listConversationMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional()
});

type PanelChatInput = z.infer<typeof panelChatSchema>;

function routeParameter(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

const panelPromptPersonalizationSchema = z.object({
  supervisorName: z.string().trim().min(1).max(200),
  provider: z.object({
    providerName: z.string().trim().max(200).optional(),
    baseUrl: z.string().trim().max(2000).optional(),
    model: z.string().trim().max(300).optional()
  }).default({}),
  interview: z.object({
    industry: z.string().trim().min(1).max(500),
    role: z.string().trim().min(1).max(500),
    dailyWork: z.string().trim().min(1).max(4000),
    outputs: z.string().trim().max(4000).optional(),
    audience: z.string().trim().max(4000).optional(),
    qualityBar: z.string().trim().min(1).max(4000),
    workPressure: z.string().trim().max(4000).optional(),
    outputStyle: z.enum(["concise", "detailed", "warm", "formal"]).optional()
  }),
  profile: z.object({
    summary: z.string().trim().min(1).max(8000),
    stageAgents: z.array(z.string().trim().min(1).max(160)).min(1).max(20),
    recommendedRoutingMode: z.enum(ROUTING_MODES),
    outputStyle: z.enum(["concise", "detailed", "warm", "formal"]).optional()
  }),
  panelAgentId: z.string().trim().min(1).max(160).optional(),
  childAgentIds: z.array(z.string().trim().min(1).max(160)).min(1).max(20).optional()
});

type PanelPromptPersonalizationInput = z.infer<typeof panelPromptPersonalizationSchema>;

type PanelChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const skillSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  source: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.unknown()).optional(),
  diagnostics: z.record(z.unknown()).optional()
});

const patchSkillSchema = skillSchema.partial();

const mcpServerSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(200),
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(2000)).max(100).optional(),
  envKeys: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(MCP_SERVER_STATUSES).optional(),
  lastError: z.string().trim().max(1000).nullable().optional(),
  config: z.record(z.unknown()).optional()
});

const patchMcpServerSchema = mcpServerSchema.partial();

const mcpToolCallSchema = z.object({
  toolName: z.string().trim().min(1).max(200),
  arguments: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  maxOutputBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  approvalId: z.string().trim().min(1).max(200)
});

const mcpListSchema = z.object({
  cursor: z.string().trim().min(1).max(2000).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  maxOutputBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  approvalId: z.string().trim().min(1).max(200)
});

const mcpPolicyQuerySchema = z.object({
  agentId: z.string().trim().min(1).max(160).optional(),
  serverId: z.string().trim().min(1).max(160).optional()
});

const mcpPolicySchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  agentId: z.string().trim().min(1).max(160),
  serverId: z.string().trim().min(1).max(160),
  enabled: z.boolean().optional(),
  allowToolsList: z.boolean().optional(),
  allowResourcesList: z.boolean().optional(),
  allowAllTools: z.boolean().optional(),
  allowedTools: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  metadata: z.record(z.unknown()).optional()
});

const patchMcpPolicySchema = mcpPolicySchema.partial().omit({
  id: true,
  agentId: true,
  serverId: true
});

const scheduleBaseSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(8000),
  scheduleType: z.enum(SCHEDULE_TYPES).optional(),
  enabled: z.boolean().optional(),
  workspacePath: z.string().trim().min(1).max(2000).nullable().optional(),
  routingMode: z.enum(ROUTING_MODES).optional(),
  maxModelCalls: z.number().int().min(1).max(100).optional(),
  providerId: z.string().trim().min(1).max(160).nullable().optional(),
  agentId: z.string().trim().min(1).max(160).nullable().optional(),
  runAt: z.string().datetime({ offset: true }).nullable().optional(),
  intervalSeconds: z.number().int().min(60).max(60 * 60 * 24 * 365).nullable().optional(),
  nextRunAt: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(SCHEDULE_TASK_STATUSES).optional(),
  lastError: z.string().trim().max(1000).nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});

const scheduleSchema = scheduleBaseSchema.superRefine((value, context) => {
  if (value.scheduleType === "once" && !value.runAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "runAt_required_for_once_schedule",
      path: ["runAt"]
    });
  }
  if (value.scheduleType === "interval" && !value.intervalSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "intervalSeconds_required_for_interval_schedule",
      path: ["intervalSeconds"]
    });
  }
});

const patchScheduleSchema = scheduleBaseSchema.partial();

const listSchedulesQuerySchema = z.object({
  status: z.enum(SCHEDULE_TASK_STATUSES).optional(),
  enabled: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const dueSchedulesQuerySchema = z.object({
  now: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const triggerScheduleSchema = z.object({
  startWorkflow: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
  requesterId: z.string().trim().min(1).max(200).optional()
});

const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  prompt: z.string().trim().min(1).max(300).optional()
});

const sessionEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional()
});

const sessionEventsStreamQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  pollMs: z.coerce.number().int().min(250).max(10000).optional(),
  heartbeatMs: z.coerce.number().int().min(5000).max(60000).optional()
});

const archiveSessionSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional(),
  reason: z.string().max(500).optional(),
  requesterId: z.string().max(200).optional()
});

const restoreSessionSchema = z.object({
  reason: z.string().max(500).optional(),
  requesterId: z.string().max(200).optional()
});

const forkSessionSchema = z.object({
  prompt: z.string().min(1).optional(),
  inheritWorkdir: z.boolean().optional().default(true),
  startWorkflow: z.boolean().optional().default(true),
  routingMode: z.enum(ROUTING_MODES).optional(),
  maxModelCalls: z.number().int().min(1).max(100).optional(),
  maxCostUsd: z.number().min(0).max(1_000_000).optional(),
  classicFinalGateEnabled: z.boolean().optional(),
  discussionRounds: z.number().int().min(1).max(10).optional(),
  requesterId: z.string().max(200).optional()
});

const compressSessionSchema = z.object({
  maxEvents: z.number().int().min(10).max(300).optional(),
  reason: z.string().max(500).optional()
});

const listPlansQuerySchema = z.object({
  jobId: z.string().trim().min(1).max(200).optional(),
  status: z.enum(TASK_PLAN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const createJobPlanSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(2000).optional(),
  source: z.string().trim().min(1).max(80).optional(),
  sourceArtifactId: z.string().trim().min(1).max(240).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  syncItems: z.boolean().optional()
});

const updatePlanSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(TASK_PLAN_STATUSES).optional(),
  metadata: z.record(z.unknown()).optional()
});

const createPlanItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(4000).nullable().optional(),
  status: z.enum(TASK_PLAN_ITEM_STATUSES).optional(),
  agentId: z.string().trim().min(1).max(200).nullable().optional(),
  stageId: z.string().trim().min(1).max(240).nullable().optional(),
  artifactId: z.string().trim().min(1).max(240).nullable().optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  metadata: z.record(z.unknown()).optional()
});

const updatePlanItemSchema = createPlanItemSchema.partial().extend({
  title: z.string().trim().min(1).max(300).optional()
});

const workspaceRootQuerySchema = z.object({
  rootPath: z.string().trim().min(1).max(2000)
});

const listRegisteredWorkspacesQuerySchema = z.object({
  enabled: z.coerce.boolean().optional()
});

const workspaceRegisterSchema = z.object({
  rootPath: z.string().trim().min(1).max(2000),
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  approvalId: z.string().trim().min(1).max(200),
  registeredBy: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional()
});

const artifactDestinationGrantListSchema = z.object({
  enabled: z.coerce.boolean().optional()
});

const artifactDestinationGrantSchema = z.object({
  rootPath: z.string().trim().min(1).max(2000),
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  approvalId: z.string().trim().min(1).max(200),
  grantedBy: z.string().trim().min(1).max(200).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});

const destinationAuthorizationRevokeSchema = z.object({
  revokedBy: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().max(1000).nullable().optional()
});

const workspaceFilesQuerySchema = workspaceRootQuerySchema.extend({
  subpath: z.string().trim().max(2000).optional(),
  depth: z.coerce.number().int().min(0).max(8).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  includeHidden: z.coerce.boolean().optional()
});

const workspaceFileQuerySchema = workspaceRootQuerySchema.extend({
  subpath: z.string().trim().min(1).max(2000),
  maxBytes: z.coerce.number().int().min(1).max(1024 * 1024).optional()
});

const workspaceWriteFileSchema = z.object({
  rootPath: z.string().trim().min(1).max(2000),
  subpath: z.string().trim().min(1).max(2000),
  content: z.string().max(1024 * 1024),
  mode: z.enum(["create", "overwrite", "append"]).optional(),
  createParents: z.boolean().optional(),
  approvalId: z.string().trim().min(1).max(200)
});

const workspaceCommandRunSchema = z.object({
  rootPath: z.string().trim().min(1).max(2000),
  cwdSubpath: z.string().trim().max(2000).optional(),
  command: z.string().trim().min(1).max(200),
  args: z.array(z.string().max(2000)).max(80).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
  maxOutputBytes: z.number().int().min(1).max(256 * 1024).optional(),
  approvalId: z.string().trim().min(1).max(200)
});

const webFetchRunSchema = z.object({
  url: z.string().trim().url().max(4000),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  approvalId: z.string().trim().min(1).max(200)
});

const webSearchRunSchema = z.object({
  query: z.string().trim().min(1).max(500),
  endpointUrl: z.string().trim().url().max(4000).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  approvalId: z.string().trim().min(1).max(200)
});

const browserSnapshotRunSchema = z.object({
  url: z.string().trim().url().max(4000),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  maxLinks: z.number().int().min(0).max(100).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  approvalId: z.string().trim().min(1).max(200)
});

const listApprovalsQuerySchema = z.object({
  status: z.enum(TOOL_APPROVAL_STATUSES).optional(),
  jobId: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(300).optional(),
  agentId: z.string().trim().min(1).max(200).optional(),
  riskLevel: z.enum(TOOL_RISK_LEVELS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const createApprovalSchema = z.object({
  jobId: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(300).optional(),
  stageId: z.string().trim().min(1).max(240).nullable().optional(),
  agentId: z.string().trim().min(1).max(200),
  requesterActor: z.string().trim().min(1).max(200).optional(),
  toolName: z.string().trim().min(1).max(200),
  actionType: z.string().trim().min(1).max(200),
  riskLevel: z.enum(TOOL_RISK_LEVELS).optional(),
  reason: z.string().trim().max(2000).nullable().optional(),
  command: z.string().trim().max(4000).nullable().optional(),
  target: z.string().trim().max(2000).nullable().optional(),
  input: z.record(z.unknown()).optional(),
  policy: z.record(z.unknown()).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional()
}).refine((value) => Boolean(value.jobId || value.sessionId), {
  message: "jobId_or_sessionId_required"
});

const decideApprovalSchema = z.object({
  decidedBy: z.string().trim().min(1).max(200).optional(),
  decisionReason: z.string().trim().max(2000).nullable().optional()
});

const consumeApprovalSchema = z.object({
  consumedBy: z.string().trim().min(1).max(200).optional()
});

const WORKSPACE_WRITE_TOOL_NAMES = new Set(["workspace.writeFile", "workspace.write"]);
const WORKSPACE_WRITE_ACTION_TYPES = new Set(["file_write", "workspace_file_write"]);
const WORKSPACE_REGISTER_TOOL_NAMES = new Set(["workspace.register", "workspace.addRoot"]);
const WORKSPACE_REGISTER_ACTION_TYPES = new Set(["workspace_register", "workspace_root_register"]);
const ARTIFACT_DESTINATION_GRANT_TOOL_NAMES = new Set([
  "artifact.delivery.grantDestination",
  "artifact.destination.grant"
]);
const ARTIFACT_DESTINATION_GRANT_ACTION_TYPES = new Set([
  "artifact_destination_grant",
  "artifact_delivery_destination_grant"
]);
const WORKSPACE_COMMAND_TOOL_NAMES = new Set([
  "workspace.runCommand",
  "workspace.command",
  "workspace.shell"
]);
const WORKSPACE_COMMAND_ACTION_TYPES = new Set([
  "command_execute",
  "workspace_command_execute"
]);
const WEB_FETCH_TOOL_NAMES = new Set(["web.fetch", "network.fetch", "http.fetch"]);
const WEB_FETCH_ACTION_TYPES = new Set(["web_fetch", "network_fetch", "http_get"]);
const WEB_SEARCH_TOOL_NAMES = new Set(["web.search", "network.search", "search.web"]);
const WEB_SEARCH_ACTION_TYPES = new Set(["web_search", "network_search", "search_query"]);
const BROWSER_SNAPSHOT_TOOL_NAMES = new Set(["browser.snapshot", "browser.fetch", "web.snapshot"]);
const BROWSER_SNAPSHOT_ACTION_TYPES = new Set(["browser_snapshot", "browser_fetch", "web_snapshot"]);
const MCP_TOOL_CALL_TOOL_NAMES = new Set(["mcp.call", "mcp.toolCall", "mcp.tools/call"]);
const MCP_TOOL_CALL_ACTION_TYPES = new Set(["mcp_call", "mcp_tool_call", "mcp_tools_call"]);
const MCP_LIST_TOOL_NAMES = new Set(["mcp.list", "mcp.tools/list", "mcp.resources/list"]);
const MCP_LIST_ACTION_TYPES = new Set(["mcp_list", "mcp_tools_list", "mcp_resources_list"]);

function normalizeApprovalTarget(target: string | null) {
  if (!target) {
    return null;
  }
  return target.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function normalizeApprovalCommand(command: string | null) {
  return command?.trim() || null;
}

async function requireRegisteredWorkspaceRoot(rootPath: string, response: express.Response) {
  const rootPathKey = workspaceRootKey(rootPath);
  const workspace = await getRegisteredWorkspaceByRootKey(rootPathKey);
  if (!workspace?.enabled) {
    response.status(403).json({
      error: "workspace_not_registered",
      rootPath: normalizeWorkspaceRootPath(rootPath),
      rootPathKey,
      registerTarget: workspaceApprovalTarget(rootPathKey)
    });
    return null;
  }

  await markRegisteredWorkspaceUsed(rootPathKey);
  return workspace.rootPath;
}

function approvalFlag(value: Record<string, unknown> | null | undefined, key: string) {
  return value?.[key] === true;
}

function previewJson(value: unknown, maxLength = 4000) {
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

async function requireAgentNetworkPolicy(input: {
  approval: ToolApprovalRecord;
  operation: AgentNetworkOperation;
  url: string;
  allowPrivateNetwork: boolean;
  response: express.Response;
}) {
  const agent = await getAgentConfig(input.approval.agentId);
  const decision = evaluateAgentNetworkPolicy({
    agent,
    operation: input.operation,
    url: input.url,
    allowPrivateNetwork: input.allowPrivateNetwork
  });

  if (decision.allowed) {
    return true;
  }

  await appendJobEvent(
    input.approval.jobId,
    "tool.network_policy_denied",
    {
      approvalId: input.approval.id,
      agentId: input.approval.agentId,
      operation: input.operation,
      target: input.url,
      reason: decision.reason,
      policySource: decision.policySource,
      policy: decision.policy
    },
    {
      actor: "network-policy",
      stageId: input.approval.stageId
    }
  );

  input.response.status(403).json({
    error: "network_policy_denied",
    decision
  });
  return false;
}

function mcpDiscoveryConfigEntry(result: unknown) {
  const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const tools = Array.isArray(value.tools) ? value.tools : undefined;
  const resources = Array.isArray(value.resources) ? value.resources : undefined;
  return {
    checkedAt: new Date().toISOString(),
    count: tools?.length ?? resources?.length ?? null,
    result
  };
}

async function requireMcpPolicy(input: {
  agentId: string;
  serverId: string;
  operation: "tools/list" | "resources/list" | "tools/call";
  toolName?: string;
}) {
  const policy = await getAgentMcpPolicyFor({
    agentId: input.agentId,
    serverId: input.serverId
  });
  if (!policy) {
    throw new McpToolError("mcp_policy_denied", "Agent is not allowed to use this MCP operation.", {
      agentId: input.agentId,
      serverId: input.serverId,
      operation: input.operation,
      toolName: input.toolName ?? null,
      policyId: null
    });
  }
  if (!isAgentMcpPolicyAllowed(policy, input)) {
    throw new McpToolError("mcp_policy_denied", "Agent is not allowed to use this MCP operation.", {
      agentId: input.agentId,
      serverId: input.serverId,
      operation: input.operation,
      toolName: input.toolName ?? null,
      policyId: policy?.id ?? null
    });
  }
  return policy;
}

function stableIdFromName(prefix: string, value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${prefix}-${slug || "default"}`;
}

function withProviderVerificationMetadata(
  metadata: Record<string, unknown> | null | undefined,
  verification: ProviderVerificationResult,
  model: string | null
) {
  return {
    ...(metadata ?? {}),
    verification: {
      checkedAt: verification.checkedAt,
      status: verification.status,
      ok: verification.ok,
      statusCode: verification.statusCode,
      latencyMs: verification.latencyMs,
      model,
      message: verification.message
    }
  };
}

function providerVerificationFailure(message: string): ProviderVerificationResult {
  return {
    ok: false,
    status: "failed",
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
    statusCode: null,
    message
  };
}

function agentRegistryId(agentId: string) {
  return agentId === "panel-supervisor-agent" ? "panel-agent" : agentId;
}

class PanelChatError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function chatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

async function safeProviderErrorMessage(response: Response) {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = await response.json() as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const remoteMessage =
      typeof body.error?.message === "string"
        ? body.error.message
        : typeof body.message === "string"
          ? body.message
          : null;
    if (remoteMessage) {
      message = `${message}: ${remoteMessage}`.slice(0, 500);
    }
  } catch {
    // Keep the status-only message. Provider bodies may contain noisy or sensitive data.
  }
  return message;
}

function extractPanelChatText(body: unknown) {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === "object"
    ? choices[0] as Record<string, unknown>
    : {};
  const message = firstChoice.message && typeof firstChoice.message === "object"
    ? firstChoice.message as Record<string, unknown>
    : {};
  const content = message.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        return "";
      })
      .filter(Boolean);
    if (parts.length) {
      return parts.join("\n").trim();
    }
  }
  const text = firstChoice.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function panelOutputStyleInstruction(style: PanelChatInput["outputStyle"]) {
  switch (style) {
    case "detailed":
      return "Preferred output style: detailed explanation. Explain reasoning, tradeoffs, and next steps clearly; use enough detail for the user to understand the decision.";
    case "warm":
      return "Preferred output style: warm and natural. Be reassuring and conversational while staying specific, useful, and honest.";
    case "formal":
      return "Preferred output style: formal and professional. Use polished wording, clear structure, and fewer casual phrases.";
    case "concise":
    default:
      return "Preferred output style: concise and direct. Answer the user's point first, keep paragraphs short, and avoid unnecessary explanation.";
  }
}

function buildPanelChatSystemPrompt(input: {
  chat: PanelChatInput;
  agent: AgentConfigRecord;
  provider: ModelProviderRecord;
  model: string;
  experiences: ExperienceRecord[];
  availableAgents: AgentConfigRecord[];
  promptSnapshot: PanelPromptSnapshot;
  latestTaskSummary: string;
}) {
  const agentName = input.chat.supervisorName?.trim() || input.agent.displayName || "Panel agent";
  const backendAgentMode = process.env.OPENCLAW_AGENT_MODE === "real" ? "real" : "mock";
  const configuredRunner = normalizeOpenClawAgentRunner(process.env.OPENCLAW_AGENT_RUNNER);
  const effectiveRunner = resolveOpenClawAgentRunner({ runner: configuredRunner });
  const languageInstruction = input.chat.language === "zh"
    ? "Reply in Chinese unless the user explicitly asks for another language."
    : "Reply in the user's language unless they explicitly ask for another language.";
  const adoptedExperiences = input.experiences.length
    ? input.experiences
      .map((experience, index) => {
        const key = [experience.kind, experience.scope, experience.scopeKey].filter(Boolean).join("/");
        const reuseScore = Math.max(experience.utilityScore - experience.decayScore, 0).toFixed(2);
        return `${index + 1}. ${key} | reuse=${reuseScore} | recalls=${experience.recallCount}: ${experience.summary}`;
      })
      .join("\n")
    : "No adopted long-term experience has been approved yet.";
  const availableAgentCatalog = input.availableAgents.length
    ? input.availableAgents
      .map((agent) => {
        const description = typeof agent.metadata.description === "string"
          ? agent.metadata.description
          : agent.tools.length
            ? `tools: ${agent.tools.join(", ")}`
            : "no additional capability description";
        return `${agent.id}: ${agent.displayName} (${agent.agentRole}) - ${description}`;
      })
      .join("\n")
    : "No enabled child agents are currently registered.";

  return [
    `You are ${agentName}, the Honeycomb panel agent.`,
    languageInstruction,
    "You answer panel conversations directly, help the user shape work, and coordinate tasks that Honeycomb may send to the agent team.",
    "If the user is chatting, answer normally. If the user is asking for task work, be concrete and mention any missing requirement only when it blocks execution.",
    "Before coordinating task work, classify the requested deliverable, choose the routing mode, and choose the minimal child-agent set dynamically. Configured agents are a capability pool, not a mandatory fixed pipeline.",
    "For still poster/image tasks, use writer-agent and/or image-agent as needed and skip video-agent. For video tasks, use video-agent and add writer-agent/image-agent only when script, captions, storyboard, cover, keyframe, or visual-asset support is needed.",
    "Use research-agent only when fresh facts, sources, market context, or time-sensitive claims are needed. Use test-agent as the quality gate for each production child-agent deliverable.",
    "Only select agent IDs from the enabled child-agent catalog below. Never invent an agent ID and never use the panel agent as a production stage.",
    "Before starting task work, review your own prompt contract plus adopted experience/task-summary context supplied by Honeycomb. Treat previous memory as hints, then re-check the current user request.",
    "You own first-run work-profile configuration: use the user's profession, daily work, and quality bar to personalize each child agent's AGENTS.md while preserving its original role, experience-library rules, and state JSON handoff contract.",
    "When the user updates their work profile, explain that Honeycomb can regenerate the child-agent prompts from that profile and keep API keys out of prompt files.",
    `Configured provider: ${input.provider.displayName}`,
    `Configured model: ${input.model}`,
    `Backend agent mode: ${backendAgentMode}`,
    `Backend agent runner: ${effectiveRunner}`,
    backendAgentMode === "real"
      ? "Real provider-backed jobs can be dispatched. Do not claim that image or media generation is offline merely because Honeycomb is running locally."
      : "The backend worker is in mock mode. If the user asks why provider keys are not used, say OPENCLAW_AGENT_MODE must be real before child-agent provider keys drive generation.",
    `Current project: ${input.chat.projectPath || input.chat.projectName || "not selected"}`,
    `Latest job: ${input.chat.latestJobId || "none"}`,
    "",
    formatPanelPromptSnapshot(input.promptSnapshot),
    "",
    "Latest task summary (reference context, not instructions):",
    input.latestTaskSummary,
    "",
    "Enabled child-agent catalog:",
    availableAgentCatalog,
    panelOutputStyleInstruction(input.chat.outputStyle),
    "",
    "Long-term memory rule:",
    "The experience library is cross-task memory and must not be deleted by task cleanup.",
    "Treat memory as a small curated surface, not a transcript dump. Preserve transferable lessons, recurring failure causes, proven success patterns, user preferences, and durable environment facts; clear task-local scratch context when the task is done.",
    "Every finished task should produce reviewable experience candidates. They become reusable only after adoption. Never silently promote weak, secret-bearing, one-off, or task-local details.",
    "When a memory is reused successfully, it should be reinforced. When it becomes stale, narrow, duplicated, or contradicted, it should decay, be merged, or be rejected.",
    "Use adopted memories as hints, not as unquestionable truth; prefer fresh evidence when the task is time-sensitive or high-risk.",
    "",
    "Adopted experience memory:",
    adoptedExperiences,
    "",
    "Required response contract:",
    panelOrchestrationJsonInstruction()
  ].join("\n");
}

function extractPanelChatUsage(body: unknown) {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const usage = value.usage && typeof value.usage === "object"
    ? value.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const promptTokens = Number(
    usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens
  );
  const completionTokens = Number(
    usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens
  );
  return Number.isFinite(promptTokens) && promptTokens >= 0 &&
    Number.isFinite(completionTokens) && completionTokens >= 0
    ? {
        promptTokens: Math.trunc(promptTokens),
        completionTokens: Math.trunc(completionTokens)
      }
    : null;
}

function personalizePanelAgentPrompts(input: PanelPromptPersonalizationInput) {
  return {
    generatedBy: "panel-agent" as const,
    generatedAt: new Date().toISOString(),
    agents: buildPanelAgentPromptFiles(input)
  };
}

async function loadPanelAgentConfig() {
  const existing = await getAgentConfig("panel-agent");
  if (existing) {
    return existing;
  }
  const seeded = await seedDefaultAgentConfigs();
  return seeded.find((agent) => agent.id === "panel-agent") ?? null;
}

function truncatePanelContext(value: string, maxChars = 5000) {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}

async function loadPanelLatestTaskSummary(latestJobId: string | null | undefined) {
  const jobId = latestJobId?.trim();
  if (!jobId) {
    return "No previous task is linked to this conversation.";
  }
  const job = await getJob(jobId);
  if (!job) {
    return `The linked task ${jobId} is no longer available.`;
  }
  const [finalArtifact, sessionSummary] = await Promise.all([
    getArtifactForJob(jobId, `${jobId}-ART-FINAL`),
    getArtifactForJob(jobId, `${jobId}-ART-SESSION-SUMMARY`)
  ]);
  const summary = finalArtifact?.content ?? job.finalOutput ?? sessionSummary?.content ??
    "No final task summary has been recorded yet.";
  return [
    `Job: ${job.id}`,
    `Title: ${job.displayTitle}`,
    `Status: ${job.status}`,
    `Routing mode: ${job.routingMode}`,
    `Original request: ${truncatePanelContext(job.rawPrompt, 1000)}`,
    "",
    truncatePanelContext(summary, 4000)
  ].join("\n");
}

async function sendPanelChatToModel(input: PanelChatInput) {
  const panelAgent = await loadPanelAgentConfig();
  if (!panelAgent) {
    throw new PanelChatError(409, "panel_agent_missing", "Panel agent is not configured.");
  }
  if (!panelAgent.providerId) {
    throw new PanelChatError(409, "panel_agent_provider_missing", "Panel agent model provider is not configured.");
  }

  const provider = await getModelProvider(panelAgent.providerId);
  if (!provider) {
    throw new PanelChatError(409, "panel_agent_provider_missing", "Panel agent model provider was not found.");
  }

  const model = panelAgent.model || provider.defaultModel;
  if (!model) {
    throw new PanelChatError(409, "panel_agent_model_missing", "Panel agent model is not configured.");
  }

  const apiKey = await readProviderApiKey(provider.id);
  if (!apiKey) {
    throw new PanelChatError(409, "panel_agent_api_key_missing", "Panel agent API key is not configured.");
  }

  const [adoptedExperiences, agentConfigs, promptSnapshot, latestTaskSummary] = await Promise.all([
    listExperiences({ status: "adopted", limit: 8 }),
    listAgentConfigs(),
    loadPanelPromptSnapshot(panelAgent),
    loadPanelLatestTaskSummary(input.latestJobId)
  ]);
  const availableAgents = agentConfigs.filter(
    (agent) => agent.enabled && agent.id !== panelAgent.id && agent.id !== "main-agent"
  );
  const history: PanelChatCompletionMessage[] = (input.messages ?? [])
    .slice(-16)
    .map((message) => ({
      role: message.role,
      content: message.body.trim()
    }))
    .filter((message) => Boolean(message.content));
  const needsCurrentMessage =
    history.at(-1)?.role !== "user" ||
    history.at(-1)?.content.trim() !== input.message.trim();
  const messages: PanelChatCompletionMessage[] = [
    {
      role: "system",
      content: buildPanelChatSystemPrompt({
        chat: input,
        agent: panelAgent,
        provider,
        model,
        experiences: adoptedExperiences.experiences,
        availableAgents,
        promptSnapshot,
        latestTaskSummary
      })
    },
    ...history,
    ...(needsCurrentMessage ? [{ role: "user" as const, content: input.message.trim() }] : [])
  ];

  const spendReservationKey = `panel:${input.sourceMessageId?.trim() || randomUUID()}`;
  const spendReservation = await reserveStandaloneModelSpend({
    reservationKey: spendReservationKey,
    requesterId: input.requesterId,
    providerId: provider.id,
    model,
    agentId: panelAgent.id,
    actionType: "panel-chat",
    kind: "chat",
    inputTokenCeiling: Buffer.byteLength(JSON.stringify(messages), "utf8") + 2_048,
    outputTokenCeiling: 900
  });
  if (!spendReservation.allowed) {
    throw new PanelChatError(
      409,
      `panel_${spendReservation.reason ?? "spend_budget_blocked"}`,
      spendReservation.reason ?? "Panel agent spend budget is blocked."
    );
  }
  if (spendReservation.enabled) {
    const dispatchClaim = await claimModelCallSpendDispatch({
      reservationKey: spendReservationKey,
      note: "panel_provider_dispatch_started"
    });
    if (!dispatchClaim) {
      throw new PanelChatError(
        409,
        "panel_request_already_dispatched",
        "This panel-agent request was already dispatched and must not be replayed."
      );
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let providerRequestStarted = false;
  let providerAccepted = false;
  let spendResolved = false;
  try {
    providerRequestStarted = true;
    const providerResponse = await fetch(chatCompletionsUrl(provider.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 900,
        temperature: 0.35,
        stream: false
      }),
      signal: controller.signal
    });

    if (!providerResponse.ok) {
      await releaseModelCallSpendByIdempotency({
        idempotencyKey: spendReservationKey,
        note: `panel_provider_http_${providerResponse.status}`
      });
      spendResolved = true;
      throw new PanelChatError(
        502,
        "panel_agent_chat_failed",
        await safeProviderErrorMessage(providerResponse)
      );
    }

    providerAccepted = true;

    const responseBody = await providerResponse.json();
    await settleModelCallSpendByIdempotency({
      idempotencyKey: spendReservationKey,
      usage: extractPanelChatUsage(responseBody),
      note: "panel_provider_response_settled"
    });
    spendResolved = true;
    const answer = extractPanelChatText(responseBody);
    if (!answer) {
      throw new PanelChatError(502, "panel_agent_empty_response", "Panel agent returned an empty response.");
    }

    const usedExperienceIds = adoptedExperiences.experiences.map((experience) => experience.id);
    try {
      await recordExperienceRecall(usedExperienceIds);
    } catch {
      // Recall scoring is best-effort; a delayed migration must not block chat.
    }

    const parsedOrchestration = parsePanelOrchestrationOutput({
      rawOutput: answer,
      rawPrompt: input.message,
      requestedMaxModelCalls: input.maxModelCalls,
      allowedAgentIds: availableAgents.map((agent) => agent.id)
    });
    const orchestration = parsedOrchestration ?? {
      ...buildDeterministicPanelResult({
        rawPrompt: input.message,
        language: input.language,
        requestedMaxModelCalls: input.maxModelCalls,
        warning: "panel_agent_contract_invalid"
      }),
      reply: answer
    };

    return {
      message: orchestration.reply,
      agentName: input.supervisorName?.trim() || panelAgent.displayName,
      model,
      providerId: provider.id,
      usedExperienceIds,
      intent: orchestration.intent,
      taskPlan: orchestration.plan,
      orchestrationSource: orchestration.source,
      degraded: orchestration.degraded,
      warnings: orchestration.warnings
    };
  } catch (error) {
    if (!spendResolved) {
      if (providerAccepted) {
        await settleModelCallSpendByIdempotency({
          idempotencyKey: spendReservationKey,
          usage: null,
          note: "panel_provider_response_invalid_settled_from_reservation"
        }).catch(() => undefined);
      } else if (providerRequestStarted) {
        await markModelCallSpendOutcomeUnknown({
          idempotencyKey: spendReservationKey,
          note: error instanceof Error ? error.message : "panel_provider_outcome_unknown"
        }).catch(() => undefined);
      } else {
        await releaseModelCallSpendByIdempotency({
          idempotencyKey: spendReservationKey,
          note: "panel_request_not_dispatched"
        }).catch(() => undefined);
      }
    }
    if (error instanceof PanelChatError) {
      throw error;
    }
    throw new PanelChatError(
      502,
      "panel_agent_chat_failed",
      error instanceof Error ? error.message.slice(0, 500) : "Panel agent chat failed."
    );
  } finally {
    clearTimeout(timeout);
  }
}

function providerVerificationFailureCode(verification: ProviderVerificationResult, model: string) {
  if (verification.statusCode === 401 || verification.statusCode === 403) {
    return "provider_auth_failed";
  }
  if (verification.statusCode === 402) {
    return "provider_quota_or_billing_failed";
  }
  if (verification.statusCode === 404) {
    return "provider_endpoint_or_model_not_found";
  }
  if (verification.statusCode === 429) {
    return "provider_rate_limited";
  }
  if (verification.statusCode === 400) {
    return "provider_rejected_model";
  }
  if (verification.statusCode && verification.statusCode >= 500) {
    return "provider_server_error";
  }
  if (!verification.statusCode) {
    return "provider_network_failed";
  }
  return "provider_verification_failed";
}

async function verifyAgentModelProvider(input: {
  kind: AgentModelVerificationKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}) {
  if (input.kind === "image_generation") {
    return verifyOpenAiCompatibleImageGenerationProvider({
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey
    });
  }
  if (input.kind === "video_generation") {
    return verifyOpenAiCompatibleVideoGenerationProvider({
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey
    });
  }
  return verifyOpenAiCompatibleProvider({
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey
  });
}

async function applyOpenClawSyncAfterAgentConfig(input: {
  rootPath?: string;
  allowDiscoveredUserRuntime?: boolean;
}) {
  const result = await applyOpenClawSyncPlan({
    rootPath: input.rootPath,
    allowDiscoveredUserRuntime: input.allowDiscoveredUserRuntime ?? true
  });
  if (!result) {
    return {
      ok: false,
      error: "openclaw_runtime_not_found",
      appliedAt: null,
      writtenFiles: []
    };
  }

  await Promise.all(
    result.plan.agents.map((agent) =>
      patchAgentConfig(agent.honeycombAgentId, {
        openclawSyncStatus: agent.status === "ready" ? "synced" : "failed",
        openclawAgentPath: agent.targetAgentPromptPath,
        lastSyncedAt: result.appliedAt,
        lastError: agent.status === "ready" ? null : "missing_template"
      })
    )
  );

  return {
    ok: true,
    error: null,
    appliedAt: result.appliedAt,
    writtenFiles: result.writtenFiles
  };
}

type ProviderVerificationRequest = {
  providerId: string;
  apiKey?: string;
  model?: string;
};

const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  ingressOrigin: z.enum(INGRESS_ORIGINS).optional(),
  prompt: z.string().trim().min(1).max(300).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(["createdAt", "updatedAt"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().min(1).max(2000).optional()
});

const cancelJobSchema = z.object({
  reason: z.string().max(500).optional(),
  requesterId: z.string().max(200).optional()
});

const resumeJobSchema = z.object({
  reason: z.string().max(500).optional(),
  requesterId: z.string().max(200).optional(),
  maxModelCalls: z.number().int().min(1).max(100).optional(),
  maxCostUsd: z.number().min(0).max(1_000_000).optional()
});

const listExperiencesQuerySchema = z.object({
  status: z.enum(EXPERIENCE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const defaultCorsOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost"
];

function getCorsOrigins() {
  return (process.env.ORCHESTRATOR_CORS_ORIGINS ?? defaultCorsOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requireAdminToken(request: express.Request, response: express.Response) {
  const expectedToken = process.env.ADMIN_API_TOKEN?.trim();
  if (!expectedToken) {
    response.status(403).json({ error: "admin_api_token_not_configured" });
    return false;
  }

  const actualToken = request.header("x-admin-token")?.trim();
  if (!actualToken || !timingSafeEqualString(actualToken, expectedToken)) {
    response.status(401).json({ error: "invalid_admin_token" });
    return false;
  }

  return true;
}

async function respondWithExperienceStatus(
  request: express.Request,
  response: express.Response,
  status: Exclude<ExperienceStatus, "candidate">
) {
  const experienceId = Array.isArray(request.params.experienceId)
    ? request.params.experienceId[0] ?? ""
    : request.params.experienceId;
  const result = await setExperienceStatus(experienceId, status);
  if (!result.experience) {
    response.status(404).json({ error: "experience_not_found" });
    return;
  }

  if (result.changed) {
    await appendJobEvent(
      result.experience.sourceJobId,
      `experience.${status}`,
      {
        experienceId: result.experience.id,
        kind: result.experience.kind,
        scope: result.experience.scope,
        scopeKey: result.experience.scopeKey
      },
      {
        actor: "user"
      }
    );
  }

  response.json(result);
}

function unknownOutcomeModelCallView(modelCall: ModelCallRecord) {
  return {
    id: modelCall.id,
    jobId: modelCall.jobId,
    stageId: modelCall.stageId,
    actionType: modelCall.actionType,
    agentId: modelCall.agentId,
    status: modelCall.status,
    requestReference: modelCall.requestReference,
    reconciliation: modelCall.reconciliation,
    error: modelCall.error,
    createdAt: modelCall.createdAt,
    updatedAt: modelCall.updatedAt
  };
}

function providerReconciliationResultView(result: ProviderReconciliationResult) {
  return {
    status: result.status,
    providerStatus: result.providerStatus,
    providerHttpStatus: result.providerHttpStatus,
    reason: result.reason,
    resultTextRecovered: Boolean(result.resultText)
  };
}

function recoveredMediaArtifacts(
  modelCall: ModelCallRecord,
  providerResult: ProviderReconciliationResult | null | undefined,
  resultText: string | null | undefined
) {
  const kind = modelCall.requestReference?.kind;
  if (kind !== "image" && kind !== "video") {
    return [];
  }
  return recoverProviderMediaArtifacts({
    kind,
    payload: providerResult?.payload,
    resultText
  });
}

function canRecoverSuccessfulModelCall(
  modelCall: ModelCallRecord,
  providerResult: ProviderReconciliationResult | null | undefined,
  resultText: string | null | undefined
) {
  const kind = modelCall.requestReference?.kind;
  return kind === "image" || kind === "video"
    ? recoveredMediaArtifacts(modelCall, providerResult, resultText).length > 0
    : Boolean(resultText?.trim());
}

function buildModelCallReconciliationState(input: {
  status: ModelCallReconciliationStatus;
  source: ModelCallReconciliationState["source"];
  providerStatus?: string | null;
  providerHttpStatus?: number | null;
  reason?: string | null;
  canResume: boolean;
  checkedAt?: string;
}): ModelCallReconciliationState {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  return {
    version: "honeycomb.model-reconciliation.v1",
    status: input.status,
    source: input.source,
    providerStatus: input.providerStatus ?? null,
    providerHttpStatus: input.providerHttpStatus ?? null,
    reason: input.reason?.trim().slice(0, 500) || null,
    canResume: input.canResume,
    checkedAt,
    resolvedAt: input.canResume ? checkedAt : null
  };
}

async function recordUnresolvedModelCallReconciliation(input: {
  jobId: string;
  modelCall: ModelCallRecord;
  state: ModelCallReconciliationState;
  actor: "user" | "system";
}) {
  const modelCall = await recordModelCallReconciliation({
    jobId: input.jobId,
    modelCallId: input.modelCall.id,
    reconciliation: input.state
  });
  if (!modelCall) {
    return null;
  }
  await setJobStatus(input.jobId, "waiting_for_human", {
    reason: "model_call_reconciliation_required",
    modelCallId: modelCall.id,
    reconciliationStatus: input.state.status
  });
  await appendJobEvent(input.jobId, "model_call.reconciliation_checked", {
    modelCallId: modelCall.id,
    idempotencyKey: modelCall.idempotencyKey,
    status: input.state.status,
    source: input.state.source,
    providerStatus: input.state.providerStatus,
    providerHttpStatus: input.state.providerHttpStatus,
    reason: input.state.reason,
    canResume: false
  }, {
    actor: input.actor,
    stageId: modelCall.stageId
  });
  return modelCall;
}

async function resolveUnknownOutcomeModelCall(input: {
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>;
  modelCall: ModelCallRecord;
  state: ModelCallReconciliationState;
  resultText?: string | null;
  providerResult?: ProviderReconciliationResult | null;
  actor: "user" | "system";
}) {
  let modelCall: ModelCallRecord | null;
  if (input.state.status === "confirmed_succeeded") {
    const recoveredArtifacts = recoveredMediaArtifacts(
      input.modelCall,
      input.providerResult,
      input.resultText
    );
    const mediaKind = input.modelCall.requestReference?.kind;
    const text = input.resultText?.trim() || (
      mediaKind === "image" || mediaKind === "video"
        ? [
            `Recovered ${mediaKind} output from provider reconciliation.`,
            ...recoveredArtifacts.map((artifact) => `URL: ${artifact.url}`)
          ].join("\n")
        : ""
    );
    if (!text || !canRecoverSuccessfulModelCall(
      input.modelCall,
      input.providerResult,
      input.resultText
    )) {
      return null;
    }
    const previousRouteAttempts = input.modelCall.responsePayload?.routeAttempts;
    modelCall = await reconcileModelCallAsSucceeded({
      jobId: input.job.id,
      modelCallId: input.modelCall.id,
      reconciliation: input.state,
      responsePayload: {
        result: {
          mode: input.modelCall.requestReference?.runner === "provider-direct"
            ? "provider-direct"
            : "real",
          sessionId: input.modelCall.agentSessionId ?? input.job.sessionId,
          text,
          textSource: "provider:reconciled",
          usage: null,
          artifacts: recoveredArtifacts,
          raw: input.providerResult?.payload ?? null
        },
        route: input.modelCall.requestReference,
        routeAttempts: Array.isArray(previousRouteAttempts) ? previousRouteAttempts : [],
        routeSelection: input.modelCall.requestReference
          ? {
              selectedIndex: input.modelCall.requestReference.routeIndex,
              attemptedCount: Array.isArray(previousRouteAttempts)
                ? previousRouteAttempts.length
                : input.modelCall.requestReference.routeAttemptNo,
              failoverUsed: input.modelCall.requestReference.routeIndex > 0,
              retryUsed: input.modelCall.requestReference.routeAttemptNo > 1
            }
          : null
      }
    });
  } else {
    modelCall = await reconcileModelCallAsFailed({
      jobId: input.job.id,
      modelCallId: input.modelCall.id,
      reconciliation: input.state,
      error: input.state.status === "confirmed_not_accepted"
        ? `provider_confirmed_not_accepted: ${input.state.reason ?? "request was not accepted"}`
        : `provider_confirmed_failed: ${input.state.reason ?? "request failed"}`
    });
  }
  if (!modelCall) {
    return null;
  }

  if (input.state.status === "confirmed_succeeded") {
    await settleModelCallSpendByIdempotency({
      idempotencyKey: modelCall.idempotencyKey,
      usage: null,
      note: "provider_reconciliation_confirmed_succeeded"
    });
  } else {
    await releaseModelCallSpendByIdempotency({
      idempotencyKey: modelCall.idempotencyKey,
      note: `provider_reconciliation_${input.state.status}`
    });
  }

  await setJobStatus(input.job.id, "waiting_for_human", {
    reason: "model_call_reconciled_safe_to_resume",
    modelCallId: modelCall.id,
    reconciliationStatus: input.state.status
  });
  await appendJobEvent(input.job.id, "model_call.reconciliation_resolved", {
    modelCallId: modelCall.id,
    idempotencyKey: modelCall.idempotencyKey,
    status: input.state.status,
    source: input.state.source,
    providerStatus: input.state.providerStatus,
    providerHttpStatus: input.state.providerHttpStatus,
    reason: input.state.reason,
    recoveredTextLength: input.state.status === "confirmed_succeeded"
      ? input.resultText?.trim().length ?? 0
      : 0,
    canResume: true
  }, {
    actor: input.actor,
    stageId: modelCall.stageId
  });
  return modelCall;
}

async function runJobExecutionPreflight(job: Awaited<ReturnType<typeof createJob>>) {
  if (!job.orchestrationPlan) {
    throw new Error("job_orchestration_plan_missing");
  }

  const preflight = await preflightTaskExecution({ plan: job.orchestrationPlan });
  await setJobExecutionPreflight(job.id, preflight);
  await appendJobEvent(job.id, "job.execution_preflight_completed", {
    status: preflight.status,
    mode: preflight.mode,
    runner: preflight.runner,
    agentCount: preflight.agents.length,
    blockingIssues: preflight.blockingIssues,
    warnings: preflight.warnings
  });
  return preflight;
}

async function preflightAndStartJob(job: Awaited<ReturnType<typeof createJob>>) {
  if (
    job.workflowId ||
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    return {
      status: job.status,
      workflowId: job.workflowId,
      preflight: job.executionPreflight
    };
  }

  const preflight = await runJobExecutionPreflight(job);

  if (preflight.status === "blocked") {
    await setJobStatus(job.id, "waiting_for_human", {
      source: "job.execution_preflight",
      reason: "agent_runtime_configuration_blocked",
      blockingIssues: preflight.blockingIssues
    });
    return {
      status: "waiting_for_human" as const,
      workflowId: null,
      preflight
    };
  }

  return {
    status: "queued" as const,
    workflowId: await startJobWorkflow(job.id),
    preflight
  };
}

function canonicalArtifactFileView(jobId: string, file: ArtifactFileRecord) {
  return {
    ...file,
    downloadable: file.status === "available" && Boolean(file.filePath),
    downloadUrl: file.status === "available" && file.filePath
      ? `/jobs/${jobId}/artifact-files/${file.id}/content`
      : null
  };
}

function artifactDeliveryView(
  jobId: string,
  delivery: ArtifactDeliveryRecord,
  file: ArtifactFileRecord | null,
  options: { includeDestination?: boolean } = {}
) {
  const {
    claimToken: _claimToken,
    authorizedRootPath,
    destinationRelativePath,
    destinationPath,
    ...publicDelivery
  } = delivery;
  const destination = options.includeDestination && delivery.authorizationStatus === "authorized"
    ? delivery.authorizationKind === "desktop"
      ? {
          kind: "desktop" as const,
          rootPath: null,
          relativeDirectory: null,
          directoryPath: null
        }
      : delivery.authorizationKind === "registered_workspace" || delivery.authorizationKind === "custom_grant"
        ? {
            kind: delivery.target as "workspace" | "custom",
            rootPath: authorizedRootPath,
            relativeDirectory: destinationRelativePath,
            directoryPath: destinationPath
          }
        : null
    : null;
  return {
    ...publicDelivery,
    destination,
    artifactFile: file ? canonicalArtifactFileView(jobId, file) : null
  };
}

async function maybeStartArtifactDeliveryFinalization(jobId: string) {
  const summary = await getArtifactDeliverySummary(jobId);
  const publicSummary = {
    requiredCount: summary.requiredCount,
    succeededCount: summary.succeededCount,
    failedCount: summary.failedCount,
    pendingCount: summary.pendingCount,
    deliveringCount: summary.deliveringCount,
    readyToFinalize: summary.readyToFinalize
  };
  if (!summary.readyToFinalize) {
    return { status: "not_ready" as const, workflowId: null, summary: publicSummary };
  }
  const claimed = await claimJobArtifactDeliveryFinalization(jobId);
  if (!claimed) {
    return { status: "not_claimed" as const, workflowId: null, summary: publicSummary };
  }

  const workflowId = `job-${jobId}-delivery-${randomUUID().slice(0, 12)}`;
  try {
    const startedWorkflowId = await startJobWorkflow(jobId, workflowId);
    return { status: "started" as const, workflowId: startedWorkflowId, summary: publicSummary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setJobStatus(jobId, "waiting_for_human", {
      reason: "artifact_delivery_resume_failed",
      error: message
    });
    return { status: "failed" as const, workflowId: null, summary: publicSummary, error: message };
  }
}

async function main() {
  const app = express();
  await launchDbos();
  await ensureDefaultAgentConfigs();
  const port = Number(process.env.ORCHESTRATOR_PORT ?? 3000);
  const host = process.env.ORCHESTRATOR_HOST?.trim() || "127.0.0.1";
  const corsOrigins = getCorsOrigins();

  app.use((request, response, next) => {
    const origin = request.header("origin");
    if (origin && corsOrigins.includes(origin)) {
      response.header("access-control-allow-origin", origin);
      response.header("vary", "Origin");
      response.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
      response.header(
        "access-control-allow-headers",
        "authorization,content-type,x-admin-token,x-honeycomb-token"
      );
    }

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  });

  app.use(requireApiToken);
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/panel/agent-prompts/personalize", (request, response, next) => {
    try {
      const input = panelPromptPersonalizationSchema.parse(request.body ?? {});
      response.json(personalizePanelAgentPrompts(input));
    } catch (error) {
      next(error);
    }
  });

  app.post("/panel/chat", async (request, response, next) => {
    let input: PanelChatInput;
    try {
      input = panelChatSchema.parse(request.body ?? {});
      response.json(await sendPanelChatToModel(input));
    } catch (error) {
      if (error instanceof PanelChatError) {
        const fallback = buildDeterministicPanelResult({
          rawPrompt: input!.message,
          language: input!.language,
          requestedMaxModelCalls: input!.maxModelCalls,
          warning: error.code
        });
        response.json({
          message: fallback.reply,
          agentName: input!.supervisorName?.trim() || "Panel agent",
          model: null,
          providerId: null,
          usedExperienceIds: [],
          intent: fallback.intent,
          taskPlan: fallback.plan,
          orchestrationSource: fallback.source,
          degraded: true,
          warnings: fallback.warnings,
          panelError: {
            code: error.code,
            message: error.message
          }
        });
        return;
      }
      next(error);
    }
  });

  app.get("/conversation-workspace", async (_request, response, next) => {
    try {
      response.json(await getConversationWorkspaceSnapshot());
    } catch (error) {
      next(error);
    }
  });

  app.post("/conversation-workspace/sync", async (request, response, next) => {
    try {
      const input = conversationWorkspaceSnapshotSchema.parse(request.body ?? {});
      const snapshot = {
        projects: input.projects.map((project) => ({
          ...project,
          conversations: project.conversations.map((conversation) => ({
            ...conversation,
            projectId: project.id,
            messages: conversation.messages.map((message) => ({
              ...message,
              conversationId: conversation.id,
              jobId: message.jobId ?? null
            }))
          }))
        })),
        generatedAt: input.generatedAt
      };
      response.json(await syncConversationWorkspaceSnapshot(snapshot));
    } catch (error) {
      next(error);
    }
  });

  app.get("/conversation-projects", async (request, response, next) => {
    try {
      const query = listConversationRecordsSchema.parse(request.query);
      response.json({
        projects: await listConversationProjects({ includeArchived: query.includeArchived })
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/conversation-projects", async (request, response, next) => {
    try {
      const input = createConversationProjectSchema.parse(request.body ?? {});
      const project = await upsertConversationProject({
        ...input,
        updatedAt: new Date().toISOString()
      });
      response.status(201).json(project);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/conversation-projects/:projectId", async (request, response, next) => {
    try {
      const projectId = routeParameter(request.params.projectId);
      const input = patchConversationProjectSchema.parse(request.body ?? {});
      const project = await patchConversationProject(projectId, input);
      if (!project) {
        response.status(404).json({ error: "conversation_project_not_found" });
        return;
      }
      response.json(project);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/conversation-projects/:projectId", async (request, response, next) => {
    try {
      const deleted = await deleteConversationProject(routeParameter(request.params.projectId));
      if (!deleted) {
        response.status(404).json({ error: "conversation_project_not_found" });
        return;
      }
      response.json({ ok: true, deleted: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/conversation-projects/:projectId/conversations", async (request, response, next) => {
    try {
      const projectId = routeParameter(request.params.projectId);
      const project = await getConversationProject(projectId);
      if (!project) {
        response.status(404).json({ error: "conversation_project_not_found" });
        return;
      }
      const query = listConversationRecordsSchema.parse(request.query);
      response.json({
        conversations: await listConversations({
          projectId,
          includeArchived: query.includeArchived
        })
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/conversation-projects/:projectId/conversations", async (request, response, next) => {
    try {
      const projectId = routeParameter(request.params.projectId);
      if (!(await getConversationProject(projectId))) {
        response.status(404).json({ error: "conversation_project_not_found" });
        return;
      }
      const input = createConversationSchema.parse(request.body ?? {});
      const conversation = await upsertConversation({
        ...input,
        projectId,
        updatedAt: new Date().toISOString()
      });
      response.status(201).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/conversations/:conversationId", async (request, response, next) => {
    try {
      const conversationId = routeParameter(request.params.conversationId);
      const input = patchConversationSchema.parse(request.body ?? {});
      const conversation = await patchConversation(conversationId, input);
      if (!conversation) {
        response.status(404).json({ error: "conversation_not_found" });
        return;
      }
      response.json(conversation);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/conversations/:conversationId", async (request, response, next) => {
    try {
      const deleted = await deleteConversation(routeParameter(request.params.conversationId));
      if (!deleted) {
        response.status(404).json({ error: "conversation_not_found" });
        return;
      }
      response.json({ ok: true, deleted: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/conversations/:conversationId/messages", async (request, response, next) => {
    try {
      const conversationId = routeParameter(request.params.conversationId);
      if (!(await getConversation(conversationId))) {
        response.status(404).json({ error: "conversation_not_found" });
        return;
      }
      const query = listConversationMessagesSchema.parse(request.query);
      response.json({
        messages: await listConversationMessages({ conversationId, limit: query.limit })
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/conversations/:conversationId/messages", async (request, response, next) => {
    try {
      const conversationId = routeParameter(request.params.conversationId);
      if (!(await getConversation(conversationId))) {
        response.status(404).json({ error: "conversation_not_found" });
        return;
      }
      const input = createConversationMessageSchema.parse(request.body ?? {});
      const message = await upsertConversationMessage({
        ...input,
        conversationId
      });
      response.status(201).json(message);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/conversation-messages/:messageId", async (request, response, next) => {
    try {
      const messageId = routeParameter(request.params.messageId);
      const input = patchConversationMessageSchema.parse(request.body ?? {});
      const message = await patchConversationMessage(messageId, input);
      if (!message) {
        response.status(404).json({ error: "conversation_message_not_found" });
        return;
      }
      response.json(message);
    } catch (error) {
      next(error);
    }
  });

  for (const adapter of ingressAdapters) {
    if (adapter.isEnabled(process.env)) {
      adapter.mount(app, {
        createJob,
        getJobByFeishuMessageId,
        startJob: preflightAndStartJob
      });
    }
  }

  app.post("/admin/model-calls/failed-unknown-outcome", async (request, response, next) => {
    try {
      if (!requireAdminToken(request, response)) {
        return;
      }

      const input = unstickModelCallSchema.parse(request.body);
      if (input.restartWorkflow) {
        response.status(409).json({
          error: "unsafe_unknown_outcome_restart_rejected",
          message: "Reconcile the provider outcome before resuming this job."
        });
        return;
      }
      const job = await getJob(input.jobId);
      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      const modelCall = await markModelCallFailedUnknownOutcome({
        idempotencyKey: input.idempotencyKey,
        force: true,
        error: input.reason
          ? `failed_unknown_outcome: ${input.reason}`
          : "failed_unknown_outcome: manually marked by admin"
      });

      if (!modelCall) {
        response.status(404).json({ error: "started_model_call_not_found" });
        return;
      }

      await markModelCallSpendOutcomeUnknown({
        idempotencyKey: modelCall.idempotencyKey,
        note: input.reason ?? "manually_marked_unknown_outcome"
      });

      await appendJobEvent(input.jobId, "tool.openclaw_agent_failed_unknown_outcome", {
        modelCallId: modelCall.id,
        idempotencyKey: modelCall.idempotencyKey,
        reason: input.reason ?? null
      }, {
        actor: "admin",
        stageId: modelCall.stageId
      });
      await setJobStatus(input.jobId, "waiting_for_human", {
        reason: "model_call_reconciliation_required",
        modelCallId: modelCall.id
      });

      response.json({
        ok: true,
        modelCallId: modelCall.id,
        status: modelCall.status,
        workflowId: null,
        reconciliationRequired: true
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/model-calls/unknown-outcomes", async (request, response, next) => {
    try {
      const jobId = routeParameter(request.params.jobId);
      const job = await getJob(jobId);
      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }
      const modelCalls = await listUnknownOutcomeModelCallsForJob(jobId);
      response.json({
        jobId,
        count: modelCalls.length,
        canResume: modelCalls.length === 0,
        modelCalls: modelCalls.map(unknownOutcomeModelCallView)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/spend", async (request, response, next) => {
    try {
      const jobId = routeParameter(request.params.jobId);
      const budget = await getJobSpendBudget(jobId);
      if (!budget) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }
      response.json({
        jobId,
        budget,
        entries: await listModelCallSpendForJob(jobId)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/jobs/:jobId/model-calls/:modelCallId/reconcile",
    async (request, response, next) => {
      try {
        const jobId = routeParameter(request.params.jobId);
        const modelCallId = routeParameter(request.params.modelCallId);
        const input = reconcileUnknownOutcomeSchema.parse(request.body ?? {});
        const job = await getJob(jobId);
        if (!job) {
          response.status(404).json({ error: "job_not_found" });
          return;
        }
        const modelCall = await getModelCallForJobById(jobId, modelCallId);
        if (!modelCall) {
          response.status(404).json({ error: "model_call_not_found" });
          return;
        }
        if (modelCall.status !== "failed_unknown_outcome") {
          response.status(409).json({
            error: "model_call_reconciliation_not_required",
            modelCall: unknownOutcomeModelCallView(modelCall)
          });
          return;
        }
        if (["succeeded", "failed", "cancelled"].includes(job.status)) {
          response.status(409).json({
            error: "terminal_job_cannot_be_reconciled",
            jobId,
            status: job.status
          });
          return;
        }

        if (input.action === "query_provider") {
          const reference = modelCall.requestReference;
          if (!reference) {
            const state = buildModelCallReconciliationState({
              status: "manual_review",
              source: "system",
              reason: "model_call_request_reference_missing",
              canResume: false
            });
            const updated = await recordUnresolvedModelCallReconciliation({
              jobId,
              modelCall,
              state,
              actor: "system"
            });
            response.status(409).json({
              error: "model_call_request_reference_missing",
              canResume: false,
              modelCall: updated ? unknownOutcomeModelCallView(updated) : null
            });
            return;
          }

          const provider = await getModelProvider(reference.providerId);
          if (!provider) {
            const state = buildModelCallReconciliationState({
              status: "manual_review",
              source: "system",
              reason: "model_call_provider_missing",
              canResume: false
            });
            const updated = await recordUnresolvedModelCallReconciliation({
              jobId,
              modelCall,
              state,
              actor: "system"
            });
            response.status(409).json({
              error: "model_call_provider_missing",
              canResume: false,
              modelCall: updated ? unknownOutcomeModelCallView(updated) : null
            });
            return;
          }

          const policy = parseProviderUnknownOutcomePolicy(provider.metadata);
          if (!policy) {
            const state = buildModelCallReconciliationState({
              status: "manual_review",
              source: "system",
              reason: "provider_reconciliation_not_configured",
              canResume: false
            });
            const updated = await recordUnresolvedModelCallReconciliation({
              jobId,
              modelCall,
              state,
              actor: "system"
            });
            response.status(409).json({
              error: "provider_reconciliation_not_configured",
              canResume: false,
              modelCall: updated ? unknownOutcomeModelCallView(updated) : null
            });
            return;
          }

          const providerResult = await queryProviderUnknownOutcome({
            baseUrl: provider.baseUrl,
            apiKey: await readProviderApiKey(provider.id),
            reference,
            policy
          });
          if (
            providerResult.status === "confirmed_succeeded" &&
            !canRecoverSuccessfulModelCall(modelCall, providerResult, providerResult.resultText)
          ) {
            const mediaKind = modelCall.requestReference?.kind;
            const missingReason = mediaKind === "image" || mediaKind === "video"
              ? "provider_media_artifact_missing"
              : providerResult.reason ?? "provider_result_missing";
            const state = buildModelCallReconciliationState({
              status: "manual_review",
              source: "provider_query",
              providerStatus: providerResult.providerStatus,
              providerHttpStatus: providerResult.providerHttpStatus,
              reason: missingReason,
              canResume: false
            });
            const updated = await recordUnresolvedModelCallReconciliation({
              jobId,
              modelCall,
              state,
              actor: "system"
            });
            response.status(409).json({
              error: missingReason,
              outcome: providerReconciliationResultView(providerResult),
              canResume: false,
              modelCall: updated ? unknownOutcomeModelCallView(updated) : null
            });
            return;
          }

          if (
            providerResult.status === "confirmed_not_accepted" ||
            providerResult.status === "confirmed_failed" ||
            providerResult.status === "confirmed_succeeded"
          ) {
            const state = buildModelCallReconciliationState({
              status: providerResult.status,
              source: "provider_query",
              providerStatus: providerResult.providerStatus,
              providerHttpStatus: providerResult.providerHttpStatus,
              reason: providerResult.reason,
              canResume: true
            });
            const updated = await resolveUnknownOutcomeModelCall({
              job,
              modelCall,
              state,
              resultText: providerResult.resultText,
              providerResult,
              actor: "system"
            });
            if (!updated) {
              response.status(409).json({ error: "model_call_reconciliation_conflict" });
              return;
            }
            response.json({
              ok: true,
              outcome: providerReconciliationResultView(providerResult),
              canResume: true,
              modelCall: unknownOutcomeModelCallView(updated)
            });
            return;
          }

          const state = buildModelCallReconciliationState({
            status: providerResult.status,
            source: "provider_query",
            providerStatus: providerResult.providerStatus,
            providerHttpStatus: providerResult.providerHttpStatus,
            reason: providerResult.reason,
            canResume: false
          });
          const updated = await recordUnresolvedModelCallReconciliation({
            jobId,
            modelCall,
            state,
            actor: "system"
          });
          if (!updated) {
            response.status(409).json({ error: "model_call_reconciliation_conflict" });
            return;
          }
          response.status(providerResult.status === "query_failed" ? 502 : 202).json({
            ok: providerResult.status !== "query_failed",
            ...(providerResult.status === "query_failed"
              ? { error: "provider_reconciliation_query_failed" }
              : {}),
            outcome: providerReconciliationResultView(providerResult),
            canResume: false,
            modelCall: unknownOutcomeModelCallView(updated)
          });
          return;
        }

        if (input.action === "keep_waiting") {
          const state = buildModelCallReconciliationState({
            status: "manual_review",
            source: "manual",
            reason: input.reason ?? "manual_review_requested",
            canResume: false
          });
          const updated = await recordUnresolvedModelCallReconciliation({
            jobId,
            modelCall,
            state,
            actor: "user"
          });
          if (!updated) {
            response.status(409).json({ error: "model_call_reconciliation_conflict" });
            return;
          }
          response.status(202).json({
            ok: true,
            canResume: false,
            modelCall: unknownOutcomeModelCallView(updated)
          });
          return;
        }

        if (
          input.action === "confirm_succeeded" &&
          !canRecoverSuccessfulModelCall(modelCall, null, input.recoveredText)
        ) {
          response.status(409).json({
            error: modelCall.requestReference?.kind === "image" ||
              modelCall.requestReference?.kind === "video"
              ? "provider_media_artifact_missing"
              : "provider_result_missing",
            canResume: false,
            modelCall: unknownOutcomeModelCallView(modelCall)
          });
          return;
        }

        const status = input.action === "confirm_not_accepted"
          ? "confirmed_not_accepted"
          : input.action === "confirm_failed"
            ? "confirmed_failed"
            : "confirmed_succeeded";
        const state = buildModelCallReconciliationState({
          status,
          source: "manual",
          reason: input.reason ?? "manually confirmed by user",
          canResume: true
        });
        const updated = await resolveUnknownOutcomeModelCall({
          job,
          modelCall,
          state,
          resultText: input.action === "confirm_succeeded" ? input.recoveredText : null,
          actor: "user"
        });
        if (!updated) {
          response.status(409).json({ error: "model_call_reconciliation_conflict" });
          return;
        }
        response.json({
          ok: true,
          canResume: true,
          modelCall: unknownOutcomeModelCallView(updated)
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/jobs", async (request, response, next) => {
    try {
      const query = listJobsQuerySchema.parse(request.query);
      const result = await listJobs(query);
      response.json(result);
    } catch (error) {
      if (error instanceof InvalidJobListCursorError) {
        response.status(400).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  app.get("/runtime/logs", async (request, response, next) => {
    try {
      const query = runtimeLogsQuerySchema.parse(request.query);
      response.json(await listRuntimeLogs(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/runtime/usage", async (request, response, next) => {
    try {
      const query = runtimeUsageQuerySchema.parse(request.query);
      response.json(await getRuntimeUsage(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/runtime/model-call-queue", async (request, response, next) => {
    try {
      const query = modelCallQueueQuerySchema.parse(request.query);
      response.json(await getModelCallQueueOverview(query.limit));
    } catch (error) {
      next(error);
    }
  });

  app.get("/runtime/heartbeats", async (request, response, next) => {
    try {
      const query = jobHeartbeatQuerySchema.parse(request.query);
      response.json(await getJobHeartbeatSummary(query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/runtime/heartbeats/scan", async (request, response, next) => {
    try {
      const input = jobHeartbeatScanSchema.parse(request.body ?? {});
      response.json(await scanStalledJobHeartbeats(input));
    } catch (error) {
      next(error);
    }
  });

  app.get("/runtime/capabilities", (_request, response) => {
    response.json(getRuntimeCapabilities());
  });

  app.get("/runtime/diagnostics", async (request, response, next) => {
    try {
      const query = runtimeDiagnosticsQuerySchema.parse(request.query);
      response.json(await getRuntimeDiagnostics(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/runtime/repair/actions", (_request, response) => {
    response.json({
      actions: listRuntimeRepairActions()
    });
  });

  app.post("/runtime/repair", async (request, response, next) => {
    try {
      const input = runtimeRepairSchema.parse(request.body ?? {});
      const repair = await runRuntimeRepairAction(input);
      response.status(repair.ok ? 200 : 409).json(repair);
    } catch (error) {
      next(error);
    }
  });

  app.get("/openclaw/runtime", async (request, response, next) => {
    try {
      const query = openClawRuntimeQuerySchema.parse(request.query);
      response.json(await discoverOpenClawRuntime(query.rootPath));
    } catch (error) {
      next(error);
    }
  });

  app.get("/openclaw/runtime/control", async (request, response, next) => {
    try {
      const query = openClawRuntimeQuerySchema.parse(request.query);
      response.json(await getOpenClawRuntimeControlStatus(query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/openclaw/runtime/:action", async (request, response, next) => {
    try {
      const params = openClawRuntimeActionSchema.parse(request.params);
      const input = openClawRuntimeCommandSchema.parse(request.body ?? {});
      const result = await runOpenClawRuntimeCommand(
        params.action as OpenClawRuntimeAction,
        input
      );
      if (!result.configured) {
        response.status(501).json(result);
        return;
      }
      response.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/openclaw/sync/plan", async (request, response, next) => {
    try {
      const input = openClawSyncSchema.parse(request.body ?? {});
      const plan = await buildOpenClawSyncPlan(input);
      if (!plan) {
        response.status(404).json({ error: "openclaw_runtime_not_found" });
        return;
      }
      response.json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.post("/openclaw/sync/apply", async (request, response, next) => {
    try {
      const input = openClawSyncSchema.parse(request.body ?? {});
      const result = await applyOpenClawSyncPlan(input);
      if (!result) {
        response.status(404).json({ error: "openclaw_runtime_not_found" });
        return;
      }

      await Promise.all(
        result.plan.agents.map((agent) =>
          patchAgentConfig(agent.honeycombAgentId, {
            openclawSyncStatus: agent.status === "ready" ? "synced" : "failed",
            openclawAgentPath: agent.targetAgentPromptPath,
            lastSyncedAt: result.appliedAt,
            lastError: agent.status === "ready" ? null : "missing_template"
          })
        )
      );

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/openclaw/sync/validate", async (request, response, next) => {
    try {
      const input = openClawSyncSchema.parse(request.body ?? {});
      const result = await validateOpenClawSync(input);
      if (!result) {
        response.status(404).json({ error: "openclaw_runtime_not_found" });
        return;
      }
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/providers", async (_request, response, next) => {
    try {
      const providers = await withLiveProviderSecretStatuses(await listModelProviders());
      response.json({ providers });
    } catch (error) {
      next(error);
    }
  });

  app.post("/providers", async (request, response, next) => {
    try {
      const input = providerSchema.parse(request.body ?? {});
      const providerId = input.id?.trim() || stableIdFromName("provider", input.displayName);
      const keyStatus = input.apiKey
        ? await saveProviderApiKey(providerId, input.apiKey)
        : { configured: false, fingerprint: null };
      let verificationStatus: "unknown" | "succeeded" | "failed" = "unknown";
      let lastVerifiedAt: string | null = null;
      let lastError: string | null = null;
      let metadata = input.metadata ?? {};

      if (input.verify) {
        const apiKey = input.apiKey ?? await readProviderApiKey(providerId);
        const model = input.defaultModel;
        if (!apiKey || !model) {
          response.status(400).json({ error: "provider_api_key_and_model_required_for_verify" });
          return;
        }
        const verification = await verifyOpenAiCompatibleProvider({
          baseUrl: input.baseUrl,
          model,
          apiKey
        });
        verificationStatus = verification.status;
        lastVerifiedAt = verification.checkedAt;
        lastError = verification.message;
        metadata = withProviderVerificationMetadata(metadata, verification, model);
      }

      const provider = await upsertModelProvider({
        id: providerId,
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        defaultModel: input.defaultModel,
        apiKeyConfigured: keyStatus.configured,
        apiKeyFingerprint: keyStatus.fingerprint,
        verificationStatus,
        lastVerifiedAt,
        lastError,
        metadata
      });
      response.status(201).json(provider);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/providers/:providerId", async (request, response, next) => {
    try {
      const current = await getModelProvider(request.params.providerId);
      if (!current) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      const input = patchProviderSchema.parse(request.body ?? {});
      const keyStatus = input.apiKey
        ? await saveProviderApiKey(current.id, input.apiKey)
        : await getProviderApiKeyStatus(current.id);
      const patched = await patchModelProvider(current.id, {
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        defaultModel: input.defaultModel,
        apiKeyConfigured: input.apiKey ? true : keyStatus.configured,
        apiKeyFingerprint: input.apiKey
          ? fingerprintSecret(input.apiKey)
          : keyStatus.fingerprint,
        verificationStatus: input.verificationStatus,
        lastError: input.lastError,
        metadata: input.metadata
      });
      response.json(patched);
    } catch (error) {
      next(error);
    }
  });

  app.post("/providers/verify-batch", async (request, response, next) => {
    try {
      const input = verifyProvidersBatchSchema.parse(request.body ?? {});
      const requestedProviders: ProviderVerificationRequest[] =
        input.providers ??
        input.providerIds?.map((providerId): ProviderVerificationRequest => ({ providerId })) ??
        (await listModelProviders()).map((provider): ProviderVerificationRequest => ({
          providerId: provider.id
        }));

      const results = await Promise.all(
        requestedProviders.map(async (requestedProvider) => {
          const currentProvider = await getModelProvider(requestedProvider.providerId);
          if (!currentProvider) {
            return {
              providerId: requestedProvider.providerId,
              provider: null,
              model: requestedProvider.model ?? null,
              verification: providerVerificationFailure("provider_not_found")
            };
          }

          const provider = requestedProvider.apiKey
            ? currentProvider
            : await withLiveProviderSecretStatus(currentProvider);
          if (requestedProvider.apiKey) {
            await saveProviderApiKey(provider.id, requestedProvider.apiKey);
          }

          const apiKey = requestedProvider.apiKey ?? await readProviderApiKey(provider.id);
          const model = requestedProvider.model ?? provider.defaultModel;
          const verification =
            apiKey && model
              ? await verifyOpenAiCompatibleProvider({
                baseUrl: provider.baseUrl,
                model,
                apiKey,
                timeoutMs: input.timeoutMs
              })
              : providerVerificationFailure("provider_api_key_and_model_required_for_verify");
          const patched = await patchModelProvider(provider.id, {
            apiKeyConfigured: Boolean(apiKey),
            apiKeyFingerprint: apiKey
              ? fingerprintSecret(apiKey)
              : null,
            verificationStatus: verification.status,
            lastVerifiedAt: verification.checkedAt,
            lastError: verification.message,
            metadata: withProviderVerificationMetadata(provider.metadata, verification, model ?? null)
          });

          return {
            providerId: provider.id,
            provider: patched,
            model: model ?? null,
            verification
          };
        })
      );

      response.json({
        checkedAt: new Date().toISOString(),
        count: results.length,
        succeeded: results.filter((result) => result.verification.ok).length,
        failed: results.filter((result) => !result.verification.ok).length,
        results
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/providers/:providerId/verify", async (request, response, next) => {
    try {
      const provider = await getModelProvider(request.params.providerId);
      if (!provider) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      const input = verifyProviderSchema.parse(request.body ?? {});
      const currentProvider = input.apiKey ? provider : await withLiveProviderSecretStatus(provider);
      const apiKey = input.apiKey ?? await readProviderApiKey(currentProvider.id);
      const model = input.model ?? provider.defaultModel;
      if (!apiKey || !model) {
        response.status(400).json({ error: "provider_api_key_and_model_required_for_verify" });
        return;
      }

      if (input.apiKey) {
        await saveProviderApiKey(provider.id, input.apiKey);
      }

      const verification = await verifyOpenAiCompatibleProvider({
        baseUrl: provider.baseUrl,
        model,
        apiKey
      });
      const patched = await patchModelProvider(provider.id, {
        apiKeyConfigured: true,
        apiKeyFingerprint: fingerprintSecret(apiKey),
        verificationStatus: verification.status,
        lastVerifiedAt: verification.checkedAt,
        lastError: verification.message,
        metadata: withProviderVerificationMetadata(provider.metadata, verification, model)
      });
      response.json({
        provider: patched,
        verification
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/agents/:agentId/model-config", async (request, response, next) => {
    try {
      const input = agentModelConfigSchema.parse(request.body ?? {});
      const registryId = agentRegistryId(request.params.agentId);
      let agent = await getAgentConfig(registryId);
      if (!agent) {
        await seedDefaultAgentConfigs();
        agent = await getAgentConfig(registryId);
      }
      if (!agent) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }

      const requestedProvider = input.providerId ? await getModelProvider(input.providerId) : null;
      if (input.providerId && !requestedProvider) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      const existingProvider = requestedProvider ??
        (agent.providerId ? await getModelProvider(agent.providerId) : null);
      const inferredProvider = inferOpenAiCompatibleProviderForModel(
        input.model,
        existingProvider
          ? {
            id: existingProvider.id,
            displayName: existingProvider.displayName,
            baseUrl: existingProvider.baseUrl
          }
          : null
      );
      if (!inferredProvider) {
        response.status(400).json({
          error: "provider_inference_failed",
          message: "Could not infer an OpenAI-compatible provider from the model name.",
          model: input.model
        });
        return;
      }

      const selectedVerification = selectAgentModelVerificationKind(agent, input.model);
      if (selectedVerification.mismatch) {
        const verification = {
          ...providerVerificationFailure(
            selectedVerification.mismatch.message
          ),
          statusCode: 400
        };
        response.status(400).json({
          error: "provider_verification_failed",
          reason: selectedVerification.mismatch.reason,
          provider: {
            id: inferredProvider.id,
            displayName: inferredProvider.displayName,
            baseUrl: inferredProvider.baseUrl,
            defaultModel: null,
            apiKeyConfigured: existingProvider?.apiKeyConfigured ?? false,
            apiKeyFingerprint: existingProvider?.apiKeyFingerprint ?? null,
            verificationStatus: "failed",
            lastVerifiedAt: verification.checkedAt,
            lastError: verification.message,
            metadata: {
              inference: {
                source: inferredProvider.source,
                presetKey: inferredProvider.presetKey ?? null
              }
            }
          },
          verification
        });
        return;
      }
      const verificationKind = selectedVerification.kind;

      const providedApiKey = input.apiKey?.trim() ?? "";
      const storedApiKey = providedApiKey ? "" : await readProviderApiKey(inferredProvider.id);
      const apiKey = providedApiKey || storedApiKey;
      if (!apiKey) {
        response.status(400).json({
          error: "agent_model_api_key_required",
          message: "An API key is required before this agent model can be verified.",
          providerId: inferredProvider.id,
          model: input.model
        });
        return;
      }

      const verification = await verifyAgentModelProvider({
        kind: verificationKind,
        baseUrl: inferredProvider.baseUrl,
        model: input.model,
        apiKey
      });
      if (!verification.ok) {
        const failedProvider = await upsertModelProvider({
          id: inferredProvider.id,
          displayName: inferredProvider.displayName,
          baseUrl: inferredProvider.baseUrl,
          defaultModel: input.model,
          apiKeyConfigured: existingProvider?.apiKeyConfigured ?? Boolean(storedApiKey),
          apiKeyFingerprint: existingProvider?.apiKeyFingerprint ?? (storedApiKey ? fingerprintSecret(storedApiKey) : null),
          verificationStatus: verification.status,
          lastVerifiedAt: verification.checkedAt,
          lastError: verification.message,
          metadata: withProviderVerificationMetadata(
            {
              ...(existingProvider?.metadata ?? {}),
              inference: {
                source: inferredProvider.source,
                presetKey: inferredProvider.presetKey ?? null
              },
              verificationKind
            },
            verification,
            input.model
          )
        });
        response.status(400).json({
          error: "provider_verification_failed",
          reason: providerVerificationFailureCode(verification, input.model),
          provider: failedProvider,
          verification
        });
        return;
      }

      const keyStatus = providedApiKey
        ? await saveProviderApiKey(inferredProvider.id, providedApiKey)
        : await getProviderApiKeyStatus(inferredProvider.id);
      const provider = await upsertModelProvider({
        id: inferredProvider.id,
        displayName: inferredProvider.displayName,
        baseUrl: inferredProvider.baseUrl,
        defaultModel: input.model,
        apiKeyConfigured: keyStatus.configured,
        apiKeyFingerprint: keyStatus.fingerprint,
        verificationStatus: verification.status,
        lastVerifiedAt: verification.checkedAt,
        lastError: null,
        metadata: withProviderVerificationMetadata(
          {
            ...(existingProvider?.metadata ?? {}),
            inference: {
              source: inferredProvider.source,
              presetKey: inferredProvider.presetKey ?? null
            },
            verificationKind
          },
          verification,
          input.model
        )
      });

      const patchedAgent = await patchAgentConfig(registryId, {
        providerId: provider.id,
        model: input.model,
        apiKeyConfigured: keyStatus.configured,
        apiKeyFingerprint: keyStatus.fingerprint,
        openclawSyncStatus: "pending",
        lastError: null,
        metadata: {
          ...(agent.metadata ?? {}),
          configuredFrom: "desktop-agent-model-config",
          requestedAgentId: request.params.agentId,
          verificationKind
        }
      });
      if (!patchedAgent) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }

      let openclawSync:
        | Awaited<ReturnType<typeof applyOpenClawSyncAfterAgentConfig>>
        | {
          ok: false;
          error: string;
          appliedAt: null;
          writtenFiles: string[];
        };
      try {
        openclawSync = await applyOpenClawSyncAfterAgentConfig({
          rootPath: input.openClawRootPath,
          allowDiscoveredUserRuntime: input.allowDiscoveredUserRuntime
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "openclaw_sync_failed";
        openclawSync = {
          ok: false,
          error: message,
          appliedAt: null,
          writtenFiles: []
        };
        await patchAgentConfig(registryId, {
          openclawSyncStatus: "failed",
          lastError: message
        });
      }

      const syncedAgent = await getAgentConfig(registryId);
      response.status(201).json({
        ok: true,
        agent: syncedAgent ?? patchedAgent,
        provider,
        verification,
        openclawSync
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/agents", async (_request, response, next) => {
    try {
      response.json({ agents: await listAgentConfigs() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/agents/seed-defaults", async (request, response, next) => {
    try {
      const input = seedDefaultAgentsSchema.parse(request.body ?? {});
      const provider = input.providerId ? await getModelProvider(input.providerId) : null;
      if (input.providerId && !provider) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      const keyStatus = provider ? await getProviderApiKeyStatus(provider.id) : null;
      const agents = await seedDefaultAgentConfigs({
        panelAgentName: input.panelAgentName,
        providerId: provider?.id ?? input.providerId,
        model: input.model ?? provider?.defaultModel ?? null,
        apiKeyConfigured: keyStatus?.configured ?? provider?.apiKeyConfigured ?? false,
        apiKeyFingerprint: keyStatus?.fingerprint ?? provider?.apiKeyFingerprint ?? null
      });
      response.status(201).json({ agents });
    } catch (error) {
      next(error);
    }
  });

  app.post("/agents", async (request, response, next) => {
    try {
      const input = agentConfigSchema.parse(request.body ?? {});
      if (input.providerId && !(await getModelProvider(input.providerId))) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      response.status(201).json(await upsertAgentConfig(input));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/agents/:agentId", async (request, response, next) => {
    try {
      const input = patchAgentConfigSchema.parse(request.body ?? {});
      if (input.providerId && !(await getModelProvider(input.providerId))) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      const patched = await patchAgentConfig(request.params.agentId, input);
      if (!patched) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }
      response.json(patched);
    } catch (error) {
      next(error);
    }
  });

  app.get("/skills", async (_request, response, next) => {
    try {
      response.json({ skills: await listSkills() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/skills", async (request, response, next) => {
    try {
      const input = skillSchema.parse(request.body ?? {});
      response.status(201).json(await upsertSkill(input));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/skills/:skillId", async (request, response, next) => {
    try {
      const input = patchSkillSchema.parse(request.body ?? {});
      const skill = await patchSkill(request.params.skillId, input);
      if (!skill) {
        response.status(404).json({ error: "skill_not_found" });
        return;
      }
      response.json(skill);
    } catch (error) {
      next(error);
    }
  });

  app.get("/mcp-servers", async (_request, response, next) => {
    try {
      response.json({ servers: await listMcpServers() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp-servers", async (request, response, next) => {
    try {
      const input = mcpServerSchema.parse(request.body ?? {});
      const server = await upsertMcpServer(input);
      invalidateMcpSession(server.id);
      response.status(201).json(server);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/mcp-servers/:serverId", async (request, response, next) => {
    try {
      const input = patchMcpServerSchema.parse(request.body ?? {});
      const server = await patchMcpServer(request.params.serverId, input);
      if (!server) {
        response.status(404).json({ error: "mcp_server_not_found" });
        return;
      }
      invalidateMcpSession(server.id);
      response.json(server);
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp-servers/:serverId/check", async (request, response, next) => {
    try {
      const server = await getMcpServer(request.params.serverId);
      if (!server) {
        response.status(404).json({ error: "mcp_server_not_found" });
        return;
      }
      const check = await checkMcpCommand(server.command);
      const patched = await patchMcpServer(server.id, {
        status: check.status,
        lastCheckedAt: check.checkedAt,
        lastError: check.error,
        config: {
          ...server.config,
          lastCommandCheck: {
            resolvedPath: check.resolvedPath
          }
        }
      });
      response.json({
        server: patched,
        check
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/mcp-policies", async (request, response, next) => {
    try {
      const query = mcpPolicyQuerySchema.parse(request.query);
      response.json({
        policies: await listAgentMcpPolicies(query)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp-policies", async (request, response, next) => {
    try {
      const input = mcpPolicySchema.parse(request.body ?? {});
      if (!(await getAgentConfig(input.agentId))) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }
      if (!(await getMcpServer(input.serverId))) {
        response.status(404).json({ error: "mcp_server_not_found" });
        return;
      }
      response.status(201).json(await upsertAgentMcpPolicy(input));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/mcp-policies/:policyId", async (request, response, next) => {
    try {
      const input = patchMcpPolicySchema.parse(request.body ?? {});
      const policy = await patchAgentMcpPolicy(request.params.policyId, input);
      if (!policy) {
        response.status(404).json({ error: "mcp_policy_not_found" });
        return;
      }
      response.json(policy);
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp-servers/:serverId/tools/list", async (request, response, next) => {
    try {
      const input = mcpListSchema.parse(request.body ?? {});
      const server = await getMcpServer(request.params.serverId);
      if (!server) {
        response.status(404).json({ error: "mcp_server_not_found" });
        return;
      }

      const expectedTarget = formatMcpListTarget(server.id, "tools/list");
      const expectedCommand = formatMcpListCommand(server, "tools/list");
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (!MCP_LIST_TOOL_NAMES.has(approval.toolName) || !MCP_LIST_ACTION_TYPES.has(approval.actionType)) {
        response.status(409).json({
          error: "approval_not_for_mcp_list",
          approval
        });
        return;
      }

      if (approval.target !== expectedTarget) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: expectedTarget,
          actual: approval.target,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand && approvalCommand !== expectedCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: expectedCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const policy = await requireMcpPolicy({
        agentId: approval.agentId,
        serverId: server.id,
        operation: "tools/list"
      });

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "mcp.tools/list"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await runMcpToolsList({
        server,
        cursor: input.cursor,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes
      });
      const patched = await patchMcpServer(server.id, {
        status: "available",
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
        config: {
          ...server.config,
          lastToolsList: mcpDiscoveryConfigEntry(result.result)
        }
      });

      await appendJobEvent(
        approval.jobId,
        "tool.mcp_tools_list_completed",
        {
          approvalId: approval.id,
          policyId: policy.id,
          serverId: server.id,
          serverName: server.name,
          resultPreview: previewJson(result.result),
          stderrPreview: result.stderr.slice(0, 4000),
          durationMs: result.durationMs,
          session: result.session
        },
        {
          actor: "mcp.tools/list",
          stageId: approval.stageId
        }
      );

      response.json({
        approval: consumed.approval,
        server: patched,
        list: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp-servers/:serverId/resources/list", async (request, response, next) => {
    try {
      const input = mcpListSchema.parse(request.body ?? {});
      const server = await getMcpServer(request.params.serverId);
      if (!server) {
        response.status(404).json({ error: "mcp_server_not_found" });
        return;
      }

      const expectedTarget = formatMcpListTarget(server.id, "resources/list");
      const expectedCommand = formatMcpListCommand(server, "resources/list");
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (!MCP_LIST_TOOL_NAMES.has(approval.toolName) || !MCP_LIST_ACTION_TYPES.has(approval.actionType)) {
        response.status(409).json({
          error: "approval_not_for_mcp_list",
          approval
        });
        return;
      }

      if (approval.target !== expectedTarget) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: expectedTarget,
          actual: approval.target,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand && approvalCommand !== expectedCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: expectedCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const policy = await requireMcpPolicy({
        agentId: approval.agentId,
        serverId: server.id,
        operation: "resources/list"
      });

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "mcp.resources/list"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await runMcpResourcesList({
        server,
        cursor: input.cursor,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes
      });
      const patched = await patchMcpServer(server.id, {
        status: "available",
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
        config: {
          ...server.config,
          lastResourcesList: mcpDiscoveryConfigEntry(result.result)
        }
      });

      await appendJobEvent(
        approval.jobId,
        "tool.mcp_resources_list_completed",
        {
          approvalId: approval.id,
          policyId: policy.id,
          serverId: server.id,
          serverName: server.name,
          resultPreview: previewJson(result.result),
          stderrPreview: result.stderr.slice(0, 4000),
          durationMs: result.durationMs,
          session: result.session
        },
        {
          actor: "mcp.resources/list",
          stageId: approval.stageId
        }
      );

      response.json({
        approval: consumed.approval,
        server: patched,
        list: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp-servers/:serverId/tools/call", async (request, response, next) => {
    try {
      const input = mcpToolCallSchema.parse(request.body ?? {});
      const server = await getMcpServer(request.params.serverId);
      if (!server) {
        response.status(404).json({ error: "mcp_server_not_found" });
        return;
      }

      const expectedTarget = formatMcpToolTarget(server.id, input.toolName);
      const expectedCommand = formatMcpToolCommand(server, input.toolName);
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (
        !MCP_TOOL_CALL_TOOL_NAMES.has(approval.toolName) ||
        !MCP_TOOL_CALL_ACTION_TYPES.has(approval.actionType)
      ) {
        response.status(409).json({
          error: "approval_not_for_mcp_tool_call",
          approval
        });
        return;
      }

      if (approval.target !== expectedTarget) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: expectedTarget,
          actual: approval.target,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand && approvalCommand !== expectedCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: expectedCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const policy = await requireMcpPolicy({
        agentId: approval.agentId,
        serverId: server.id,
        operation: "tools/call",
        toolName: input.toolName
      });

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "mcp.tools/call"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await runMcpToolCall({
        server,
        toolName: input.toolName,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes
      });

      await appendJobEvent(
        approval.jobId,
        "tool.mcp_call_completed",
        {
          approvalId: approval.id,
          policyId: policy.id,
          serverId: server.id,
          serverName: server.name,
          toolName: input.toolName,
          displayCommand: result.displayCommand,
          resultPreview: JSON.stringify(result.result).slice(0, 4000),
          stderrPreview: result.stderr.slice(0, 4000),
          durationMs: result.durationMs,
          session: result.session
        },
        {
          actor: "mcp.tools/call",
          stageId: approval.stageId
        }
      );

      response.json({
        approval: consumed.approval,
        call: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/schedules", async (request, response, next) => {
    try {
      const query = listSchedulesQuerySchema.parse(request.query);
      response.json(await listScheduledTasks(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/schedules/due", async (request, response, next) => {
    try {
      const query = dueSchedulesQuerySchema.parse(request.query);
      const now = query.now ? new Date(query.now) : new Date();
      response.json({
        checkedAt: now.toISOString(),
        schedules: await listDueScheduledTasks(now, query.limit)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/schedules/:scheduleId", async (request, response, next) => {
    try {
      const schedule = await getScheduledTask(request.params.scheduleId);
      if (!schedule) {
        response.status(404).json({ error: "schedule_not_found" });
        return;
      }
      response.json(schedule);
    } catch (error) {
      next(error);
    }
  });

  app.post("/schedules", async (request, response, next) => {
    try {
      const input = scheduleSchema.parse(request.body ?? {});
      if (input.providerId && !(await getModelProvider(input.providerId))) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      if (input.agentId && !(await getAgentConfig(input.agentId))) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }
      response.status(201).json(await upsertScheduledTask(input));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/schedules/:scheduleId", async (request, response, next) => {
    try {
      const input = patchScheduleSchema.parse(request.body ?? {});
      if (input.providerId && !(await getModelProvider(input.providerId))) {
        response.status(404).json({ error: "provider_not_found" });
        return;
      }
      if (input.agentId && !(await getAgentConfig(input.agentId))) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }
      const schedule = await patchScheduledTask(request.params.scheduleId, input);
      if (!schedule) {
        response.status(404).json({ error: "schedule_not_found" });
        return;
      }
      response.json(schedule);
    } catch (error) {
      next(error);
    }
  });

  app.post("/schedules/:scheduleId/trigger", async (request, response, next) => {
    try {
      const input = triggerScheduleSchema.parse(request.body ?? {});
      const schedule = await getScheduledTask(request.params.scheduleId);
      if (!schedule) {
        response.status(404).json({ error: "schedule_not_found" });
        return;
      }
      if (!schedule.enabled && !input.force) {
        response.status(409).json({ error: "schedule_disabled", schedule });
        return;
      }

      const job = await createJob({
        rawPrompt: schedule.prompt,
        workdir: schedule.workspacePath ?? undefined,
        ingressOrigin: "http",
        routingMode: schedule.routingMode,
        maxModelCalls: schedule.maxModelCalls,
        requesterId: input.requesterId ?? `schedule:${schedule.id}`
      });
      await appendJobEvent(
        job.id,
        "schedule.triggered",
        {
          scheduleId: schedule.id,
          scheduleType: schedule.scheduleType,
          nextRunAt: schedule.nextRunAt
        },
        {
          actor: "scheduler"
        }
      );

      let workflowId: string | null = null;
      let executionPreflight = job.executionPreflight;
      let startStatus: "idle" | "queued" | "failed" = "idle";
      try {
        if (input.startWorkflow) {
          const started = await preflightAndStartJob(job);
          workflowId = started.workflowId;
          executionPreflight = started.preflight;
          startStatus = started.status === "queued" ? "queued" : "failed";
        }
      } catch (error) {
        await markScheduledTaskTriggered({
          scheduleId: schedule.id,
          jobId: job.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }

      const updatedSchedule = await markScheduledTaskTriggered({
        scheduleId: schedule.id,
        jobId: job.id,
        status: startStatus,
        error: startStatus === "failed" ? "execution_preflight_blocked" : undefined
      });
      const currentJob = input.startWorkflow ? await getJob(job.id) : job;

      response.status(201).json({
        ok: true,
        schedule: updatedSchedule,
        job: currentJob ?? job,
        workflowId,
        preflight: executionPreflight
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact-destination-grants", async (request, response, next) => {
    try {
      const query = artifactDestinationGrantListSchema.parse(request.query);
      response.json({ grants: await listArtifactDestinationGrants(query) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/artifact-destination-grants", async (request, response, next) => {
    try {
      const input = artifactDestinationGrantSchema.parse(request.body ?? {});
      const rootPath = normalizeArtifactDestinationRootPath(input.rootPath);
      const rootPathKey = artifactDestinationRootKey(rootPath);
      const expectedTarget = artifactDestinationApprovalTarget(rootPathKey);
      const approval = await getToolApproval(input.approvalId);
      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }
      if (approval.status !== "approved") {
        response.status(409).json({ error: "approval_not_approved", approval });
        return;
      }
      if (
        !ARTIFACT_DESTINATION_GRANT_TOOL_NAMES.has(approval.toolName) ||
        !ARTIFACT_DESTINATION_GRANT_ACTION_TYPES.has(approval.actionType)
      ) {
        response.status(409).json({ error: "approval_not_for_artifact_destination", approval });
        return;
      }
      if (normalizeArtifactDestinationApprovalTarget(approval.target) !== rootPathKey) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: expectedTarget,
          actual: approval.target,
          approval
        });
        return;
      }
      const expectedCommand = `Grant artifact delivery to ${rootPath}`;
      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand && approvalCommand !== expectedCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: expectedCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }
      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "artifact.destination.grant"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }
      const grant = await upsertArtifactDestinationGrant({
        rootPath,
        rootPathKey,
        displayName: input.displayName,
        approvalId: approval.id,
        grantedBy: input.grantedBy ?? approval.decidedBy ?? null,
        expiresAt: input.expiresAt,
        metadata: input.metadata
      });
      await appendJobEvent(
        approval.jobId,
        "artifact.destination_granted",
        {
          approvalId: approval.id,
          grantId: grant.id,
          rootPath: grant.rootPath,
          expiresAt: grant.expiresAt
        },
        { actor: "artifact.destination.grant", stageId: approval.stageId }
      );
      response.status(201).json({ approval: consumed.approval, grant });
    } catch (error) {
      next(error);
    }
  });

  app.post("/artifact-destination-grants/:grantId/revoke", async (request, response, next) => {
    try {
      const input = destinationAuthorizationRevokeSchema.parse(request.body ?? {});
      const current = await getArtifactDestinationGrant(request.params.grantId);
      if (!current) {
        response.status(404).json({ error: "artifact_destination_grant_not_found" });
        return;
      }
      const result = await revokeArtifactDestinationGrant(current.id);
      const approval = await getToolApproval(current.approvalId);
      if (approval) {
        await appendJobEvent(
          approval.jobId,
          "artifact.destination_revoked",
          {
            grantId: current.id,
            rootPath: current.rootPath,
            changed: result.changed,
            revokedBy: input.revokedBy ?? "desktop-app",
            reason: input.reason ?? null
          },
          { actor: input.revokedBy ?? "desktop-app", stageId: approval.stageId }
        );
      }
      response.json({ ok: true, changed: result.changed, grant: result.grant });
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces", async (request, response, next) => {
    try {
      const query = listRegisteredWorkspacesQuerySchema.parse(request.query);
      response.json({
        workspaces: await listRegisteredWorkspaces(query)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/workspaces/register", async (request, response, next) => {
    try {
      const input = workspaceRegisterSchema.parse(request.body ?? {});
      const resolvedRoot = normalizeWorkspaceRootPath(input.rootPath);
      const rootPathKey = workspaceRootKey(resolvedRoot);
      const expectedTarget = workspaceApprovalTarget(rootPathKey);
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (
        !WORKSPACE_REGISTER_TOOL_NAMES.has(approval.toolName) ||
        !WORKSPACE_REGISTER_ACTION_TYPES.has(approval.actionType)
      ) {
        response.status(409).json({
          error: "approval_not_for_workspace_register",
          approval
        });
        return;
      }

      const approvalTargetKey = normalizeWorkspaceRegistrationTarget(approval.target);
      if (approvalTargetKey !== rootPathKey) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: expectedTarget,
          actual: approval.target,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      const expectedCommand = `Register workspace ${resolvedRoot}`;
      if (approvalCommand && approvalCommand !== expectedCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: expectedCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const target = await resolveWorkspaceDirectoryTarget(resolvedRoot, ".");
      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "workspace.register"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const workspace = await upsertRegisteredWorkspace({
        rootPath: target.rootPath,
        rootPathKey: workspaceRootKey(target.rootPath),
        displayName: input.displayName,
        approvalId: approval.id,
        registeredBy: input.registeredBy ?? approval.decidedBy ?? null,
        metadata: input.metadata
      });

      await appendJobEvent(
        approval.jobId,
        "tool.workspace_registered",
        {
          approvalId: approval.id,
          workspaceId: workspace.id,
          rootPath: workspace.rootPath,
          rootPathKey: workspace.rootPathKey
        },
        {
          actor: "workspace.register",
          stageId: approval.stageId
        }
      );

      response.status(201).json({
        approval: consumed.approval,
        workspace
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/workspaces/:workspaceId/revoke", async (request, response, next) => {
    try {
      const input = destinationAuthorizationRevokeSchema.parse(request.body ?? {});
      const current = await getRegisteredWorkspace(request.params.workspaceId);
      if (!current) {
        response.status(404).json({ error: "workspace_not_found" });
        return;
      }
      const result = await revokeRegisteredWorkspace(current.id);
      const approval = current.approvalId ? await getToolApproval(current.approvalId) : null;
      if (approval) {
        await appendJobEvent(
          approval.jobId,
          "tool.workspace_revoked",
          {
            workspaceId: current.id,
            rootPath: current.rootPath,
            changed: result.changed,
            revokedBy: input.revokedBy ?? "desktop-app",
            reason: input.reason ?? null
          },
          { actor: input.revokedBy ?? "desktop-app", stageId: approval.stageId }
        );
      }
      response.json({ ok: true, changed: result.changed, workspace: result.workspace });
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/inspect", async (request, response, next) => {
    try {
      const query = workspaceRootQuerySchema.parse(request.query);
      const rootPath = await requireRegisteredWorkspaceRoot(query.rootPath, response);
      if (!rootPath) {
        return;
      }
      response.json(await inspectWorkspace(rootPath));
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/files", async (request, response, next) => {
    try {
      const query = workspaceFilesQuerySchema.parse(request.query);
      const rootPath = await requireRegisteredWorkspaceRoot(query.rootPath, response);
      if (!rootPath) {
        return;
      }
      response.json(
        await listWorkspaceFiles(rootPath, {
          subpath: query.subpath,
          depth: query.depth,
          limit: query.limit,
          includeHidden: query.includeHidden
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/file", async (request, response, next) => {
    try {
      const query = workspaceFileQuerySchema.parse(request.query);
      const rootPath = await requireRegisteredWorkspaceRoot(query.rootPath, response);
      if (!rootPath) {
        return;
      }
      response.json(
        await readWorkspaceFile(rootPath, {
          subpath: query.subpath,
          maxBytes: query.maxBytes
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/workspaces/file/write", async (request, response, next) => {
    try {
      const input = workspaceWriteFileSchema.parse(request.body ?? {});
      const rootPath = await requireRegisteredWorkspaceRoot(input.rootPath, response);
      if (!rootPath) {
        return;
      }
      const target = await prepareWorkspaceFileWrite(rootPath, {
        subpath: input.subpath,
        mode: input.mode,
        createParents: input.createParents
      });
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (
        !WORKSPACE_WRITE_TOOL_NAMES.has(approval.toolName) ||
        !WORKSPACE_WRITE_ACTION_TYPES.has(approval.actionType)
      ) {
        response.status(409).json({
          error: "approval_not_for_workspace_write",
          approval
        });
        return;
      }

      const approvalTarget = normalizeApprovalTarget(approval.target);
      if (approvalTarget !== target.relativePath) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: target.relativePath,
          actual: approvalTarget,
          approval
        });
        return;
      }

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "workspace.writeFile"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await writeWorkspaceFile(rootPath, {
        subpath: input.subpath,
        content: input.content,
        mode: input.mode,
        createParents: input.createParents
      });

      await appendJobEvent(
        approval.jobId,
        "tool.workspace_file_written",
        {
          approvalId: approval.id,
          rootPath: result.rootPath,
          relativePath: result.relativePath,
          mode: result.mode,
          bytes: result.bytes,
          size: result.size
        },
        {
          actor: "workspace.writeFile",
          stageId: approval.stageId
        }
      );

      response.status(201).json({
        approval: consumed.approval,
        file: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/workspaces/command/run", async (request, response, next) => {
    try {
      const input = workspaceCommandRunSchema.parse(request.body ?? {});
      const rootPath = await requireRegisteredWorkspaceRoot(input.rootPath, response);
      if (!rootPath) {
        return;
      }
      const cwd = await resolveWorkspaceDirectoryTarget(rootPath, input.cwdSubpath ?? ".");
      const expectedTarget = cwd.relativePath || ".";
      const args = input.args ?? [];
      const displayCommand = formatWorkspaceCommand(input.command, args);
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (
        !WORKSPACE_COMMAND_TOOL_NAMES.has(approval.toolName) ||
        !WORKSPACE_COMMAND_ACTION_TYPES.has(approval.actionType)
      ) {
        response.status(409).json({
          error: "approval_not_for_workspace_command",
          approval
        });
        return;
      }

      const approvalTarget = normalizeApprovalTarget(approval.target);
      if (approvalTarget !== expectedTarget) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: expectedTarget,
          actual: approvalTarget,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand !== displayCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: displayCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "workspace.runCommand"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await runWorkspaceCommand(rootPath, {
        cwdSubpath: input.cwdSubpath,
        command: input.command,
        args,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes
      });

      await appendJobEvent(
        approval.jobId,
        "tool.workspace_command_completed",
        {
          approvalId: approval.id,
          cwdRelativePath: result.cwdRelativePath || ".",
          displayCommand: result.displayCommand,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdoutPreview: result.stdout.slice(0, 4000),
          stderrPreview: result.stderr.slice(0, 4000),
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated
        },
        {
          actor: "workspace.runCommand",
          stageId: approval.stageId
        }
      );

      response.json({
        approval: consumed.approval,
        command: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/tools/web/fetch", async (request, response, next) => {
    try {
      const input = webFetchRunSchema.parse(request.body ?? {});
      const normalizedUrl = normalizeWebFetchUrl(input.url);
      const displayCommand = formatWebFetchCommand(normalizedUrl);
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (!WEB_FETCH_TOOL_NAMES.has(approval.toolName) || !WEB_FETCH_ACTION_TYPES.has(approval.actionType)) {
        response.status(409).json({
          error: "approval_not_for_web_fetch",
          approval
        });
        return;
      }

      const approvalTarget = approval.target ? normalizeWebFetchUrl(approval.target) : null;
      if (approvalTarget !== normalizedUrl) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: normalizedUrl,
          actual: approvalTarget,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand && approvalCommand !== displayCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: displayCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const allowPrivateNetwork = input.allowPrivateNetwork === true;
      if (
        allowPrivateNetwork &&
        !approvalFlag(approval.policy, "allowPrivateNetwork") &&
        !approvalFlag(approval.input, "allowPrivateNetwork")
      ) {
        response.status(409).json({
          error: "private_network_not_approved",
          approval
        });
        return;
      }

      if (
        !(await requireAgentNetworkPolicy({
          approval,
          operation: "web.fetch",
          url: normalizedUrl,
          allowPrivateNetwork,
          response
        }))
      ) {
        return;
      }

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "web.fetch"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await runWebFetch({
        url: normalizedUrl,
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
        allowPrivateNetwork
      });

      await appendJobEvent(
        approval.jobId,
        "tool.web_fetch_completed",
        {
          approvalId: approval.id,
          url: result.url,
          finalUrl: result.finalUrl,
          statusCode: result.statusCode,
          ok: result.ok,
          contentType: result.contentType,
          byteLength: result.byteLength,
          truncated: result.truncated,
          durationMs: result.durationMs,
          bodyPreview: result.bodyText.slice(0, 4000)
        },
        {
          actor: "web.fetch",
          stageId: approval.stageId
        }
      );

      response.json({
        approval: consumed.approval,
        fetch: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/tools/web/search", async (request, response, next) => {
    try {
      const input = webSearchRunSchema.parse(request.body ?? {});
      const searchUrl = buildWebSearchUrl(input.query, input.endpointUrl);
      const displayCommand = formatWebSearchCommand(input.query, input.endpointUrl);
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (!WEB_SEARCH_TOOL_NAMES.has(approval.toolName) || !WEB_SEARCH_ACTION_TYPES.has(approval.actionType)) {
        response.status(409).json({
          error: "approval_not_for_web_search",
          approval
        });
        return;
      }

      const approvalTarget = approval.target ? normalizeWebFetchUrl(approval.target) : null;
      if (approvalTarget !== searchUrl) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: searchUrl,
          actual: approvalTarget,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand && approvalCommand !== displayCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: displayCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const allowPrivateNetwork = input.allowPrivateNetwork === true;
      if (
        allowPrivateNetwork &&
        !approvalFlag(approval.policy, "allowPrivateNetwork") &&
        !approvalFlag(approval.input, "allowPrivateNetwork")
      ) {
        response.status(409).json({
          error: "private_network_not_approved",
          approval
        });
        return;
      }

      if (
        !(await requireAgentNetworkPolicy({
          approval,
          operation: "web.search",
          url: searchUrl,
          allowPrivateNetwork,
          response
        }))
      ) {
        return;
      }

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "web.search"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await runWebSearch({
        query: input.query,
        endpointUrl: input.endpointUrl,
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
        maxResults: input.maxResults,
        allowPrivateNetwork
      });

      await appendJobEvent(
        approval.jobId,
        "tool.web_search_completed",
        {
          approvalId: approval.id,
          query: result.query,
          searchUrl: result.searchUrl,
          resultCount: result.results.length,
          durationMs: result.fetch.durationMs
        },
        {
          actor: "web.search",
          stageId: approval.stageId
        }
      );

      response.json({
        approval: consumed.approval,
        search: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/tools/browser/snapshot", async (request, response, next) => {
    try {
      const input = browserSnapshotRunSchema.parse(request.body ?? {});
      const normalizedUrl = normalizeWebFetchUrl(input.url);
      const displayCommand = formatBrowserSnapshotCommand(normalizedUrl);
      const approval = await getToolApproval(input.approvalId);

      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (approval.status !== "approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval
        });
        return;
      }

      if (
        !BROWSER_SNAPSHOT_TOOL_NAMES.has(approval.toolName) ||
        !BROWSER_SNAPSHOT_ACTION_TYPES.has(approval.actionType)
      ) {
        response.status(409).json({
          error: "approval_not_for_browser_snapshot",
          approval
        });
        return;
      }

      const approvalTarget = approval.target ? normalizeWebFetchUrl(approval.target) : null;
      if (approvalTarget !== normalizedUrl) {
        response.status(409).json({
          error: "approval_target_mismatch",
          expected: normalizedUrl,
          actual: approvalTarget,
          approval
        });
        return;
      }

      const approvalCommand = normalizeApprovalCommand(approval.command);
      if (approvalCommand && approvalCommand !== displayCommand) {
        response.status(409).json({
          error: "approval_command_mismatch",
          expected: displayCommand,
          actual: approvalCommand,
          approval
        });
        return;
      }

      const allowPrivateNetwork = input.allowPrivateNetwork === true;
      if (
        allowPrivateNetwork &&
        !approvalFlag(approval.policy, "allowPrivateNetwork") &&
        !approvalFlag(approval.input, "allowPrivateNetwork")
      ) {
        response.status(409).json({
          error: "private_network_not_approved",
          approval
        });
        return;
      }

      if (
        !(await requireAgentNetworkPolicy({
          approval,
          operation: "browser.snapshot",
          url: normalizedUrl,
          allowPrivateNetwork,
          response
        }))
      ) {
        return;
      }

      const consumed = await consumeToolApproval({
        approvalId: approval.id,
        consumedBy: "browser.snapshot"
      });
      if (!consumed.changed || !consumed.approval) {
        response.status(409).json({
          error: "approval_not_consumable",
          reason: consumed.reason,
          approval: consumed.approval
        });
        return;
      }

      const result = await runBrowserSnapshot({
        url: normalizedUrl,
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
        maxLinks: input.maxLinks,
        allowPrivateNetwork
      });

      await appendJobEvent(
        approval.jobId,
        "tool.browser_snapshot_completed",
        {
          approvalId: approval.id,
          url: result.url,
          finalUrl: result.finalUrl,
          title: result.title,
          linkCount: result.links.length,
          durationMs: result.fetch.durationMs
        },
        {
          actor: "browser.snapshot",
          stageId: approval.stageId
        }
      );

      response.json({
        approval: consumed.approval,
        snapshot: result
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/git/status", async (request, response, next) => {
    try {
      const query = workspaceRootQuerySchema.parse(request.query);
      const rootPath = await requireRegisteredWorkspaceRoot(query.rootPath, response);
      if (!rootPath) {
        return;
      }
      response.json(await getWorkspaceGitStatus(rootPath));
    } catch (error) {
      next(error);
    }
  });

  app.get("/approvals", async (request, response, next) => {
    try {
      await expirePendingToolApprovals();
      const query = listApprovalsQuerySchema.parse(request.query);
      response.json(await listToolApprovals(query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/approvals", async (request, response, next) => {
    try {
      const input = createApprovalSchema.parse(request.body ?? {});
      const approval = await createToolApprovalRequest(input);
      if (!approval) {
        response.status(404).json({ error: "job_or_session_not_found" });
        return;
      }
      response.status(201).json(approval);
    } catch (error) {
      next(error);
    }
  });

  app.get("/approvals/:approvalId", async (request, response, next) => {
    try {
      await expirePendingToolApprovals();
      const approval = await getToolApproval(request.params.approvalId);
      if (!approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }
      response.json(approval);
    } catch (error) {
      next(error);
    }
  });

  async function respondWithApprovalDecision(
    request: express.Request,
    response: express.Response,
    status: "approved" | "rejected" | "cancelled"
  ) {
    const input = decideApprovalSchema.parse(request.body ?? {});
    const approvalId = String(request.params.approvalId ?? "");
    const result = await decideToolApproval({
      approvalId,
      status,
      decidedBy: "desktop-app",
      decisionReason: input.decisionReason
    });

    if (!result.approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }

    if (result.reason === "not_pending") {
      response.status(409).json({
        error: "approval_not_pending",
        approval: result.approval
      });
      return;
    }

    if (result.reason === "expired") {
      response.status(409).json({
        error: "approval_expired",
        approval: result.approval
      });
      return;
    }

    response.json(result);
  }

  app.post("/approvals/:approvalId/approve", async (request, response, next) => {
    try {
      await respondWithApprovalDecision(request, response, "approved");
    } catch (error) {
      next(error);
    }
  });

  app.post("/approvals/:approvalId/reject", async (request, response, next) => {
    try {
      await respondWithApprovalDecision(request, response, "rejected");
    } catch (error) {
      next(error);
    }
  });

  app.post("/approvals/:approvalId/cancel", async (request, response, next) => {
    try {
      await respondWithApprovalDecision(request, response, "cancelled");
    } catch (error) {
      next(error);
    }
  });

  app.post("/approvals/:approvalId/consume", async (request, response, next) => {
    try {
      const input = consumeApprovalSchema.parse(request.body ?? {});
      const result = await consumeToolApproval({
        approvalId: request.params.approvalId,
        consumedBy: input.consumedBy ?? "tool-gateway"
      });

      if (!result.approval) {
        response.status(404).json({ error: "approval_not_found" });
        return;
      }

      if (result.reason === "not_approved") {
        response.status(409).json({
          error: "approval_not_approved",
          approval: result.approval
        });
        return;
      }

      if (result.reason === "expired") {
        response.status(409).json({
          error: "approval_expired",
          approval: result.approval
        });
        return;
      }

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/sessions", async (request, response, next) => {
    try {
      const query = listSessionsQuerySchema.parse(request.query);
      response.json(await listSessions(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sessions/:sessionId/events", async (request, response, next) => {
    try {
      const query = sessionEventsQuerySchema.parse(request.query);
      response.json(await getSessionEvents(request.params.sessionId, query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sessions/:sessionId/events/stream", async (request, response, next) => {
    try {
      const query = sessionEventsStreamQuerySchema.parse(request.query);
      const pollMs = query.pollMs ?? 1000;
      const heartbeatMs = query.heartbeatMs ?? 15000;
      const limit = query.limit ?? 100;
      let afterSeq = query.afterSeq ?? 0;
      let closed = false;
      let inFlight = false;

      const initial = await getSessionEventsAfter(request.params.sessionId, {
        afterSeq,
        limit
      });
      if (!initial) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      response.write(`retry: ${Math.max(pollMs, 1000)}\n\n`);

      const writeEvent = (event: string, data: unknown, id?: string | number) => {
        if (closed) {
          return;
        }
        if (id !== undefined) {
          response.write(`id: ${id}\n`);
        }
        response.write(`event: ${event}\n`);
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      writeEvent("ready", {
        sessionId: request.params.sessionId,
        afterSeq,
        pollMs,
        heartbeatMs,
        limit
      });

      const pump = async () => {
        if (closed || inFlight) {
          return;
        }
        inFlight = true;
        try {
          const batch = await getSessionEventsAfter(request.params.sessionId, {
            afterSeq,
            limit
          });
          if (!batch) {
            writeEvent("closed", {
              reason: "session_not_found",
              sessionId: request.params.sessionId
            });
            response.end();
            closed = true;
            return;
          }

          for (const event of batch.events) {
            afterSeq = event.seq;
            writeEvent("session_event", event, event.seq);
          }
        } catch (error) {
          writeEvent("error", {
            message: error instanceof Error ? error.message : "unknown_error"
          });
        } finally {
          inFlight = false;
        }
      };

      await pump();

      const pollTimer = setInterval(() => {
        void pump();
      }, pollMs);
      const heartbeatTimer = setInterval(() => {
        if (!closed) {
          response.write(`: heartbeat ${new Date().toISOString()} seq=${afterSeq}\n\n`);
        }
      }, heartbeatMs);

      request.on("close", () => {
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/archive", async (request, response, next) => {
    try {
      const input = archiveSessionSchema.parse(request.body ?? {});
      const job = await getJobBySessionId(request.params.sessionId);
      if (!job) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      const archived = await archiveJobSession({
        jobId: job.id,
        retentionDays: input.retentionDays,
        reason: input.reason ?? "session_archived"
      });
      response.json({
        ok: true,
        changed: !job.archivedAt,
        sessionId: request.params.sessionId,
        job: archived
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/restore", async (request, response, next) => {
    try {
      const input = restoreSessionSchema.parse(request.body ?? {});
      const job = await restoreJobSession({
        sessionId: request.params.sessionId,
        reason: input.reason ?? "session_restored",
        requesterId: input.requesterId
      });
      if (!job) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      response.json({
        ok: true,
        sessionId: request.params.sessionId,
        job
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/fork", async (request, response, next) => {
    try {
      const input = forkSessionSchema.parse(request.body ?? {});
      const source = await getJobBySessionId(request.params.sessionId);
      if (!source) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      const forked = await createJob({
        rawPrompt: input.prompt ?? source.rawPrompt,
        workdir: input.inheritWorkdir ? source.workdir ?? undefined : undefined,
        ingressOrigin: "http",
        routingMode: input.routingMode ?? source.routingMode,
        maxModelCalls: input.maxModelCalls ?? source.maxModelCalls,
        maxCostUsd: input.maxCostUsd ?? source.maxCostUsd ?? undefined,
        classicFinalGateEnabled: input.classicFinalGateEnabled ?? source.classicFinalGateEnabled,
        discussionRounds: input.discussionRounds ?? source.discussionRounds,
        requesterId: input.requesterId ?? "session-fork"
      });
      await appendJobEvent(forked.id, "session.forked", {
        sourceSessionId: source.sessionId,
        sourceJobId: source.id,
        inheritedWorkdir: input.inheritWorkdir
      }, {
        actor: "session-ledger"
      });
      const started = input.startWorkflow ? await preflightAndStartJob(forked) : null;
      const currentFork = started ? await getJob(forked.id) : forked;
      response.status(201).json({
        ok: true,
        sourceSessionId: source.sessionId,
        sessionId: forked.sessionId,
        job: currentFork ?? forked,
        workflowId: started?.workflowId ?? null,
        preflight: started?.preflight ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/compress", async (request, response, next) => {
    try {
      const input = compressSessionSchema.parse(request.body ?? {});
      const result = await compressSession(request.params.sessionId, input);
      if (!result) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      response.json({
        ok: true,
        ...result
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/plans", async (request, response, next) => {
    try {
      const query = listPlansQuerySchema.parse(request.query);
      response.json(await listPlans(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/plans/:planId", async (request, response, next) => {
    try {
      const plan = await getPlan(request.params.planId);
      if (!plan) {
        response.status(404).json({ error: "plan_not_found" });
        return;
      }
      response.json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/plans/:planId", async (request, response, next) => {
    try {
      const input = updatePlanSchema.parse(request.body ?? {});
      const plan = await updatePlan(request.params.planId, input);
      if (!plan) {
        response.status(404).json({ error: "plan_not_found" });
        return;
      }
      response.json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.post("/plans/:planId/items", async (request, response, next) => {
    try {
      const input = createPlanItemSchema.parse(request.body ?? {});
      const item = await createPlanItem(request.params.planId, input);
      if (!item) {
        response.status(404).json({ error: "plan_not_found" });
        return;
      }
      response.status(201).json(item);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/plans/:planId/items/:itemId", async (request, response, next) => {
    try {
      const input = updatePlanItemSchema.parse(request.body ?? {});
      const item = await updatePlanItem(request.params.planId, request.params.itemId, input);
      if (!item) {
        response.status(404).json({ error: "plan_item_not_found" });
        return;
      }
      response.json(item);
    } catch (error) {
      next(error);
    }
  });

  app.get("/memory/experiences", async (request, response, next) => {
    try {
      const query = listExperiencesQuerySchema.parse(request.query);
      response.json(await listExperiences(query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/memory/experiences/:experienceId/adopt", async (request, response, next) => {
    try {
      await respondWithExperienceStatus(request, response, "adopted");
    } catch (error) {
      next(error);
    }
  });

  app.post("/memory/experiences/:experienceId/reject", async (request, response, next) => {
    try {
      await respondWithExperienceStatus(request, response, "rejected");
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId", async (request, response, next) => {
    try {
      const job = await getJob(request.params.jobId);

      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      response.json(job);
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/messages", async (request, response, next) => {
    try {
      const job = await getJob(request.params.jobId);

      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      const messages = await getGroupMessagesForJob(request.params.jobId);
      response.json({
        jobId: job.id,
        ingressOrigin: job.ingressOrigin,
        messages
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/artifacts", async (request, response, next) => {
    try {
      const job = await getJob(request.params.jobId);

      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      const artifacts = await listArtifactsForJob(request.params.jobId);
      const canonicalFiles = await listArtifactFilesForJob(request.params.jobId);
      const deliveries = await listArtifactDeliveriesForJob(request.params.jobId);
      const canonicalFileById = new Map(canonicalFiles.map((file) => [file.id, file]));
      const artifactSummaries = await Promise.all(
        artifacts.map(async (artifact) => {
          const files = await Promise.all(
            extractArtifactFileRefs(artifact).map(async (file) => {
              if (!file.filePath) {
                return {
                  ...file,
                  downloadable: Boolean(file.externalUrl),
                  downloadUrl: null
                };
              }

              try {
                const fileStat = await stat(file.filePath);
                return {
                  ...file,
                  downloadable: fileStat.isFile(),
                  sizeBytes: file.sizeBytes ?? (fileStat.isFile() ? fileStat.size : null),
                  downloadUrl: fileStat.isFile()
                    ? `/jobs/${job.id}/artifacts/${artifact.id}/files/${file.index}`
                    : null
                };
              } catch {
                return {
                  ...file,
                  downloadable: false,
                  downloadUrl: null
                };
              }
            })
          );

          return {
            id: artifact.id,
            jobId: artifact.jobId,
            stageId: artifact.stageId,
            type: artifact.type,
            title: artifact.title,
            uri: artifact.uri,
            metadata: artifact.metadata,
            createdAt: artifact.createdAt,
            files
          };
        })
      );

      response.json({
        jobId: job.id,
        artifactCount: artifactSummaries.length,
        fileCount: artifactSummaries.reduce((count, artifact) => count + artifact.files.length, 0),
        artifacts: artifactSummaries,
        artifactFiles: canonicalFiles.map((file) => canonicalArtifactFileView(job.id, file)),
        deliveries: deliveries.map((delivery) =>
          artifactDeliveryView(job.id, delivery, canonicalFileById.get(delivery.artifactFileId) ?? null)
        )
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/artifact-files/:artifactFileId/content", async (request, response, next) => {
    try {
      const file = await getArtifactFileForJob(request.params.jobId, request.params.artifactFileId);
      if (!file || file.status !== "available" || !file.filePath) {
        response.status(404).json({ error: "artifact_file_not_found" });
        return;
      }

      const safePath = resolveArtifactFilePath(file.filePath);
      if (!safePath) {
        response.status(404).json({ error: "artifact_file_not_found" });
        return;
      }
      const fileStat = await stat(safePath).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size <= 0) {
        response.status(404).json({ error: "artifact_file_not_found" });
        return;
      }

      const fileName = path.basename(file.fileName);
      response.setHeader("Content-Type", file.mimeType ?? "application/octet-stream");
      response.setHeader("Content-Length", fileStat.size.toString());
      response.setHeader(
        "Content-Disposition",
        `inline; filename="${fileName.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );
      response.sendFile(safePath);
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/deliveries", async (request, response, next) => {
    try {
      const job = await getJob(request.params.jobId);
      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }
      const [summary, files] = await Promise.all([
        getArtifactDeliverySummary(job.id),
        listArtifactFilesForJob(job.id)
      ]);
      const fileById = new Map(files.map((file) => [file.id, file]));
      response.json({
        jobId: job.id,
        requiredCount: summary.requiredCount,
        succeededCount: summary.succeededCount,
        failedCount: summary.failedCount,
        pendingCount: summary.pendingCount,
        deliveringCount: summary.deliveringCount,
        readyToFinalize: summary.readyToFinalize,
        deliveries: summary.deliveries.map((delivery) =>
          artifactDeliveryView(job.id, delivery, fileById.get(delivery.artifactFileId) ?? null)
        )
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/deliveries/:deliveryId/claim", async (request, response, next) => {
    try {
      const input = artifactDeliveryClaimSchema.parse(request.body ?? {});
      const result = await claimArtifactDelivery({
        jobId: request.params.jobId,
        deliveryId: request.params.deliveryId,
        leaseSeconds: input.leaseSeconds
      });
      if (!result.delivery) {
        response.status(404).json({ error: "artifact_delivery_not_found" });
        return;
      }
      if (!result.claimed || !result.claimToken) {
        response.status(409).json({
          error: "artifact_delivery_not_claimable",
          reason: result.reason,
          status: result.delivery.status,
          authorizationStatus: result.delivery.authorizationStatus,
          authorizationError: result.delivery.authorizationError,
          leaseExpiresAt: result.delivery.leaseExpiresAt
        });
        return;
      }
      const file = await getArtifactFileForJob(request.params.jobId, result.delivery.artifactFileId);
      if (!file || file.status !== "available" || !file.filePath) {
        await failArtifactDelivery({
          jobId: request.params.jobId,
          deliveryId: result.delivery.id,
          claimToken: result.claimToken,
          error: "artifact_source_unavailable"
        });
        response.status(409).json({ error: "artifact_source_unavailable" });
        return;
      }
      response.json({
        ok: true,
        claimToken: result.claimToken,
        delivery: artifactDeliveryView(request.params.jobId, result.delivery, file, { includeDestination: true })
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/deliveries/:deliveryId/complete", async (request, response, next) => {
    try {
      const input = artifactDeliveryCompleteSchema.parse(request.body ?? {});
      const result = await completeArtifactDelivery({
        jobId: request.params.jobId,
        deliveryId: request.params.deliveryId,
        ...input
      });
      if (!result.delivery) {
        response.status(404).json({ error: "artifact_delivery_not_found" });
        return;
      }
      if (!result.completed) {
        response.status(409).json({
          error: "artifact_delivery_completion_rejected",
          status: result.delivery.status,
          reason: result.rejectionReason,
          expectedSizeBytes: result.delivery.expectedSizeBytes,
          expectedChecksumSha256: result.delivery.expectedChecksumSha256
        });
        return;
      }
      const finalization = await maybeStartArtifactDeliveryFinalization(request.params.jobId);
      response.json({ ok: true, delivery: result.delivery, finalization });
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/deliveries/:deliveryId/fail", async (request, response, next) => {
    try {
      const input = artifactDeliveryFailSchema.parse(request.body ?? {});
      const result = await failArtifactDelivery({
        jobId: request.params.jobId,
        deliveryId: request.params.deliveryId,
        ...input
      });
      if (!result.delivery) {
        response.status(404).json({ error: "artifact_delivery_not_found" });
        return;
      }
      if (!result.failed) {
        response.status(409).json({ error: "artifact_delivery_failure_rejected", status: result.delivery.status });
        return;
      }
      await setJobStatus(request.params.jobId, "waiting_for_human", {
        reason: "artifact_delivery_failed",
        deliveryId: result.delivery.id,
        error: result.delivery.lastError
      });
      response.json({ ok: true, delivery: result.delivery });
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/deliveries/finalize", async (request, response, next) => {
    try {
      const job = await getJob(request.params.jobId);
      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }
      const finalization = await maybeStartArtifactDeliveryFinalization(job.id);
      response.status(finalization.status === "failed" ? 503 : 200).json({ ok: finalization.status !== "failed", finalization });
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/artifacts/:artifactId/files/:fileIndex", async (request, response, next) => {
    try {
      const fileIndex = artifactFileIndexSchema.parse(request.params.fileIndex);
      const artifact = await getArtifactForJob(request.params.jobId, request.params.artifactId);

      if (!artifact) {
        response.status(404).json({ error: "artifact_not_found" });
        return;
      }

      const file = extractArtifactFileRefs(artifact).find((candidate) => candidate.index === fileIndex);
      if (!file) {
        response.status(404).json({ error: "artifact_file_not_found" });
        return;
      }

      if (!file.filePath) {
        response.status(404).json({ error: "artifact_file_not_found" });
        return;
      }

      const fileStat = await stat(file.filePath).catch(() => null);
      if (!fileStat?.isFile()) {
        response.status(404).json({ error: "artifact_file_not_found" });
        return;
      }

      const fileName = path.basename(file.fileName);
      response.setHeader("Content-Type", file.mimeType ?? "application/octet-stream");
      response.setHeader(
        "Content-Disposition",
        `inline; filename="${fileName.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );
      response.sendFile(file.filePath);
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/cancel", async (request, response, next) => {
    try {
      const input = cancelJobSchema.parse(request.body ?? {});
      const result = await cancelJob({
        jobId: request.params.jobId,
        reason: input.reason,
        requesterId: input.requesterId
      });

      if (!result.job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      if (result.reason === "already_terminal") {
        response.status(409).json({
          error: "job_already_terminal",
          jobId: result.job.id,
          status: result.job.status
        });
        return;
      }

      let workflowCancellation: "requested" | "not_available" | "failed" = "not_available";
      if (result.job.workflowId) {
        try {
          await cancelJobWorkflow(result.job.workflowId);
          workflowCancellation = "requested";
          if (result.changed) {
            await appendJobEvent(
              result.job.id,
              "job.workflow_cancel_requested",
              { workflowId: result.job.workflowId },
              { actor: "system" }
            );
          }
        } catch (error) {
          workflowCancellation = "failed";
          if (result.changed) {
            await appendJobEvent(
              result.job.id,
              "job.workflow_cancel_failed",
              {
                workflowId: result.job.workflowId,
                error: error instanceof Error ? error.message : String(error)
              },
              { actor: "system" }
            ).catch(() => undefined);
          }
        }
      }

      response.json({
        ok: true,
        changed: result.changed,
        reason: result.reason,
        jobId: result.job.id,
        status: result.job.status,
        workflowCancellation
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/resume", async (request, response, next) => {
    try {
      const input = resumeJobSchema.parse(request.body ?? {});
      const unresolvedModelCalls = await listUnknownOutcomeModelCallsForJob(
        routeParameter(request.params.jobId)
      );
      if (unresolvedModelCalls.length > 0) {
        response.status(409).json({
          error: "model_call_reconciliation_required",
          jobId: routeParameter(request.params.jobId),
          canResume: false,
          modelCalls: unresolvedModelCalls.map(unknownOutcomeModelCallView)
        });
        return;
      }
      const resume = await requestJobResume({
        jobId: request.params.jobId,
        workflowId: `job-${request.params.jobId}-resume-${randomUUID().slice(0, 12)}`,
        reason: input.reason,
        requesterId: input.requesterId,
        maxModelCalls: input.maxModelCalls,
        maxCostUsd: input.maxCostUsd
      });

      if (!resume.job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      if (!resume.changed) {
        response.status(409).json({
          error: "job_not_resumable",
          reason: resume.reason,
          jobId: resume.job.id,
          status: resume.job.status,
          heartbeatStatus: resume.job.heartbeatStatus
        });
        return;
      }

      const preflight = await runJobExecutionPreflight(resume.job);
      if (preflight.status === "blocked") {
        await setJobStatus(resume.job.id, "waiting_for_human", {
          source: "job.execution_preflight",
          reason: "agent_runtime_configuration_blocked",
          blockingIssues: preflight.blockingIssues
        });
        response.status(409).json({
          error: "execution_preflight_blocked",
          jobId: resume.job.id,
          status: "waiting_for_human",
          preflight
        });
        return;
      }

      const workflowId = await startJobWorkflow(
        request.params.jobId,
        resume.workflowId,
        { resumeExisting: resume.resumeExistingWorkflow }
      );
      const job = await getJob(request.params.jobId);

      response.json({
        ok: true,
        changed: true,
        reason: resume.reason,
        jobId: request.params.jobId,
        status: job?.status ?? resume.job.status,
        heartbeatStatus: job?.heartbeatStatus ?? resume.job.heartbeatStatus,
        workflowId,
        maxModelCalls: job?.maxModelCalls ?? resume.maxModelCalls,
        maxCostUsd: job?.maxCostUsd ?? resume.maxCostUsd,
        spendBudget: job?.spendBudget ?? resume.job.spendBudget,
        preflight
      });
    } catch (error) {
      await appendJobEvent(
        request.params.jobId,
        "job.resume_failed",
        {
          error: error instanceof Error ? error.message : String(error)
        },
        {
          actor: "system"
        }
      ).catch(() => undefined);
      next(error);
    }
  });

  app.post("/jobs/:jobId/plan", async (request, response, next) => {
    try {
      const input = createJobPlanSchema.parse(request.body ?? {});
      const plan = await createPlanForJob(request.params.jobId, input);
      if (!plan) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }
      response.status(201).json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/details", async (request, response, next) => {
    try {
      const details = await getJobDetails(request.params.jobId);

      if (!details.job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      response.json(details);
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/timeline", async (request, response, next) => {
    try {
      const query = timelineQuerySchema.parse(request.query);
      const timeline = await getJobTimeline(request.params.jobId, {
        limit: query.limit,
        since: query.since,
        cursor: query.cursor
      });

      if (!timeline.job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      response.json(timeline);
    } catch (error) {
      if (error instanceof InvalidTimelineCursorError) {
        response.status(400).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "invalid_request", issues: error.issues });
      return;
    }

    if (error instanceof WorkspacePathError) {
      response.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof ArtifactDestinationPathError) {
      response.status(400).json({ error: error.code });
      return;
    }

    if (error instanceof WebFetchError) {
      response.status(error.code === "private_network_blocked" ? 403 : 400).json({
        error: error.code,
        message: error.message,
        details: error.details
      });
      return;
    }

    if (error instanceof McpToolError) {
      response.status(400).json({
        error: error.code,
        message: error.message,
        details: error.details
      });
      return;
    }

    if (error instanceof OpenClawSyncSafetyError) {
      response.status(409).json({
        error: error.code,
        message: error.message,
        details: error.details
      });
      return;
    }

    if (error instanceof ConversationSourceMessageNotFoundError) {
      response.status(404).json({ error: error.message });
      return;
    }

    if (
      error instanceof ConversationSourceMessageConflictError ||
      error instanceof ConversationRecordConflictError ||
      error instanceof ConversationRecordDeletedError
    ) {
      response.status(409).json({ error: error.message });
      return;
    }

    console.error(error);
    response.status(500).json({ error: "internal_error" });
  });

  const httpServer = app.listen(port, host, () => {
    console.log(`Orchestrator API listening on http://${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down orchestrator API`);

    const forceExitTimer = setTimeout(() => {
      console.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    closeAllMcpSessions();
    httpServer.close(() => {
      void closePool()
        .catch((error) => {
          console.error("Failed to close database pool", error);
        })
        .finally(() => {
          process.exit(0);
        });
    });
    httpServer.closeAllConnections();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
