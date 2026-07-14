import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FolderPlus,
  FolderOpen,
  Gauge,
  History,
  KeyRound,
  Languages,
  ListChecks,
  LockKeyhole,
  Mail,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Pin,
  Play,
  Plus,
  MoreHorizontal,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldQuestion,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import {
  adoptExperience,
  approveToolApproval,
  cancelJob,
  claimArtifactDelivery,
  completeArtifactDelivery,
  createJob,
  deleteConversationProject as deleteBackendConversationProject,
  deleteConversationRecord as deleteBackendConversation,
  getHealth,
  getJob,
  getJobArtifacts,
  getJobDeliveries,
  failArtifactDelivery,
  finalizeArtifactDeliveries,
  resolveArtifactDownloadRequest,
  getJobTimeline,
  listJobUnknownOutcomes,
  getRuntimeDiagnostics,
  listExperiences,
  listAgentConfigs,
  listJobs,
  listModelProviders,
  listRuntimeRepairActions,
  listToolApprovals,
  rejectExperience,
  rejectToolApproval,
  reconcileJobUnknownOutcome,
  resumeJob,
  runRuntimeRepairAction,
  saveAgentModelConfig as saveBackendAgentModelConfig,
  sendPanelChat,
  syncConversationWorkspace,
  type PanelOutputStyle,
  type ExperienceListResponse,
  type ExperienceRecord,
  type ExperienceStatus,
  type AgentConfigRecord,
  type JobRecord,
  type JobDeliveriesResponse,
  type JobStatus,
  type JobTimeline,
  type ListJobsResponse,
  type ModelCallReconciliationAction,
  type UnknownOutcomeModelCallsResponse,
  type RuntimeDiagnosticsResponse,
  type RuntimeRepairAction,
  type RuntimeRepairActionId,
  type RoutingMode,
  type ModelProviderRecord,
  type ToolApprovalRecord,
  type ConversationWorkspaceSnapshot
} from "./api";
import {
  inferJobDisplayTitle,
  userTaskPrompt
} from "../../../packages/shared/src/job-title";
import type {
  TaskExecutionPreflight,
  TaskExecutionRetryState,
  TaskOrchestrationPlan
} from "../../../packages/shared/src/types";
import { FirstRunPanel, type FirstRunFlow } from "./firstRun";
import { HoneycombLogo } from "./brand";
import {
  loadSeenNotificationIds,
  saveSeenNotificationIds,
  showDesktopNotification,
  type DesktopNotificationPayload
} from "./notifications";
import "./styles.css";

type ApiState = "checking" | "online" | "offline";
type JobStatusFilter = "all" | "running" | "waiting_for_human" | "cancelled";
type JobTimeFilter = "all" | "24h" | "7d" | "custom";
type Language = "en" | "zh";
type AppView =
  | "dashboard"
  | "setup"
  | "conversations"
  | "jobs"
  | "approvals"
  | "agents"
  | "models"
  | "memory"
  | "settings";
type TourAnchor = "activity" | "dashboard" | "setup" | "jobs" | "settings";

type SecurityRecord = {
  passwordSalt: string;
  passwordHash: string;
  recoveryQuestion?: string;
  recoveryQuestionId?: RecoveryQuestionId;
  recoverySalt?: string;
  recoveryHash?: string;
  updatedAt: string;
};

type RecoveryQuestionId = "first_project" | "favorite_place" | "first_tool" | "mentor_name" | "memorable_date";

type FirstRunPreview = {
  provider?: {
    providerName?: string;
    baseUrl?: string;
    model?: string;
    apiKeyConfigured?: boolean;
  };
  profile?: {
    supervisorName?: string;
    outputStyle?: PanelOutputStyle;
  };
};

type SupervisorPermissionKey =
  | "readWorkspace"
  | "writeWorkspace"
  | "runCommands"
  | "networkAccess"
  | "mcpTools";

type SupervisorWorkbenchConfig = {
  workspacePath: string;
  permissions: Record<SupervisorPermissionKey, boolean>;
  skills: string;
  mcpServers: string;
  updatedAt: string;
};

type ConversationThread = {
  id: string;
  title: string;
  draft: string;
  updatedAt: string;
  pinned?: boolean;
  unread?: boolean;
  archivedAt?: string;
  attachments?: ConversationAttachment[];
  messages?: ConversationMessage[];
};

type ConversationAttachment = {
  id: string;
  name: string;
  path: string;
  addedAt: string;
};

type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  body: string;
  createdAt: string;
  jobId?: string;
  status?: "sent" | "failed" | "offline";
  attachments?: ConversationAttachment[];
};

type ConversationProject = {
  id: string;
  name: string;
  path: string;
  threads: ConversationThread[];
  updatedAt: string;
  pinned?: boolean;
  archivedAt?: string;
};

type ConversationWorkspaceState = {
  projects: ConversationProject[];
  activeProjectId: string;
  activeThreadId: string;
};

type ConversationContextMenuState =
  | {
      kind: "thread";
      projectId: string;
      threadId: string;
      x: number;
      y: number;
    }
  | {
      kind: "project";
      projectId: string;
      x: number;
      y: number;
    }
  | null;

type ArchiveDeleteTarget =
  | {
      kind: "conversation";
      projectId: string;
      threadId: string;
      title: string;
      subtitle: string;
    }
  | {
      kind: "project";
      projectId: string;
      title: string;
      subtitle: string;
      archived: boolean;
    };

type TextInputDialogState = {
  title: string;
  label: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
};

type WorkbenchStepState = "done" | "active" | "pending" | "blocked";

type WorkbenchPlanStep = {
  title: string;
  body: string;
  state: WorkbenchStepState;
};

type AgentModelConfig = {
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  verifiedAt?: string;
  appliedAt?: string;
};

type AgentConfigDraft = AgentModelConfig;

type ProviderConnectionResult = {
  ok: boolean;
  message?: string;
  openclawManifestPath?: string;
};

type RoutingFlowStep = {
  title: string;
  body: string;
};

const routingModes: RoutingMode[] = [
  "supervisor_pipeline",
  "pipeline",
  "classic_master_slave",
  "master_slave_discussion"
];

const panelOutputStyles: PanelOutputStyle[] = ["concise", "detailed", "warm", "formal"];

const routingModeLabels: Record<Language, Record<RoutingMode, string>> = {
  en: {
    supervisor_pipeline: "Supervisor Pipeline",
    pipeline: "Sequential Pipeline",
    classic_master_slave: "Classic Lead + Workers",
    master_slave_discussion: "Lead + Team Discussion"
  },
  zh: {
    supervisor_pipeline: "监督者流水线",
    pipeline: "顺序流水线",
    classic_master_slave: "经典主从协作",
    master_slave_discussion: "主从讨论协作"
  }
};

const routingModeFlows: Record<Language, Record<RoutingMode, RoutingFlowStep[]>> = {
  en: {
    supervisor_pipeline: [
      { title: "Panel agent reads the task", body: "The supervisor clarifies the goal, risk, quality bar, and whether tools or files are needed." },
      { title: "Planner creates stages", body: "The main agent turns the task into ordered stages and assigns suitable specialist agents." },
      { title: "Specialists execute", body: "Research, writing, image, video, or other workers run their own stage with scoped instructions." },
      { title: "Supervisor gate", body: "A test or supervisor agent checks the result against acceptance criteria before final synthesis." },
      { title: "Final answer", body: "The main agent merges approved work and reports what was done, what changed, and what remains." }
    ],
    pipeline: [
      { title: "Task intake", body: "The panel agent identifies a clear step-by-step production path." },
      { title: "Stage 1", body: "The first specialist produces the upstream material needed by the next specialist." },
      { title: "Stage 2", body: "The next specialist continues from the previous artifact instead of restarting." },
      { title: "Stage 3", body: "Later stages refine, package, or prepare the final deliverable." },
      { title: "Final check", body: "The result is checked once at the end before delivery." }
    ],
    classic_master_slave: [
      { title: "Lead receives the task", body: "The main agent decides what can be delegated and what must remain centralized." },
      { title: "Workers run in parallel", body: "Several agents handle independent subtasks such as research, drafting, or review." },
      { title: "Lead collects results", body: "The main agent compares worker outputs and resolves conflicts or missing parts." },
      { title: "Review pass", body: "The reviewer checks whether the combined result meets the user's request." },
      { title: "Delivery", body: "The lead returns one coherent final result." }
    ],
    master_slave_discussion: [
      { title: "Lead frames the question", body: "The main agent turns an ambiguous task into a discussion agenda." },
      { title: "Round discussion", body: "Specialist agents contribute different viewpoints, objections, and alternatives." },
      { title: "Second pass", body: "Agents react to each other and refine weak assumptions." },
      { title: "Synthesis", body: "The lead agent merges the discussion into a practical recommendation." },
      { title: "Quality check", body: "The result is checked for gaps, contradictions, and next actions." }
    ]
  },
  zh: {
    supervisor_pipeline: [
      { title: "面板 agent 读取任务", body: "主管先判断目标、风险、质量标准，以及是否需要工具或本地文件。" },
      { title: "主控 agent 制定阶段", body: "主控把任务拆成有顺序的阶段，并分配合适的专业 agent。" },
      { title: "专业 agent 执行", body: "研究、写作、图像、视频等 agent 按自己的阶段产出内容。" },
      { title: "监督关卡", body: "质检或监督 agent 按验收标准检查结果，不通过就要求返工。" },
      { title: "最终整合", body: "主控整合通过检查的内容，给出最终结果和剩余风险。" }
    ],
    pipeline: [
      { title: "任务进入", body: "面板 agent 判断这是清晰的分步骤生产任务。" },
      { title: "第一阶段", body: "第一个专业 agent 产出下游需要的基础材料。" },
      { title: "第二阶段", body: "后续 agent 继承上一阶段产物继续处理，而不是重新开始。" },
      { title: "第三阶段", body: "后续阶段继续细化、包装或准备最终交付物。" },
      { title: "最终检查", body: "所有阶段完成后统一做一次质量检查，再交付给用户。" }
    ],
    classic_master_slave: [
      { title: "主控接收任务", body: "主控 agent 判断哪些部分可以分派，哪些必须由自己集中处理。" },
      { title: "子 agent 并行工作", body: "多个专业 agent 分别处理研究、草稿、校对等相互独立的子任务。" },
      { title: "主控收集结果", body: "主控对比不同子 agent 的结果，解决冲突和缺口。" },
      { title: "评审通过", body: "评审 agent 检查组合结果是否符合用户请求。" },
      { title: "统一交付", body: "主控输出一份连贯的最终结果。" }
    ],
    master_slave_discussion: [
      { title: "主控定义议题", body: "主控把模糊任务整理成可讨论的问题和判断标准。" },
      { title: "多 agent 讨论", body: "不同专业 agent 给出观点、反对意见和备选方案。" },
      { title: "第二轮校正", body: "各 agent 根据彼此观点修正弱假设，补充遗漏信息。" },
      { title: "主控综合", body: "主控把讨论结果整理成可执行建议。" },
      { title: "质量检查", body: "最终检查结论是否有矛盾、遗漏和下一步行动。" }
    ]
  }
};

const cancellableStatuses: JobStatus[] = [
  "created",
  "queued",
  "planning",
  "running",
  "testing",
  "fixing",
  "waiting_for_human"
];

const jobStatusFilters: Array<{ id: JobStatusFilter; status?: JobStatus }> = [
  { id: "all" },
  { id: "running", status: "running" },
  { id: "waiting_for_human", status: "waiting_for_human" },
  { id: "cancelled", status: "cancelled" }
];

const jobTimeFilters: Array<{ id: JobTimeFilter }> = [
  { id: "all" },
  { id: "24h" },
  { id: "7d" },
  { id: "custom" }
];

const notifiableJobStatuses = new Set<JobStatus>(["succeeded", "failed", "waiting_for_human"]);

function isNewForDesktopNotification(timestamp: string | null | undefined, monitorStartedAt: number) {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= monitorStartedAt - 5000;
}

function jobDisplayTitle(job: Pick<JobRecord, "id" | "rawPrompt" | "displayTitle"> | null | undefined) {
  if (!job) return "";
  return job.displayTitle?.trim() || inferJobDisplayTitle(job.rawPrompt || "") || job.id;
}

function jobDesktopNotification(
  job: JobRecord,
  language: Language
): DesktopNotificationPayload | null {
  if (!notifiableJobStatuses.has(job.status)) {
    return null;
  }

  if (job.status === "succeeded") {
    const title = jobDisplayTitle(job);
    return language === "zh"
      ? {
          id: `job:${job.id}:succeeded`,
          title: "Honeycomb \u4efb\u52a1\u5df2\u5b8c\u6210",
          body: `${title} \u5df2\u751f\u6210\u7ed3\u679c\u3002`,
          tag: `honeycomb-job-${job.id}`
        }
      : {
          id: `job:${job.id}:succeeded`,
          title: "Honeycomb job completed",
          body: `${title} generated a result.`,
          tag: `honeycomb-job-${job.id}`
        };
  }

  if (job.status === "failed") {
    const title = jobDisplayTitle(job);
    return language === "zh"
      ? {
          id: `job:${job.id}:failed`,
          title: "Honeycomb \u4efb\u52a1\u5931\u8d25",
          body: `${title} \u9700\u8981\u68c0\u67e5\u5931\u8d25\u539f\u56e0\u3002`,
          tag: `honeycomb-job-${job.id}`
        }
      : {
          id: `job:${job.id}:failed`,
          title: "Honeycomb job failed",
          body: `${title} needs attention.`,
          tag: `honeycomb-job-${job.id}`
        };
  }

  const title = jobDisplayTitle(job);
  return language === "zh"
    ? {
        id: `job:${job.id}:waiting_for_human`,
        title: "Honeycomb \u9700\u8981\u4f60\u51b3\u5b9a",
        body: `${title} \u6b63\u5728\u7b49\u5f85\u4eba\u5de5\u5904\u7406\u3002`,
        tag: `honeycomb-job-${job.id}`
      }
    : {
        id: `job:${job.id}:waiting_for_human`,
        title: "Honeycomb needs your input",
        body: `${title} is waiting for a human decision.`,
        tag: `honeycomb-job-${job.id}`
      };
}

function approvalDesktopNotification(
  approval: ToolApprovalRecord,
  language: Language
): DesktopNotificationPayload {
  return language === "zh"
    ? {
        id: `approval:${approval.id}:pending`,
        title: "Honeycomb \u6709\u65b0\u7684\u5de5\u5177\u5ba1\u6279",
        body: `${approval.toolName} / ${approval.actionType} · ${approval.riskLevel}`,
        tag: `honeycomb-approval-${approval.id}`
      }
    : {
        id: `approval:${approval.id}:pending`,
        title: "New Honeycomb approval",
        body: `${approval.toolName} / ${approval.actionType} · ${approval.riskLevel}`,
        tag: `honeycomb-approval-${approval.id}`
      };
}

const languageOptions: Array<{ id: Language; label: string }> = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" }
];

const supervisorPermissionKeys: SupervisorPermissionKey[] = [
  "readWorkspace",
  "writeWorkspace",
  "runCommands",
  "networkAccess",
  "mcpTools"
];

const runtimeRepairActionLabels: Record<Language, Record<RuntimeRepairActionId, { title: string; description: string }>> = {
  en: {
    "database.migrate": {
      title: "Run migrations",
      description: "Apply safe Honeycomb database migrations."
    },
    "providers.reconcileSecrets": {
      title: "Sync key status",
      description: "Fix stale provider key flags from local secret storage."
    },
    "mcp.checkAll": {
      title: "Check MCP",
      description: "Re-check enabled MCP server commands and update status."
    },
    "openclaw.runtime.start": {
      title: "Prepare runtime",
      description: "Create or start the Honeycomb-managed OpenClaw runtime."
    },
    "openclaw.runtime.restart": {
      title: "Restart runtime",
      description: "Restart the configured or built-in OpenClaw runtime."
    },
    "agents.seedDefaults": {
      title: "Seed agents",
      description: "Ensure panel, research, writer, image, video, and test agents exist."
    },
    "openclaw.sync.apply": {
      title: "Sync OpenClaw",
      description: "Write prompts and redacted model config into the runtime."
    }
  },
  zh: {
    "database.migrate": {
      title: "运行数据库迁移",
      description: "执行安全的 Honeycomb 数据库迁移。"
    },
    "providers.reconcileSecrets": {
      title: "同步 Key 状态",
      description: "根据本地密钥存储修正模型服务商的 Key 状态。"
    },
    "mcp.checkAll": {
      title: "检查 MCP",
      description: "重新检测已启用 MCP 服务命令并更新状态。"
    },
    "openclaw.runtime.start": {
      title: "准备运行时",
      description: "创建或启动 Honeycomb 管理的 OpenClaw 运行目录。"
    },
    "openclaw.runtime.restart": {
      title: "重启运行时",
      description: "重启已配置或内置的 OpenClaw 运行时。"
    },
    "agents.seedDefaults": {
      title: "创建默认 Agent",
      description: "确保面板、研究、写作、图像、视频、质检 Agent 都存在。"
    },
    "openclaw.sync.apply": {
      title: "同步到 OpenClaw",
      description: "写入提示词和脱敏模型配置到运行目录。"
    }
  }
};

const defaultSupervisorPermissions: Record<SupervisorPermissionKey, boolean> = {
  readWorkspace: true,
  writeWorkspace: false,
  runCommands: false,
  networkAccess: true,
  mcpTools: false
};

const recoveryQuestionOptions: Record<Language, Array<{ id: RecoveryQuestionId; label: string }>> = {
  en: [
    { id: "first_project", label: "What was the first project you used this panel for?" },
    { id: "favorite_place", label: "What city or place do you associate with your work?" },
    { id: "first_tool", label: "What was the first work tool you used often?" },
    { id: "mentor_name", label: "What is the name of a mentor or teacher you remember?" },
    { id: "memorable_date", label: "What date is meaningful to your work?" }
  ],
  zh: [
    { id: "first_project", label: "你第一次准备用这个面板处理什么项目？" },
    { id: "favorite_place", label: "哪个城市或地点最能代表你的工作？" },
    { id: "first_tool", label: "你最早经常使用的工作工具是什么？" },
    { id: "mentor_name", label: "你记得的一位老师或导师叫什么？" },
    { id: "memorable_date", label: "对你的工作有意义的日期是哪一天？" }
  ]
};

const translations = {
  en: {
    appName: "honeycomb",
    subtitle: "Local multi-agent control desk",
    apiOnline: "OpenClaw online",
    apiOffline: "OpenClaw offline",
    apiChecking: "Checking OpenClaw",
    refresh: "Refresh",
    languageLabel: "Language",
    setupTab: "First Run",
    consoleTab: "Console",
    dashboard: "Dashboard",
    conversationsView: "Conversations",
    jobsView: "Jobs",
    approvalsView: "Approvals",
    agentsView: "Agents",
    modelsView: "Models",
    memoryView: "Memory",
    settingsView: "Settings",
    startSetup: "Start First Run",
    openConversations: "Open Conversations",
    openJobs: "Open Jobs",
    newJob: "New Job",
    routing: "Routing",
    budget: "Budget",
    startJob: "Start Job",
    jobs: "Jobs",
    jobStatusFilter: "Job status filter",
    jobTimeFilter: "Job created time filter",
    searchPrompts: "Search prompts",
    searchPromptsAria: "Search job prompts",
    since: "Since",
    until: "Until",
    noJobsMatch: "No jobs match.",
    loadMore: "Load More",
    noJobSelected: "No job selected",
    cancel: "Cancel",
    cancelled: "Cancelled",
    status: "Status",
    created: "Created",
    timeline: "Timeline",
    noJobLoaded: "No job loaded.",
    latestItems: "latest items",
    complete: "complete",
    noTimelineEvents: "No timeline events.",
    approvalQueueTitle: "Tool approval queue",
    approvalQueueHint: "Review higher-risk tool requests before agents write files, run commands, or use external tools.",
    pendingApprovals: "Pending approvals",
    noPendingApprovals: "No pending approvals.",
    approvalRisk: "Risk",
    approvalTool: "Tool",
    approvalAction: "Action",
    approvalTarget: "Target",
    approvalCommand: "Command",
    approvalReason: "Reason",
    approvalRequestedBy: "Requested by",
    approve: "Approve",
    reject: "Reject",
    approvalApproved: "Approval granted.",
    approvalRejected: "Approval rejected.",
    approvalLoadFailed: "Could not load approvals.",
    approvalDecisionFailed: "Could not update approval.",
    runningJobs: "Running jobs",
    totalJobs: "Total jobs",
    latestJob: "Latest job",
    noLatestJob: "No job yet",
    gatewayPanel: "Gateway",
    gatewayHint: "Backend status and local API address",
    currentModel: "Planner model",
    modelHint: "Configured model provider",
    agentHint: "Agent framework",
    memoryHint: "Prompts and experience memory",
    settingsHint: "Security, language, and local preferences",
    outputStyleTitle: "Panel output style",
    outputStyleIntro: "Controls how the panel agent answers in conversations.",
    outputStyleSaved: "Panel output style saved.",
    outputStyles: {
      concise: "Concise and direct",
      detailed: "Detailed explanation",
      warm: "Warm and natural",
      formal: "Formal and professional"
    },
    securityTitle: "Security",
    securityIntro: "Set a local panel password and a recovery question.",
    securityConfiguredIntro: "Verify the current password before changing the password or recovery question.",
    panelPassword: "Panel password",
    currentPassword: "Current password",
    password: "Password",
    newPassword: "New password",
    confirmPassword: "Confirm password",
    recoveryQuestion: "Recovery question",
    changeRecoveryQuestion: "Change recovery question",
    recoveryQuestionOther: "Other",
    customRecoveryQuestion: "Custom recovery question",
    recoveryAnswer: "Recovery answer",
    saveSecurity: "Save security",
    savePassword: "Confirm",
    securitySaved: "Security settings saved.",
    securityPasswordSaved: "Security settings updated.",
    passwordMissing: "Add a new password.",
    currentPasswordMissing: "Enter the current password.",
    currentPasswordFailed: "Current password did not match.",
    noSecurityChanges: "Add a new password or change the recovery question.",
    cancelModify: "Cancel modification",
    cancelPassword: "Cancel local password",
    passwordCancelled: "Local panel password cancelled.",
    recoveryUnavailable: "No recovery question is configured.",
    resetTitle: "Reset",
    resetIntro: "Re-enter only the setup section you need without repeating the whole onboarding flow.",
    resetPanelAgent: "Panel agent",
    resetPanelAgentHint: "Rename it and reconnect model/API key.",
    resetWorkProfile: "Profession",
    resetWorkProfileHint: "Redo the work interview only.",
    smartRouting: "Smart routing",
    smartRoutingHint: "The panel agent will analyze the task and choose an orchestration mode.",
    modelsFlowHint: "Choose a mode to inspect how work moves through agents.",
    routingFlow: "Workflow",
    unconfigured: "Not configured",
    configureModelKey: "Configure model/key",
    agentConfigTitle: "Agent model setup",
    provider: "Provider",
    baseUrl: "Base URL",
    model: "Model",
    imageAgentModel: "Image model",
    videoAgentModel: "Video model",
    imageAgentModelHint: "Use an image-capable model here, such as Seedream. Honeycomb verifies it through the image generation API.",
    videoAgentModelHint: "Use a video-capable model here, such as Seedance. Honeycomb verifies it through the video generation API.",
    apiKey: "API Key",
    saveAgentConfig: "Save configuration",
    cancelConfig: "Cancel",
    agentConfigSaved: "Agent model verified and written to the local OpenClaw config package.",
    agentConfigSaving: "Verifying model connection...",
    agentConfigVerifyFailed: "Could not verify the model connection. Check the model and API Key, then retry.",
    agentConfigMissing: "Add a model and API key before saving.",
    agentConfigured: "This agent has its own model/key configured.",
    panelAgentConfigured: "Uses the configured panel model.",
    specialistNeedsKey: "Needs its own model/key before this agent can run independently.",
    capabilityTitle: "Supervisor workbench",
    capabilityIntro: "These panels turn Honeycomb from a launcher into a control desk for a local multi-agent team.",
    capabilityItems: [
      { title: "Runtime config", body: "Inspect OpenClaw status, model provider, and local backend readiness before assigning work.", status: "Live" },
      { title: "Streaming progress", body: "Surface running jobs and timeline events as the supervisor agent delegates work.", status: "Live" },
      { title: "Plan and Todo", body: "Keep task stages visible so long jobs can be tracked and resumed.", status: "Next" },
      { title: "Project workspace", body: "Bind tasks to local folders, files, and branch context for safer handoffs.", status: "Next" },
      { title: "Permission control", body: "Make tool and file access explicit before agents perform higher-risk actions.", status: "Next" },
      { title: "Skills and MCP", body: "Expose reusable tools that specialist agents can request through the supervisor.", status: "Next" }
    ],
    workbenchRuntime: "Runtime config",
    workbenchStreaming: "Streaming progress",
    workbenchPlan: "Plan and Todo",
    workbenchWorkspace: "Project workspace",
    workbenchPermissions: "Permission control",
    workbenchSkills: "Skills and MCP",
    workbenchLive: "Live",
    workbenchLocal: "Local",
    workbenchStored: "Saved",
    workbenchRepair: "Repair",
    workbenchRepairTitle: "Diagnostics repair",
    workbenchRepairIntro: "Run safe backend repair actions when runtime diagnostics finds a recoverable issue.",
    workbenchRepairStatus: "Diagnostics",
    workbenchRepairActions: "Repair actions",
    workbenchRepairRefresh: "Refresh",
    workbenchRepairRunning: "Running repair...",
    workbenchRepairLoading: "Loading repair actions...",
    workbenchRepairUnavailable: "Repair actions unavailable.",
    workbenchRepairNoActions: "No repair actions available.",
    workbenchRepairDone: "Repair completed.",
    workbenchRepairFailed: "Repair failed.",
    workbenchRepairCheckedAt: "Checked",
    workbenchLatestJob: "Tracked job",
    workbenchNoJob: "No job yet",
    workbenchTimelineItems: "Timeline events",
    workbenchWorkspaceLabel: "Workspace path",
    workbenchWorkspacePlaceholder: "For example: C:\\Users\\you\\Projects\\campaign",
    workbenchSave: "Save workbench config",
    workbenchSaved: "Workbench config saved locally.",
    workbenchSkillsLabel: "Available skills",
    workbenchMcpLabel: "MCP servers",
    workbenchSkillsPlaceholder: "For example: writing, image, video, review",
    workbenchMcpPlaceholder: "For example: filesystem, git, browser",
    workbenchPermissionLabels: {
      readWorkspace: "Read workspace files",
      writeWorkspace: "Write workspace files",
      runCommands: "Run local commands",
      networkAccess: "Use network access",
      mcpTools: "Use MCP tools"
    },
    passwordMismatch: "Passwords do not match.",
    securityMissing: "Add a password and recovery answer.",
    lockTitle: "honeycomb",
    lockSubtitle: "Enter the local panel password.",
    unlock: "Unlock",
    forgotPassword: "Forgot password",
    usePassword: "Use password",
    recoveryFailed: "Recovery answer did not match.",
    unlockFailed: "Password did not match.",
    tourSkip: "Skip",
    tourNext: "Next",
    tourDone: "Done",
    tourProgress: "Step",
    tourSteps: [
      {
        anchor: "activity",
        title: "Left activity bar",
        body: "Switch between the dashboard, first-run setup, jobs, agents, models, memory, and settings."
      },
      {
        anchor: "dashboard",
        title: "Dashboard",
        body: "Check gateway status, job health, current model, and the next useful action from the first screen."
      },
      {
        anchor: "jobs",
        title: "Jobs and timeline",
        body: "Create jobs, choose a routing mode, inspect messages, and cancel runs when needed."
      },
      {
        anchor: "settings",
        title: "Settings",
        body: "The lower-left settings button opens security, language, and local preferences."
      }
    ],
    navGroups: {
      operate: "Operate",
      build: "Build",
      system: "System"
    },
    statusFilters: {
      all: "All",
      running: "Running",
      waiting_for_human: "Waiting",
      cancelled: "Cancelled"
    },
    timeFilters: {
      all: "All Time",
      "24h": "24h",
      "7d": "7d",
      custom: "Custom"
    },
    statuses: {
      created: "created",
      queued: "queued",
      planning: "planning",
      running: "running",
      testing: "testing",
      fixing: "fixing",
      waiting_for_human: "waiting",
      succeeded: "succeeded",
      failed: "failed",
      cancelled: "cancelled"
    },
    sources: {
      job_event: "job event",
      agent_event: "agent event",
      group_message: "group message",
      stage_attempt: "stage attempt",
      test_review: "test review",
      artifact: "artifact"
    }
  },
  zh: {
    appName: "honeycomb",
    subtitle: "本地多 Agent 操作台",
    apiOnline: "OpenClaw 在线",
    apiOffline: "OpenClaw 离线",
    apiChecking: "正在检查 OpenClaw",
    refresh: "刷新",
    languageLabel: "语言",
    setupTab: "首次启动",
    consoleTab: "控制台",
    dashboard: "仪表盘",
    conversationsView: "对话",
    jobsView: "任务",
    approvalsView: "审批",
    agentsView: "Agent",
    modelsView: "模型",
    memoryView: "记忆",
    settingsView: "设置",
    startSetup: "开始首次启动",
    openConversations: "打开对话",
    openJobs: "打开任务",
    newJob: "新任务",
    routing: "编排模式",
    budget: "预算",
    startJob: "启动任务",
    jobs: "任务",
    jobStatusFilter: "任务状态筛选",
    jobTimeFilter: "任务创建时间筛选",
    searchPrompts: "搜索任务提示词",
    searchPromptsAria: "搜索任务提示词",
    since: "开始",
    until: "结束",
    noJobsMatch: "没有匹配的任务。",
    loadMore: "加载更多",
    noJobSelected: "未选择任务",
    cancel: "取消",
    cancelled: "已取消",
    status: "状态",
    created: "创建时间",
    timeline: "时间线",
    noJobLoaded: "没有加载任务。",
    latestItems: "最新事件",
    complete: "完整",
    noTimelineEvents: "没有时间线事件。",
    approvalQueueTitle: "工具审批队列",
    approvalQueueHint: "在 agent 写文件、运行命令或调用外部工具前，先由你确认高风险请求。",
    pendingApprovals: "待审批",
    noPendingApprovals: "当前没有待审批请求。",
    approvalRisk: "风险",
    approvalTool: "工具",
    approvalAction: "动作",
    approvalTarget: "目标",
    approvalCommand: "命令",
    approvalReason: "原因",
    approvalRequestedBy: "发起者",
    approve: "批准",
    reject: "拒绝",
    approvalApproved: "已批准该请求。",
    approvalRejected: "已拒绝该请求。",
    approvalLoadFailed: "无法加载审批队列。",
    approvalDecisionFailed: "无法更新审批状态。",
    runningJobs: "运行中任务",
    totalJobs: "任务总数",
    latestJob: "最近任务",
    noLatestJob: "还没有任务",
    gatewayPanel: "Gateway",
    gatewayHint: "后端状态和本地 API 地址",
    currentModel: "Planner 模型",
    modelHint: "已配置的模型服务",
    agentHint: "Agent 框架",
    memoryHint: "提示词和经验记忆",
    settingsHint: "安全、语言和本地偏好",
    outputStyleTitle: "面板输出风格",
    outputStyleIntro: "控制面板 Agent 在对话里的回答方式。",
    outputStyleSaved: "面板输出风格已保存。",
    outputStyles: {
      concise: "简洁直接",
      detailed: "详细解释",
      warm: "温柔自然",
      formal: "正式专业"
    },
    securityTitle: "安全设置",
    securityIntro: "设置本地面板密码和密保问题。",
    securityConfiguredIntro: "修改密码或密保问题前，请先验证原密码。",
    panelPassword: "面板密码",
    currentPassword: "原密码",
    password: "管理密码",
    newPassword: "新密码",
    confirmPassword: "确认密码",
    recoveryQuestion: "密保问题",
    changeRecoveryQuestion: "修改密保问题",
    recoveryQuestionOther: "其他",
    customRecoveryQuestion: "自定义密保问题",
    recoveryAnswer: "密保答案",
    saveSecurity: "保存安全设置",
    savePassword: "确认",
    securitySaved: "安全设置已保存。",
    securityPasswordSaved: "安全设置已修改。",
    passwordMissing: "请填写新密码。",
    currentPasswordMissing: "请先输入原密码。",
    currentPasswordFailed: "原密码不正确。",
    noSecurityChanges: "请填写新密码，或修改密保问题。",
    cancelModify: "取消修改",
    cancelPassword: "取消本地面板密码",
    passwordCancelled: "本地面板密码已取消。",
    recoveryUnavailable: "当前没有配置密保问题。",
    resetTitle: "重新设置",
    resetIntro: "只重新接入你需要修改的部分，不必重复完整首次配置。",
    resetPanelAgent: "重新设置你的面板agent",
    resetPanelAgentHint: "重新命名主管 agent，并重新配置模型和 API Key。",
    resetWorkProfile: "重新设置你的职业",
    resetWorkProfileHint: "只重新回答职业访谈，不改变面板 agent 和模型 Key。",
    smartRouting: "智能编排",
    smartRoutingHint: "面板 agent 会先分析你的任务，再自动选择适合的编排模式。",
    modelsFlowHint: "选择一个编排模式，查看任务会如何在 agent 之间流转。",
    routingFlow: "工作流程",
    unconfigured: "未配置",
    configureModelKey: "配置模型与 Key",
    agentConfigTitle: "Agent 模型配置",
    provider: "模型服务商",
    baseUrl: "接口地址",
    model: "模型",
    imageAgentModel: "图像模型",
    videoAgentModel: "视频模型",
    imageAgentModelHint: "这里填写图像 Agent 实际使用的图像模型，例如 Seedream。Honeycomb 会通过图片生成 API 验证模型和 Key。",
    videoAgentModelHint: "这里填写视频 Agent 实际使用的视频模型，例如 Seedance。Honeycomb 会通过视频生成 API 验证模型和 Key。",
    apiKey: "API Key",
    saveAgentConfig: "保存配置",
    cancelConfig: "取消",
    agentConfigSaved: "Agent 模型已验证，并写入 OpenClaw 本地配置包。",
    agentConfigSaving: "正在验证模型连接...",
    agentConfigVerifyFailed: "无法验证模型连接，请检查模型和 API Key 后重试。",
    agentConfigMissing: "请填写模型和 API Key 后保存。",
    agentConfigured: "这个 agent 已单独配置模型与 Key。",
    panelAgentConfigured: "使用首次启动时配置的面板模型。",
    specialistNeedsKey: "这个 agent 需要单独配置模型与 Key 后，才能独立参与任务。",
    capabilityTitle: "主管工作台",
    capabilityIntro: "这些面板把 Honeycomb 从启动器变成主管 agent 管理本地多 Agent 团队的操作台。",
    capabilityItems: [
      { title: "运行时配置", body: "先看 OpenClaw 状态、模型服务和本地后端是否可用，再分配任务。", status: "已接入" },
      { title: "流式反馈", body: "把运行中的任务和时间线事件持续显示出来，让主管 agent 的分工过程可见。", status: "已接入" },
      { title: "计划与 Todo", body: "把长任务拆成可跟踪阶段，方便暂停、继续和复盘。", status: "下一步" },
      { title: "项目工作区", body: "把任务绑定到本地目录、文件和分支上下文，减少 agent 交接误差。", status: "下一步" },
      { title: "权限控制", body: "在 agent 执行高风险工具或文件操作前，明确权限边界。", status: "下一步" },
      { title: "Skills 与 MCP", body: "把常用工具和技能变成专业 agent 可申请调用的能力。", status: "下一步" }
    ],
    workbenchRuntime: "运行时配置",
    workbenchStreaming: "流式反馈",
    workbenchPlan: "计划与 Todo",
    workbenchWorkspace: "项目工作区",
    workbenchPermissions: "权限控制",
    workbenchSkills: "Skills 与 MCP",
    workbenchLive: "实时",
    workbenchLocal: "本地",
    workbenchStored: "已保存",
    workbenchRepair: "可修复",
    workbenchRepairTitle: "诊断修复",
    workbenchRepairIntro: "当运行时诊断发现可恢复问题时，可以直接运行后端真实修复动作。",
    workbenchRepairStatus: "诊断状态",
    workbenchRepairActions: "修复动作",
    workbenchRepairRefresh: "刷新",
    workbenchRepairRunning: "正在修复...",
    workbenchRepairLoading: "正在加载修复动作...",
    workbenchRepairUnavailable: "暂时无法加载修复动作。",
    workbenchRepairNoActions: "暂无可用修复动作。",
    workbenchRepairDone: "修复完成。",
    workbenchRepairFailed: "修复失败。",
    workbenchRepairCheckedAt: "检查时间",
    workbenchLatestJob: "跟踪任务",
    workbenchNoJob: "还没有任务",
    workbenchTimelineItems: "时间线事件",
    workbenchWorkspaceLabel: "工作区路径",
    workbenchWorkspacePlaceholder: "例如：C:\\Users\\你\\Projects\\农业方案",
    workbenchSave: "保存工作台配置",
    workbenchSaved: "工作台配置已保存在本地。",
    workbenchSkillsLabel: "可用技能",
    workbenchMcpLabel: "MCP 服务",
    workbenchSkillsPlaceholder: "例如：写作、图像、视频、评审",
    workbenchMcpPlaceholder: "例如：filesystem、git、browser",
    workbenchPermissionLabels: {
      readWorkspace: "读取工作区文件",
      writeWorkspace: "写入工作区文件",
      runCommands: "运行本地命令",
      networkAccess: "使用网络访问",
      mcpTools: "调用 MCP 工具"
    },
    passwordMismatch: "两次密码不一致。",
    securityMissing: "请填写密码和密保答案。",
    lockTitle: "honeycomb",
    lockSubtitle: "请输入本地面板密码。",
    unlock: "解锁",
    forgotPassword: "忘记密码",
    usePassword: "使用密码",
    recoveryFailed: "密保答案不匹配。",
    unlockFailed: "密码不匹配。",
    tourSkip: "跳过",
    tourNext: "下一步",
    tourDone: "完成",
    tourProgress: "步骤",
    tourSteps: [
      {
        anchor: "activity",
        title: "左侧功能栏",
        body: "在仪表盘、首次启动、任务、Agent、模型、记忆和设置之间切换。"
      },
      {
        anchor: "dashboard",
        title: "仪表盘",
        body: "第一屏查看 Gateway 状态、任务健康度、当前模型和下一步动作。"
      },
      {
        anchor: "jobs",
        title: "任务和时间线",
        body: "创建任务、选择编排模式、查看消息时间线，并在需要时取消运行。"
      },
      {
        anchor: "settings",
        title: "设置",
        body: "左下角设置用于管理安全、语言和本地偏好。"
      }
    ],
    navGroups: {
      operate: "运行",
      build: "构建",
      system: "系统"
    },
    statusFilters: {
      all: "全部",
      running: "运行中",
      waiting_for_human: "等待",
      cancelled: "已取消"
    },
    timeFilters: {
      all: "全部时间",
      "24h": "24 小时",
      "7d": "7 天",
      custom: "自定义"
    },
    statuses: {
      created: "已创建",
      queued: "排队中",
      planning: "规划中",
      running: "运行中",
      testing: "测试中",
      fixing: "修复中",
      waiting_for_human: "等待人工",
      succeeded: "已成功",
      failed: "已失败",
      cancelled: "已取消"
    },
    sources: {
      job_event: "任务事件",
      agent_event: "Agent 事件",
      group_message: "群消息",
      stage_attempt: "阶段尝试",
      test_review: "测试评审",
      artifact: "产物"
    }
  }
} as const;

function getInitialLanguage(): Language {
  const queryLanguage = new URLSearchParams(window.location.search).get("lang");
  if (queryLanguage === "zh" || queryLanguage === "en") {
    return queryLanguage;
  }
  const storedLanguage = window.localStorage.getItem("agentOpenClaw.language");
  return storedLanguage === "zh" ? "zh" : "en";
}

function getInitialView(): AppView {
  const storedView = window.localStorage.getItem("agentOpenClaw.activeView");
  const setupAlreadyComplete =
    window.localStorage.getItem("honeycomb.setupCompleted") === "true" ||
    new URLSearchParams(window.location.search).get("skipOnboarding") === "true";
  if (storedView === "console") return "jobs";
  if (storedView === "setup" && setupAlreadyComplete) return "dashboard";
  if (
    storedView === "dashboard" ||
    storedView === "setup" ||
    storedView === "conversations" ||
    storedView === "jobs" ||
    storedView === "approvals" ||
    storedView === "agents" ||
    storedView === "models" ||
    storedView === "memory" ||
    storedView === "settings"
  ) {
    return storedView;
  }
  return "dashboard";
}

function formatTime(value: string | null | undefined, language: Language) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function compactEventType(value: string) {
  return value.replace(/^job\./, "").replace(/^stage\./, "").replace(/^group\./, "");
}

function isCancellable(job: JobRecord | null) {
  return job ? cancellableStatuses.includes(job.status) : false;
}

function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  const digits = value > 0 && value < 0.01 ? 6 : 2;
  return `$${value.toFixed(digits)}`;
}

function spendBlockingMessage(job: JobRecord, language: Language) {
  switch (job.spendBudget.blockingScope) {
    case "job":
      return language === "zh"
        ? "这项任务的费用额度已经用完，请设置更高的新上限后再恢复。"
        : "This task has used its spend allowance. Set a higher limit before resuming.";
    case "user_daily":
      return language === "zh"
        ? "今天的用户费用额度已经用完，任务会保持暂停。"
        : "The user's daily spend allowance is exhausted. The task remains paused.";
    case "provider_daily":
      return language === "zh"
        ? "这个模型服务商今天的费用额度已经用完，任务会保持暂停。"
        : "This provider's daily spend allowance is exhausted. The task remains paused.";
    case "pricing":
      return language === "zh"
        ? "当前模型缺少可靠价格或单次费用上界，请先补全服务商费用配置。"
        : "This model lacks reliable pricing or a per-request charge bound. Complete the provider spend settings first.";
    default:
      return "";
  }
}

function isResumable(job: JobRecord | null) {
  return Boolean(job && (
    job.status === "waiting_for_human" ||
    job.heartbeatStatus === "stalled"
  ));
}

function statusTone(status: JobStatus) {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "waiting_for_human") return "warn";
  return "active";
}

function jobProgress(status: JobStatus) {
  if (status === "created") return 8;
  if (status === "queued") return 14;
  if (status === "planning") return 26;
  if (status === "running") return 58;
  if (status === "testing" || status === "fixing") return 78;
  if (status === "waiting_for_human") return 62;
  return 100;
}

function riskTone(riskLevel: ToolApprovalRecord["riskLevel"]) {
  if (riskLevel === "critical" || riskLevel === "high") return "danger";
  if (riskLevel === "medium") return "warn";
  return "success";
}

function diagnosticTone(status?: RuntimeDiagnosticsResponse["status"]) {
  if (status === "ok") return "success";
  if (status === "error") return "danger";
  if (status === "warning") return "warn";
  return "active";
}

function runtimeDiagnosticStatusLabel(
  status: RuntimeDiagnosticsResponse["status"] | undefined,
  language: Language
) {
  if (language === "zh") {
    if (status === "ok") return "正常";
    if (status === "warning") return "需要注意";
    if (status === "error") return "需要修复";
    return "未知";
  }
  if (status === "ok") return "Ready";
  if (status === "warning") return "Needs attention";
  if (status === "error") return "Repair needed";
  return "Unknown";
}

function runtimeRepairActionCopy(action: RuntimeRepairAction, language: Language) {
  return runtimeRepairActionLabels[language][action.id] ?? {
    title: action.title,
    description: action.description
  };
}

function compactJson(value: Record<string, unknown>) {
  const keys = Object.keys(value);
  if (keys.length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function localDateTimeToIso(value: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function loadSecurityRecord(): SecurityRecord | null {
  const serialized = window.localStorage.getItem("agentOpenClaw.security");
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as Partial<SecurityRecord>;
    if (
      parsed.passwordSalt &&
      parsed.passwordHash &&
      parsed.updatedAt
    ) {
      return parsed as SecurityRecord;
    }
  } catch {
    return null;
  }
  return null;
}

function createSalt() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashSecret(secret: string, salt: string) {
  const payload = `${salt}:${secret}`;
  if (!window.crypto.subtle) {
    return window.btoa(payload);
  }
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasRecoveryQuestion(record: SecurityRecord | null) {
  return Boolean(record?.recoverySalt && record?.recoveryHash && (record.recoveryQuestion || record.recoveryQuestionId));
}

function recoveryQuestionLabel(record: SecurityRecord, language: Language) {
  if (record.recoveryQuestionId) {
    const option = recoveryQuestionOptions[language].find((candidate) => candidate.id === record.recoveryQuestionId);
    if (option) return option.label;
  }
  return record.recoveryQuestion || recoveryQuestionOptions[language][0].label;
}

function loadFirstRunPreview(): FirstRunPreview | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("honeycomb.firstRunPreview") || "null") as FirstRunPreview | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function loadFirstRunPreviewFromDesktop(): Promise<FirstRunPreview | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const serialized = await invoke<string | null>("load_first_run_setup");
    if (!serialized) return null;
    const parsed = JSON.parse(serialized) as FirstRunPreview | null;
    if (parsed && typeof parsed === "object") {
      window.localStorage.setItem("honeycomb.firstRunPreview", serialized);
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizePanelOutputStyle(value: unknown): PanelOutputStyle {
  return typeof value === "string" && panelOutputStyles.includes(value as PanelOutputStyle)
    ? value as PanelOutputStyle
    : "concise";
}

function loadPanelOutputStyle(preview: FirstRunPreview | null): PanelOutputStyle {
  const stored = window.localStorage.getItem("honeycomb.panelOutputStyle");
  return normalizePanelOutputStyle(stored || preview?.profile?.outputStyle);
}

function configuredProviderLabel(preview: FirstRunPreview | null, language: Language) {
  const provider = preview?.provider;
  if (!provider?.apiKeyConfigured) {
    return language === "zh" ? "未配置" : "Not configured";
  }
  return [provider.providerName, provider.model].filter(Boolean).join(" · ") || (language === "zh" ? "已配置" : "Configured");
}

function isTauriRuntime() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function invokeDesktopCommand<T>(command: string, args: Record<string, unknown> = {}) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { available: true, value: await invoke<T>(command, args) };
  } catch (error) {
    return isTauriRuntime() ? { available: true, error } : { available: false, error };
  }
}

const DESKTOP_EXPORT_STORAGE_KEY = "honeycomb.desktopExportedJobs";

type DesktopDownloadResult = {
  path: string;
  bytes: number;
  checksumSha256: string;
};

function loadDesktopExportedJobIds() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DESKTOP_EXPORT_STORAGE_KEY) || "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function saveDesktopExportedJobIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(DESKTOP_EXPORT_STORAGE_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Best-effort cache; failing to remember only means a later refresh may retry export.
  }
}

function shouldExportJobToDesktop(job: JobRecord) {
  return /\u684c\u9762|desktop/i.test(userTaskPrompt(job.rawPrompt || ""));
}

function extensionFromFileName(fileName: string, fallback = ".png") {
  const match = fileName.match(/\.[a-z0-9]{2,5}$/i);
  return match ? match[0].toLowerCase() : fallback;
}

const providerPresets = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", pattern: /deepseek/i },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", pattern: /^(gpt-|o[134]|chatgpt|openai)/i },
  { name: "Alibaba Cloud Bailian", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", pattern: /qwen|通义/i },
  { name: "Zhipu AI", baseUrl: "https://open.bigmodel.cn/api/paas/v4", pattern: /glm|zhipu|智谱/i },
  { name: "Volcengine Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", pattern: /doubao|豆包|volc|ark|ep-/i }
];

function normalizeAgentModelConfig(input: Partial<AgentModelConfig> | null | undefined): AgentModelConfig | null {
  if (!input || typeof input !== "object") return null;
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
  const model = typeof input.model === "string" ? input.model : "";
  const providerName = typeof input.providerName === "string" && input.providerName.trim() ? input.providerName : "";
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl : "";
  return {
    providerName,
    baseUrl,
    model,
    apiKey,
    apiKeyConfigured: input.apiKeyConfigured === true || Boolean(apiKey.trim()),
    verifiedAt: typeof input.verifiedAt === "string" ? input.verifiedAt : undefined,
    appliedAt: typeof input.appliedAt === "string" ? input.appliedAt : undefined
  };
}

function isStaleSpecialistAgentModelConfig(agentId: string, config: AgentModelConfig) {
  return specialistAgentConfigIds.has(agentId) &&
    config.apiKeyConfigured &&
    !config.apiKey.trim() &&
    !config.verifiedAt &&
    !config.appliedAt &&
    /^deepseek-v4-pro$/i.test(config.model.trim());
}

function normalizeAgentModelConfigEntry(
  agentId: string,
  config: Partial<AgentModelConfig>
): [string, AgentModelConfig] | null {
  const normalized = normalizeAgentModelConfig(config);
  if (!normalized || isStaleSpecialistAgentModelConfig(agentId, normalized)) {
    return null;
  }
  return [agentId, normalized];
}

function loadAgentModelConfigs(): Record<string, AgentModelConfig> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("honeycomb.agentModelConfigs") || "{}") as Record<string, Partial<AgentModelConfig>>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([agentId, config]) => normalizeAgentModelConfigEntry(agentId, config))
        .filter((entry): entry is [string, AgentModelConfig] => Boolean(entry))
    );
  } catch {
    return {};
  }
}

function saveAgentModelConfigs(configs: Record<string, AgentModelConfig>) {
  const redacted = Object.fromEntries(
    Object.entries(configs).map(([agentId, config]) => [
      agentId,
      {
        ...config,
        apiKey: "",
        apiKeyConfigured: config.apiKeyConfigured === true || Boolean(config.apiKey.trim())
      }
    ])
  );
  window.localStorage.setItem("honeycomb.agentModelConfigs", JSON.stringify(redacted));
}

const specialistAgentConfigIds = new Set([
  "research-agent",
  "writer-agent",
  "image-agent",
  "video-agent",
  "test-agent"
]);

function uiAgentIdFromBackend(agentId: string) {
  return agentId === "panel-agent" ? "panel-supervisor-agent" : agentId;
}

function mergeBackendAgentModelConfigs(
  current: Record<string, AgentModelConfig>,
  agents: AgentConfigRecord[],
  providers: ModelProviderRecord[]
) {
  const next = { ...current };
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));

  for (const agent of agents) {
    const uiAgentId = uiAgentIdFromBackend(agent.id);
    if (!specialistAgentConfigIds.has(uiAgentId)) {
      continue;
    }

    if (!agent.apiKeyConfigured || !agent.model) {
      delete next[uiAgentId];
      continue;
    }

    const existing = next[uiAgentId];
    const provider = agent.providerId ? providersById.get(agent.providerId) : null;
    next[uiAgentId] = {
      providerName: provider?.displayName || existing?.providerName || agent.providerId || "Configured provider",
      baseUrl: provider?.baseUrl || existing?.baseUrl || "",
      model: agent.model,
      apiKey: existing?.apiKey || "",
      apiKeyConfigured: true,
      verifiedAt: provider?.lastVerifiedAt || existing?.verifiedAt,
      appliedAt: agent.lastSyncedAt || existing?.appliedAt
    };
  }

  return next;
}

async function loadProviderApiKeyFromDesktop() {
  const result = await invokeDesktopCommand<string | null>("load_provider_api_key");
  if (result.available && "value" in result && result.value) {
    return result.value;
  }
  const legacy = window.localStorage.getItem("honeycomb.providerApiKey") || "";
  if (legacy) {
    window.localStorage.removeItem("honeycomb.providerApiKey");
  }
  return legacy;
}

async function loadAgentModelConfigsFromDesktop() {
  const result = await invokeDesktopCommand<string | null>("load_agent_model_configs");
  if (!result.available || !("value" in result) || !result.value) return {};
  try {
    const parsed = JSON.parse(result.value) as Record<string, Partial<AgentModelConfig>>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([agentId, config]) => normalizeAgentModelConfigEntry(agentId, config))
        .filter((entry): entry is [string, AgentModelConfig] => Boolean(entry))
    );
  } catch {
    return {};
  }
}

function resolveProviderForAgent(
  model: string,
  existing: Partial<AgentModelConfig> | null | undefined,
  preview: FirstRunPreview | null
) {
  const trimmedModel = model.trim();
  const preset = providerPresets.find((candidate) => candidate.pattern.test(trimmedModel));
  if (preset) {
    return { providerName: preset.name, baseUrl: preset.baseUrl };
  }
  if (existing?.baseUrl) {
    return {
      providerName: existing.providerName || preview?.provider?.providerName || "Custom",
      baseUrl: existing.baseUrl
    };
  }
  return {
    providerName: preview?.provider?.providerName || "DeepSeek",
    baseUrl: preview?.provider?.baseUrl || "https://api.deepseek.com"
  };
}

async function saveAgentModelConfigToDesktop(agentId: string, config: AgentModelConfig) {
  return invokeDesktopCommand<ProviderConnectionResult>("save_agent_model_config", {
    payload: {
      agentId,
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey
    }
  });
}

type ApiErrorPayload = {
  error?: string;
  reason?: string;
  message?: string;
  verification?: {
    statusCode?: number | null;
    message?: string | null;
  };
};

function parseApiErrorPayload(error: unknown): ApiErrorPayload | null {
  const text = error instanceof Error ? error.message : String(error ?? "");
  try {
    const parsed = JSON.parse(text) as ApiErrorPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function describeAgentConfigSaveError(error: unknown, language: Language, agentId = "", model = "") {
  const zh = language === "zh";
  const payload = parseApiErrorPayload(error);
  const remoteMessage = payload?.verification?.message || payload?.message || "";
  const detail = remoteMessage ? (zh ? ` 服务商返回：${remoteMessage}` : ` Provider returned: ${remoteMessage}`) : "";

  if (payload?.error === "provider_inference_failed") {
    return zh
      ? "无法只根据这个模型名识别模型服务商。请使用明确的模型名，例如 deepseek-chat、gpt-4o、qwen-plus，或稍后在服务商预设中补充接口。"
      : "Honeycomb could not infer the provider from this model name. Use a recognizable model name such as deepseek-chat, gpt-4o, or qwen-plus, or add a provider preset later.";
  }
  if (payload?.error === "api_token_not_configured") {
    return zh
      ? "Honeycomb 后端启动时缺少本地鉴权令牌。请关闭后重新用桌面快捷方式启动，或运行启动脚本重启后端。"
      : "The Honeycomb backend started without the local auth token. Relaunch from the desktop shortcut or restart the backend with the launcher script.";
  }
  if (payload?.error === "agent_model_api_key_required") {
    return zh
      ? "这个 Agent 还没有保存过 API Key。请先输入 API Key，Honeycomb 会真实验证并写入 OpenClaw；之后再次修改模型时可以复用本机保存的 Key。"
      : "This agent does not have a saved API key yet. Enter an API key once so Honeycomb can verify it and write it to OpenClaw; later edits can reuse the local saved key.";
  }
  if (payload?.reason === "provider_auth_failed") {
    return (zh ? "API Key 未通过服务商认证，请确认 Key 属于该模型服务商。" : "The API key was rejected by the provider. Confirm the key belongs to this provider.") + detail;
  }
  if (payload?.reason === "agent_model_kind_mismatch") {
    return (zh
      ? "这个模型类型不适合当前 Agent。图像生成模型请配置到图像 Agent，视频生成模型请配置到视频 Agent，研究/写作/质检 Agent 请配置对话或文本模型。"
      : "This model type does not match the current agent. Configure image generation models on the image agent, video generation models on the video agent, and chat/text models on research, writer, or test agents.") + detail;
  }
  if (payload?.reason === "model_not_chat_compatible") {
    return (zh
      ? "当前后端仍在使用旧的对话验证路径。请重启 Honeycomb 后再保存；图像 Agent 应通过图片生成 API 验证，视频 Agent 应通过视频生成 API 验证。"
      : "The backend is still using the older chat-verification path. Restart Honeycomb and save again; image agents should verify through the image generation API and video agents through the video generation API.") + detail;
  }
  if (payload?.reason === "provider_rejected_model") {
    return (zh ? "模型服务拒绝了这个模型名，请确认账号支持该模型。" : "The provider rejected this model name. Confirm the account can use this model.") + detail;
  }
  if (payload?.reason === "provider_endpoint_or_model_not_found") {
    return (zh ? "模型服务接口或模型不存在，请确认模型名是否正确。" : "The provider endpoint or model was not found. Confirm the model name.") + detail;
  }
  if (payload?.reason === "provider_quota_or_billing_failed") {
    return (zh ? "模型服务账号余额或额度不足，请检查服务商控制台。" : "The provider account appears to have insufficient quota or billing.") + detail;
  }
  if (payload?.reason === "provider_rate_limited") {
    return zh ? "模型服务正在限流，请稍后再试。" : "The provider rate-limited the verification request. Try again later.";
  }
  if (payload?.reason === "provider_network_failed") {
    return zh ? "后端无法连接到模型服务，请检查网络或服务商状态。" : "The backend could not reach the model provider. Check network/provider status.";
  }

  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return zh ? "Honeycomb 后端离线，无法真实验证并写入 OpenClaw。请先启动后端后再保存。" : "The Honeycomb backend is offline, so the model cannot be verified or written to OpenClaw.";
  }
  return zh ? "无法验证模型连接，请检查模型和 API Key 后重试。" : "Could not verify the model connection. Check the model and API Key, then retry.";
}

function defaultSupervisorWorkbenchConfig(): SupervisorWorkbenchConfig {
  return {
    workspacePath: "",
    permissions: { ...defaultSupervisorPermissions },
    skills: "writing, image, video, review",
    mcpServers: "filesystem, git",
    updatedAt: new Date(0).toISOString()
  };
}

function loadSupervisorWorkbenchConfig(): SupervisorWorkbenchConfig {
  const fallback = defaultSupervisorWorkbenchConfig();
  try {
    const parsed = JSON.parse(window.localStorage.getItem("honeycomb.supervisorWorkbench") || "null") as Partial<SupervisorWorkbenchConfig> | null;
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      workspacePath: typeof parsed.workspacePath === "string" ? parsed.workspacePath : fallback.workspacePath,
      permissions: {
        ...fallback.permissions,
        ...(parsed.permissions && typeof parsed.permissions === "object" ? parsed.permissions : {})
      },
      skills: typeof parsed.skills === "string" ? parsed.skills : fallback.skills,
      mcpServers: typeof parsed.mcpServers === "string" ? parsed.mcpServers : fallback.mcpServers,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt
    };
  } catch {
    return fallback;
  }
}

function createConversationId(prefix: string) {
  const randomPart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
}

function nameFromLocalPath(path: string) {
  const trimmed = path.trim();
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || trimmed || "Untitled";
}

function createConversationThread(title: string, draft = ""): ConversationThread {
  return {
    id: createConversationId("thread"),
    title,
    draft,
    updatedAt: new Date().toISOString()
  };
}

function createConversationAttachment(path: string): ConversationAttachment {
  return {
    id: createConversationId("attachment"),
    name: nameFromLocalPath(path),
    path,
    addedAt: new Date().toISOString()
  };
}

function createConversationMessage(
  role: ConversationMessage["role"],
  body: string,
  options: Partial<Pick<ConversationMessage, "jobId" | "status" | "attachments">> = {}
): ConversationMessage {
  return {
    id: createConversationId("message"),
    role,
    body,
    createdAt: new Date().toISOString(),
    ...options
  };
}

function createConversationProject(name: string, path = ""): ConversationProject {
  const thread = createConversationThread("New conversation");
  return {
    id: createConversationId("project"),
    name,
    path,
    threads: [thread],
    updatedAt: new Date().toISOString()
  };
}

function visibleConversationThreads(project: ConversationProject) {
  return project.threads.filter((thread) => !thread.archivedAt);
}

function visibleConversationProjects(projects: ConversationProject[]) {
  return projects
    .filter((project) => !project.archivedAt)
    .sort((first, second) => Number(Boolean(second.pinned)) - Number(Boolean(first.pinned)));
}

function defaultConversationWorkspaceState(): ConversationWorkspaceState {
  const project = createConversationProject("1");
  return {
    projects: [project],
    activeProjectId: project.id,
    activeThreadId: project.threads[0]?.id ?? ""
  };
}

function normalizeConversationWorkspaceState(value: Partial<ConversationWorkspaceState> | null): ConversationWorkspaceState {
  const fallback = defaultConversationWorkspaceState();
  if (!value || typeof value !== "object" || !Array.isArray(value.projects)) {
    return fallback;
  }

  const projects = value.projects.flatMap((rawProject): ConversationProject[] => {
    if (!rawProject || typeof rawProject !== "object") return [];
    const project = rawProject as Partial<ConversationProject>;
    const threads = Array.isArray(project.threads)
      ? project.threads.flatMap((rawThread): ConversationThread[] => {
          if (!rawThread || typeof rawThread !== "object") return [];
          const thread = rawThread as Partial<ConversationThread>;
          const id = typeof thread.id === "string" && thread.id ? thread.id : createConversationId("thread");
          const attachments = Array.isArray(thread.attachments)
            ? thread.attachments.flatMap((rawAttachment): ConversationAttachment[] => {
                if (!rawAttachment || typeof rawAttachment !== "object") return [];
                const attachment = rawAttachment as Partial<ConversationAttachment>;
                const path = typeof attachment.path === "string" ? attachment.path : "";
                const name = typeof attachment.name === "string" && attachment.name.trim() ? attachment.name.trim() : nameFromLocalPath(path);
                if (!path && !name) return [];
                return [{
                  id: typeof attachment.id === "string" && attachment.id ? attachment.id : createConversationId("attachment"),
                  name,
                  path: path || name,
                  addedAt: typeof attachment.addedAt === "string" ? attachment.addedAt : new Date().toISOString()
                }];
              })
            : [];
          const messages = Array.isArray(thread.messages)
            ? thread.messages.flatMap((rawMessage): ConversationMessage[] => {
                if (!rawMessage || typeof rawMessage !== "object") return [];
                const message = rawMessage as Partial<ConversationMessage>;
                const role = message.role === "assistant" || message.role === "system" || message.role === "user" ? message.role : "user";
                const body = typeof message.body === "string" ? message.body : "";
                if (!body.trim()) return [];
                const messageAttachments = Array.isArray(message.attachments)
                  ? message.attachments.flatMap((rawAttachment): ConversationAttachment[] => {
                      if (!rawAttachment || typeof rawAttachment !== "object") return [];
                      const attachment = rawAttachment as Partial<ConversationAttachment>;
                      const path = typeof attachment.path === "string" ? attachment.path : "";
                      const name = typeof attachment.name === "string" && attachment.name.trim() ? attachment.name.trim() : nameFromLocalPath(path);
                      if (!path && !name) return [];
                      return [{
                        id: typeof attachment.id === "string" && attachment.id ? attachment.id : createConversationId("attachment"),
                        name,
                        path: path || name,
                        addedAt: typeof attachment.addedAt === "string" ? attachment.addedAt : new Date().toISOString()
                      }];
                    })
                  : [];
                return [{
                  id: typeof message.id === "string" && message.id ? message.id : createConversationId("message"),
                  role,
                  body,
                  createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
                  jobId: typeof message.jobId === "string" ? message.jobId : undefined,
                  status: message.status === "sent" || message.status === "failed" || message.status === "offline" ? message.status : undefined,
                  attachments: messageAttachments
                }];
              })
            : [];
          return [{
            id,
            title: typeof thread.title === "string" && thread.title.trim() ? thread.title.trim() : "New conversation",
            draft: typeof thread.draft === "string" ? thread.draft : "",
            updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : new Date().toISOString(),
            pinned: Boolean(thread.pinned),
            unread: Boolean(thread.unread),
            archivedAt: typeof thread.archivedAt === "string" ? thread.archivedAt : undefined,
            attachments,
            messages
          }];
        })
      : [];
    const safeThreads = threads.length ? threads : [createConversationThread("New conversation")];
    return [{
      id: typeof project.id === "string" && project.id ? project.id : createConversationId("project"),
      name: typeof project.name === "string" && project.name.trim() ? project.name.trim() : "Project",
      path: typeof project.path === "string" ? project.path : "",
      threads: safeThreads,
      updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : new Date().toISOString(),
      pinned: Boolean(project.pinned),
      archivedAt: typeof project.archivedAt === "string" ? project.archivedAt : undefined
    }];
  });

  let safeProjects = projects.length ? projects : fallback.projects;
  if (!safeProjects.some((project) => !project.archivedAt)) {
    safeProjects = [createConversationProject("1"), ...safeProjects];
  }
  safeProjects = safeProjects.map((project) =>
    !project.archivedAt && !visibleConversationThreads(project).length
      ? { ...project, threads: [createConversationThread("New conversation"), ...project.threads] }
      : project
  );
  const activeProject =
    safeProjects.find((project) => !project.archivedAt && project.id === value.activeProjectId) ??
    visibleConversationProjects(safeProjects)[0] ??
    safeProjects[0];
  const visibleThreads = visibleConversationThreads(activeProject);
  const activeThread = visibleThreads.find((thread) => thread.id === value.activeThreadId) ?? visibleThreads[0] ?? activeProject.threads[0];
  return {
    projects: safeProjects,
    activeProjectId: activeProject.id,
    activeThreadId: activeThread?.id ?? ""
  };
}

function loadConversationWorkspaceState(): ConversationWorkspaceState {
  try {
    return normalizeConversationWorkspaceState(
      JSON.parse(window.localStorage.getItem("honeycomb.conversationWorkspace") || "null") as Partial<ConversationWorkspaceState> | null
    );
  } catch {
    return defaultConversationWorkspaceState();
  }
}

function saveConversationWorkspaceState(state: ConversationWorkspaceState) {
  window.localStorage.setItem("honeycomb.conversationWorkspace", JSON.stringify(state));
}

function conversationWorkspaceSnapshotFromState(
  state: ConversationWorkspaceState
): ConversationWorkspaceSnapshot {
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    projects: state.projects.map((project) => ({
      id: project.id,
      name: project.name,
      workspacePath: project.path.trim() || null,
      pinned: project.pinned ?? false,
      archivedAt: project.archivedAt ?? null,
      metadata: {},
      createdAt: project.updatedAt || generatedAt,
      updatedAt: project.updatedAt || generatedAt,
      conversations: project.threads.map((thread) => ({
        id: thread.id,
        projectId: project.id,
        title: thread.title,
        draft: thread.draft,
        attachments: thread.attachments ?? [],
        pinned: thread.pinned ?? false,
        unread: thread.unread ?? false,
        archivedAt: thread.archivedAt ?? null,
        metadata: {},
        createdAt: thread.updatedAt || generatedAt,
        updatedAt: thread.updatedAt || generatedAt,
        messages: (thread.messages ?? []).map((message) => ({
          id: message.id,
          conversationId: thread.id,
          role: message.role,
          body: message.body,
          status: message.status ?? "sent",
          jobId: message.jobId ?? null,
          attachments: message.attachments ?? [],
          metadata: {},
          createdAt: message.createdAt,
          updatedAt: message.createdAt
        }))
      }))
    }))
  };
}

function conversationWorkspaceStateFromSnapshot(
  snapshot: ConversationWorkspaceSnapshot,
  current: ConversationWorkspaceState
) {
  return normalizeConversationWorkspaceState({
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.workspacePath ?? "",
      pinned: project.pinned || undefined,
      archivedAt: project.archivedAt ?? undefined,
      updatedAt: project.updatedAt,
      threads: project.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        draft: conversation.draft,
        attachments: conversation.attachments,
        pinned: conversation.pinned || undefined,
        unread: conversation.unread || undefined,
        archivedAt: conversation.archivedAt ?? undefined,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages.map((message) => ({
          id: message.id,
          role: message.role,
          body: message.body,
          status: message.status === "pending" ? "sent" : message.status,
          jobId: message.jobId ?? undefined,
          attachments: message.attachments,
          createdAt: message.createdAt
        }))
      }))
    })),
    activeProjectId: current.activeProjectId,
    activeThreadId: current.activeThreadId
  });
}

function activeConversationDraft(state: ConversationWorkspaceState) {
  const activeProject = state.projects.find((project) => project.id === state.activeProjectId) ?? state.projects[0];
  if (!activeProject) return "";
  const activeThread = activeProject.threads.find((thread) => thread.id === state.activeThreadId && !thread.archivedAt) ?? visibleConversationThreads(activeProject)[0];
  return activeThread?.draft ?? "";
}

function buildPromptWithConversationAttachments(rawPrompt: string, attachments: ConversationAttachment[], language: Language) {
  if (!attachments.length) return rawPrompt;
  const header = language === "zh" ? "[Honeycomb \u5bf9\u8bdd\u9644\u4ef6]" : "[Honeycomb conversation attachments]";
  const lines = attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`);
  return [rawPrompt, "", header, ...lines].join("\n");
}

function saveSupervisorWorkbenchConfig(config: SupervisorWorkbenchConfig) {
  window.localStorage.setItem("honeycomb.supervisorWorkbench", JSON.stringify(config));
}

function buildWorkbenchPlanSteps(job: JobRecord | null, timeline: JobTimeline | null, language: Language): WorkbenchPlanStep[] {
  const terminal = job ? ["succeeded", "failed", "cancelled"].includes(job.status) : false;
  const blocked = job ? ["failed", "cancelled"].includes(job.status) : false;
  const workVisible = Boolean(timeline?.summary.totalTimelineItems);

  const labels = language === "zh"
    ? [
        ["任务进入", job ? `${jobDisplayTitle(job)} · ${routingModeLabels.zh[job.routingMode]}` : "等待用户创建第一个任务"],
        ["智能编排", job ? "面板 agent 已根据任务自动选择起步编排模式" : "创建任务后自动分析"],
        ["专业 agent 执行", workVisible ? "时间线已出现 agent 工作事件" : "等待 OpenClaw 写入执行事件"],
        ["质量关卡", terminal ? "任务已进入最终状态" : "等待测试、修正或人工确认"],
        ["交付与复盘", terminal ? "可进入记忆页采纳可复用经验" : "任务完成后沉淀经验候选"]
      ]
    : [
        ["Task intake", job ? `${jobDisplayTitle(job)} · ${routingModeLabels.en[job.routingMode]}` : "Waiting for the first job"],
        ["Smart routing", job ? "The panel agent selected an initial orchestration mode for this task" : "Analyzes automatically after job creation"],
        ["Specialist execution", workVisible ? "Timeline events show agent work in progress" : "Waiting for OpenClaw execution events"],
        ["Quality gate", terminal ? "The job reached a final state" : "Waiting for testing, fixing, or human review"],
        ["Delivery and review", terminal ? "Reusable experience can be reviewed from Memory" : "Experience candidates appear after completion"]
      ];

  if (!job) {
    return labels.map(([title, body], index) => ({
      title,
      body,
      state: index === 0 ? "active" : "pending"
    }));
  }

  const executionDone = terminal || ["testing", "fixing", "waiting_for_human"].includes(job.status);
  const qualityActive = ["testing", "fixing", "waiting_for_human"].includes(job.status);

  return labels.map(([title, body], index) => {
    if (index <= 1) return { title, body, state: "done" };
    if (index === 2) {
      return {
        title,
        body,
        state: executionDone ? "done" : "active"
      };
    }
    if (index === 3) {
      return {
        title,
        body,
        state: terminal ? (blocked ? "blocked" : "done") : qualityActive ? "active" : "pending"
      };
    }
    return {
      title,
      body,
      state: terminal ? (blocked ? "blocked" : "done") : "pending"
    };
  });
}

function buildSupervisorPromptWithWorkbenchContext(
  rawPrompt: string,
  config: SupervisorWorkbenchConfig,
  supervisorName: string,
  language: Language
) {
  const workspace = config.workspacePath.trim();
  const permissionLabels = translations[language].workbenchPermissionLabels;
  const enabledPermissions = supervisorPermissionKeys
    .filter((key) => config.permissions[key])
    .map((key) => permissionLabels[key])
    .join(", ") || (language === "zh" ? "无" : "none");
  const disabledPermissions = supervisorPermissionKeys
    .filter((key) => !config.permissions[key])
    .map((key) => permissionLabels[key])
    .join(", ") || (language === "zh" ? "无" : "none");

  if (language === "zh") {
    return [
      rawPrompt.trim(),
      "",
      "[Honeycomb 主管工作台上下文]",
      `面板主管 agent: ${supervisorName}`,
      `项目工作区: ${workspace || "未设置"}`,
      `允许的权限: ${enabledPermissions}`,
      `未允许的权限: ${disabledPermissions}`,
      `可用 Skills: ${config.skills.trim() || "未设置"}`,
      `可用 MCP: ${config.mcpServers.trim() || "未设置"}`,
      "执行要求: 按上述权限和工作区边界规划任务；不要假设未允许的本地写入、命令执行或 MCP 工具可用；不要要求用户重新提供 Honeycomb 已配置的信息。"
    ].join("\n");
  }

  return [
    rawPrompt.trim(),
    "",
    "[Honeycomb supervisor workbench context]",
    `Panel supervisor agent: ${supervisorName}`,
    `Project workspace: ${workspace || "not set"}`,
    `Allowed permissions: ${enabledPermissions}`,
    `Disabled permissions: ${disabledPermissions}`,
    `Available skills: ${config.skills.trim() || "not set"}`,
    `Available MCP: ${config.mcpServers.trim() || "not set"}`,
    "Execution rule: plan within these permission and workspace boundaries; do not assume disabled local writes, command execution, or MCP tools are available; do not ask the user to repeat information already configured in Honeycomb."
  ].join("\n");
}

function conversationMessagesForPanelChat(messages: ConversationMessage[]) {
  return messages
    .slice(-16)
    .map((message) => ({
      role: message.role,
      body: message.body
    }))
    .filter((message) => message.body.trim());
}

function providerVerificationErrorDetail(parsed: Record<string, unknown>) {
  const provider = parsed.provider && typeof parsed.provider === "object"
    ? parsed.provider as Record<string, unknown>
    : null;
  const verification = parsed.verification && typeof parsed.verification === "object"
    ? parsed.verification as Record<string, unknown>
    : null;
  const providerName = typeof provider?.displayName === "string" ? provider.displayName : typeof provider?.id === "string" ? provider.id : "";
  const model = typeof verification?.model === "string"
    ? verification.model
    : typeof provider?.defaultModel === "string"
      ? provider.defaultModel
      : typeof parsed.model === "string"
        ? parsed.model
        : "";
  const statusCode = typeof verification?.statusCode === "number" ? verification.statusCode : null;
  const message = typeof verification?.message === "string" && verification.message.trim()
    ? verification.message.trim()
    : typeof provider?.lastError === "string" && provider.lastError.trim()
      ? provider.lastError.trim()
      : typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : "";
  return [providerName, model, statusCode ? `HTTP ${statusCode}` : "", message].filter(Boolean).join(" / ");
}

function friendlyApiErrorMessage(error: unknown, language: Language = "en") {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown } & Record<string, unknown>;
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (parsed.error === "provider_verification_failed") {
      const detail = providerVerificationErrorDetail(parsed);
      return language === "zh"
        ? `\u9762\u677f Agent \u7684\u6a21\u578b\u8fde\u63a5\u9a8c\u8bc1\u5931\u8d25${detail ? `\uff1a${detail}` : ""}\u3002\u8bf7\u68c0\u67e5\u6a21\u578b\u540d\u3001API Key \u548c\u670d\u52a1\u5546\u8d26\u53f7\u72b6\u6001\u3002`
        : `The panel agent model verification failed${detail ? `: ${detail}` : ""}. Check the model name, API Key, and provider account status.`;
    }
    if (parsed.error === "execution_preflight_blocked") {
      const detail = taskPreflightMessage(
        parsed.preflight as TaskExecutionPreflight | null,
        language
      );
      return language === "zh"
        ? `\u4efb\u52a1\u4ecd\u672a\u5f00\u59cb\uff1a${detail}\u3002\u8bf7\u5148\u4fee\u6b63 Agent \u914d\u7f6e\uff0c\u518d\u70b9\u51fb\u201c\u6062\u590d\u4efb\u52a1\u201d\u3002`
        : `The task is still blocked: ${detail}. Fix the agent configuration, then resume the task again.`;
    }
    if (parsed.error === "model_call_reconciliation_required") {
      return language === "zh"
        ? "这次模型调用的结果还不能确定。请先在任务页核对服务商状态，Honeycomb 不会直接重复发送。"
        : "This model call has an unknown outcome. Reconcile it on the task page before resuming; Honeycomb will not replay it blindly.";
    }
    if (parsed.error === "provider_reconciliation_not_configured") {
      return language === "zh"
        ? "该服务商没有配置自动状态查询。请先在服务商控制台确认这次请求未执行，再使用人工确认。"
        : "Automatic status lookup is not configured for this provider. Check the provider console before confirming manually.";
    }
    if (parsed.error === "provider_reconciliation_query_failed") {
      return language === "zh"
        ? "暂时无法从服务商取得请求状态。任务仍保持暂停，不会重复扣费；稍后可以再次核对。"
        : "The provider status could not be retrieved. The task remains paused and will not be replayed; try again later.";
    }
    if (
      parsed.error === "model_call_request_reference_missing" ||
      parsed.error === "model_call_provider_missing"
    ) {
      return language === "zh"
        ? "这次旧请求缺少可自动核对的信息。请在服务商控制台确认后再人工处理。"
        : "This older request lacks enough data for automatic lookup. Check the provider console before resolving it manually.";
    }
    if (parsed.error === "provider_result_missing") {
      return language === "zh"
        ? "服务商显示请求已完成，但没有返回可恢复的结果内容。任务继续暂停，请到服务商控制台查看结果。"
        : "The provider reports completion but returned no recoverable output. The task remains paused; inspect the provider console.";
    }
    if (parsed.error === "provider_media_artifact_missing") {
      return language === "zh"
        ? "服务商显示生成已完成，但没有取回可下载的图片或视频地址。任务会继续暂停，不能把只有“成功”文字的结果当成交付完成。"
        : "The provider reports completion, but no downloadable image or video was recovered. The task remains paused rather than treating a text-only success as delivery.";
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // Keep the original error text.
  }
  return raw;
}

function taskPreflightMessage(preflight: TaskExecutionPreflight | null, language: Language) {
  const issues = preflight?.blockingIssues ?? [];
  if (!issues.length) {
    return language === "zh" ? "子 Agent 的模型连接尚未准备好。" : "A child-agent model connection is not ready.";
  }
  const labels: Record<string, { zh: string; en: string }> = {
    agent_config_not_found: { zh: "Agent 尚未注册", en: "agent is not registered" },
    agent_disabled: { zh: "Agent 已停用", en: "agent is disabled" },
    provider_not_bound: { zh: "未绑定模型服务商", en: "no model provider is assigned" },
    provider_not_found: { zh: "模型服务商记录不存在", en: "model provider record is missing" },
    provider_base_url_missing: { zh: "服务商接口地址缺失", en: "provider base URL is missing" },
    provider_api_key_missing: { zh: "API Key 未保存或无法读取", en: "API key is missing or unreadable" },
    model_not_configured: { zh: "模型名未配置", en: "model name is missing" },
    provider_verification_failed: { zh: "最近一次模型连接验证失败", en: "latest provider verification failed" },
    image_generation_model_required: { zh: "需要图片生成模型", en: "an image-generation model is required" },
    video_generation_model_required: { zh: "需要视频生成模型", en: "a video-generation model is required" },
    chat_model_required: { zh: "需要对话或文本模型", en: "a chat/text model is required" }
  };
  return issues
    .filter((entry, index, entries) =>
      entries.findIndex((candidate) => candidate.agentId === entry.agentId && candidate.code === entry.code) === index
    )
    .slice(0, 4)
    .map((entry) => {
      const label = labels[entry.code]?.[language] ?? entry.code;
      return `${entry.agentId}${language === "zh" ? "：" : ": "}${label}`;
    })
    .join(language === "zh" ? "；" : "; ");
}

function modelRetryFailureLabel(
  category: TaskExecutionRetryState["failureCategory"],
  language: Language
) {
  const labels: Record<TaskExecutionRetryState["failureCategory"], { zh: string; en: string }> = {
    cancelled: { zh: "\u4efb\u52a1\u5df2\u53d6\u6d88", en: "task cancelled" },
    configuration: { zh: "\u914d\u7f6e\u95ee\u9898", en: "configuration issue" },
    authentication: { zh: "\u8eab\u4efd\u9a8c\u8bc1\u5931\u8d25", en: "authentication failed" },
    authorization: { zh: "\u8d26\u53f7\u65e0\u6743\u9650", en: "permission denied" },
    quota_or_billing: { zh: "\u4f59\u989d\u6216\u989d\u5ea6\u4e0d\u8db3", en: "quota or billing" },
    model_or_endpoint: { zh: "\u6a21\u578b\u6216\u63a5\u53e3\u4e0d\u53ef\u7528", en: "model or endpoint unavailable" },
    invalid_request: { zh: "\u8bf7\u6c42\u53c2\u6570\u4e0d\u53ef\u7528", en: "invalid request" },
    rate_limited: { zh: "\u670d\u52a1\u5546\u9650\u6d41", en: "provider rate limit" },
    provider_timeout: { zh: "\u670d\u52a1\u5546\u8d85\u65f6", en: "provider timeout" },
    provider_server: { zh: "\u670d\u52a1\u5546\u6682\u65f6\u5f02\u5e38", en: "provider temporarily unavailable" },
    network_transient: { zh: "\u7f51\u7edc\u6682\u65f6\u4e0d\u901a", en: "temporary network failure" },
    network_unknown_outcome: { zh: "\u8fd4\u56de\u7ed3\u679c\u4e0d\u786e\u5b9a", en: "unknown request outcome" },
    output_invalid: { zh: "\u6a21\u578b\u8fd4\u56de\u5185\u5bb9\u65e0\u6548", en: "invalid model output" },
    unknown: { zh: "\u672a\u77e5\u9519\u8bef", en: "unknown error" }
  };
  return labels[category][language];
}

function reconciliationStatusLabel(status: string | null | undefined, language: Language) {
  const labels: Record<string, { zh: string; en: string }> = {
    pending: { zh: "等待核对", en: "Awaiting review" },
    provider_pending: { zh: "服务商仍在处理", en: "Provider still processing" },
    query_failed: { zh: "自动核对未成功", en: "Automatic check failed" },
    manual_review: { zh: "需要人工核对", en: "Manual review required" }
  };
  return (status && labels[status]?.[language]) || (language === "zh" ? "结果未知" : "Unknown outcome");
}

function reconciliationNoticeText(status: string | null | undefined, language: Language) {
  if (status === "provider_pending") {
    return language === "zh"
      ? "服务商仍在处理这次请求。Honeycomb 会保持暂停，不会重复发送。"
      : "The provider is still processing this request. Honeycomb will remain paused and will not replay it.";
  }
  if (status === "query_failed") {
    return language === "zh"
      ? "暂时没有查到可靠状态。任务仍保持暂停，稍后可再次核对。"
      : "A reliable status could not be retrieved. The task remains paused; check again later.";
  }
  if (status === "manual_review") {
    return language === "zh"
      ? "自动核对无法得出结论，请到服务商控制台查看请求记录。"
      : "Automatic reconciliation was inconclusive. Inspect the request in the provider console.";
  }
  return language === "zh"
    ? "网络中断发生在请求发出之后，当前无法确定服务商是否已执行。"
    : "The connection ended after dispatch, so it is not yet known whether the provider executed the request.";
}

function App() {
  const [language, setLanguage] = useState<Language>(getInitialLanguage);
  const [activeView, setActiveView] = useState<AppView>(getInitialView);
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [conversationState, setConversationState] = useState<ConversationWorkspaceState>(loadConversationWorkspaceState);
  const [prompt, setPrompt] = useState(() => activeConversationDraft(conversationState));
  const [routingMode, setRoutingMode] = useState<RoutingMode>("supervisor_pipeline");
  const [maxModelCalls, setMaxModelCalls] = useState(20);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [jobListPage, setJobListPage] = useState<ListJobsResponse["page"] | null>(null);
  const [jobStatusFilter, setJobStatusFilter] = useState<JobStatusFilter>("all");
  const [jobTimeFilter, setJobTimeFilter] = useState<JobTimeFilter>("all");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [jobPromptFilter, setJobPromptFilter] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [maxCostUsdDraft, setMaxCostUsdDraft] = useState("");
  const [timeline, setTimeline] = useState<JobTimeline | null>(null);
  const [unknownOutcomes, setUnknownOutcomes] = useState<UnknownOutcomeModelCallsResponse | null>(null);
  const [artifactDeliveries, setArtifactDeliveries] = useState<JobDeliveriesResponse | null>(null);
  const [reconciliationBusyId, setReconciliationBusyId] = useState("");
  const [reconciliationMessage, setReconciliationMessage] = useState("");
  const [reconciliationError, setReconciliationError] = useState("");
  const [experiences, setExperiences] = useState<ExperienceRecord[]>([]);
  const [experienceSummary, setExperienceSummary] = useState<ExperienceListResponse["summary"]>({
    candidate: 0,
    adopted: 0,
    rejected: 0
  });
  const [experienceFilter, setExperienceFilter] = useState<ExperienceStatus | "all">("candidate");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [memoryMessage, setMemoryMessage] = useState("");
  const [approvals, setApprovals] = useState<ToolApprovalRecord[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  const [approvalMessage, setApprovalMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualRefreshBusy, setManualRefreshBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetFlow, setResetFlow] = useState<FirstRunFlow | null>(null);
  const [setupComplete, setSetupComplete] = useState(
    () =>
      window.localStorage.getItem("honeycomb.setupCompleted") === "true" ||
      new URLSearchParams(window.location.search).get("skipOnboarding") === "true"
  );
  const [showTour, setShowTour] = useState(
    () =>
      (window.localStorage.getItem("honeycomb.setupCompleted") === "true" ||
        new URLSearchParams(window.location.search).get("skipOnboarding") === "true") &&
      window.localStorage.getItem("honeycomb.tourCompleted") !== "true"
  );
  const [tourIndex, setTourIndex] = useState(0);
  const [sideCollapsed, setSideCollapsed] = useState(
    () => window.localStorage.getItem("honeycomb.sideCollapsed") === "true"
  );
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [openProjectMenuId, setOpenProjectMenuId] = useState("");
  const [conversationContextMenu, setConversationContextMenu] = useState<ConversationContextMenuState>(null);
  const [archiveDeleteTarget, setArchiveDeleteTarget] = useState<ArchiveDeleteTarget | null>(null);
  const [textInputDialog, setTextInputDialog] = useState<TextInputDialogState | null>(null);
  const textInputDialogResolver = useRef<((value: string | null) => void) | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [projectListCollapsed, setProjectListCollapsed] = useState(false);
  const [securityRecord, setSecurityRecord] = useState<SecurityRecord | null>(loadSecurityRecord);
  const [locked, setLocked] = useState(() => Boolean(loadSecurityRecord()) && window.sessionStorage.getItem("agentOpenClaw.unlocked") !== "true");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockRecoveryAnswer, setUnlockRecoveryAnswer] = useState("");
  const [unlockMode, setUnlockMode] = useState<"password" | "recovery">("password");
  const [unlockError, setUnlockError] = useState("");
  const [securityEditUnlocked, setSecurityEditUnlocked] = useState(false);
  const [currentPasswordDraft, setCurrentPasswordDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [confirmPasswordDraft, setConfirmPasswordDraft] = useState("");
  const [recoveryQuestionChoice, setRecoveryQuestionChoice] = useState<RecoveryQuestionId | "custom">(
    securityRecord?.recoveryQuestionId || (securityRecord?.recoveryQuestion ? "custom" : "first_project")
  );
  const [recoveryQuestionDraft, setRecoveryQuestionDraft] = useState(securityRecord?.recoveryQuestion || "");
  const [recoveryAnswerDraft, setRecoveryAnswerDraft] = useState("");
  const [securityRecoveryOpen, setSecurityRecoveryOpen] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [outputStyleMessage, setOutputStyleMessage] = useState("");
  const [panelOutputStyle, setPanelOutputStyle] = useState<PanelOutputStyle>(() => loadPanelOutputStyle(loadFirstRunPreview()));
  const [providerApiKey, setProviderApiKey] = useState("");
  const [agentModelConfigs, setAgentModelConfigs] = useState<Record<string, AgentModelConfig>>(loadAgentModelConfigs);
  const [expandedAgentId, setExpandedAgentId] = useState("");
  const [agentConfigDraft, setAgentConfigDraft] = useState<AgentConfigDraft>({
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "",
    apiKey: "",
    apiKeyConfigured: false
  });
  const [agentConfigMessage, setAgentConfigMessage] = useState("");
  const [agentConfigError, setAgentConfigError] = useState("");
  const [agentConfigSaving, setAgentConfigSaving] = useState(false);
  const [showAgentApiKey, setShowAgentApiKey] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const conversationBodyRef = useRef<HTMLDivElement>(null);
  const [workbenchConfig, setWorkbenchConfig] = useState<SupervisorWorkbenchConfig>(loadSupervisorWorkbenchConfig);
  const [workbenchMessage, setWorkbenchMessage] = useState("");
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnosticsResponse | null>(null);
  const [runtimeRepairActions, setRuntimeRepairActions] = useState<RuntimeRepairAction[]>([]);
  const [runtimeRepairBusy, setRuntimeRepairBusy] = useState<RuntimeRepairActionId | "refresh" | "">("");
  const [runtimeRepairMessage, setRuntimeRepairMessage] = useState("");
  const [runtimeRepairError, setRuntimeRepairError] = useState("");
  const jobsRequestSeq = useRef(0);
  const jobDetailRequestSeq = useRef(0);
  const notificationStartedAt = useRef(Date.now());
  const seenNotificationIds = useRef<Set<string>>(loadSeenNotificationIds());
  const desktopExportedJobIds = useRef<Set<string>>(loadDesktopExportedJobIds());
  const deliveryProcessingJobIds = useRef<Set<string>>(new Set());
  const panelBackendConfigSyncKey = useRef("");
  const copy = translations[language];

  const statusText = useMemo(() => {
    if (apiState === "online") return copy.apiOnline;
    if (apiState === "offline") return copy.apiOffline;
    return copy.apiChecking;
  }, [apiState, copy]);

  const selectedFromList = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? selectedJob,
    [jobs, selectedJob, selectedJobId]
  );
  useEffect(() => {
    if (selectedFromList?.spendBudget.blockingScope !== "job") {
      setMaxCostUsdDraft("");
      return;
    }
    const currentLimit = selectedFromList.maxCostUsd ?? selectedFromList.spendBudget.maxCostUsd ?? 0;
    const minimum = selectedFromList.spendBudget.committedUsd + 0.01;
    setMaxCostUsdDraft(Math.max(currentLimit * 1.25, minimum).toFixed(2));
  }, [
    selectedFromList?.id,
    selectedFromList?.maxCostUsd,
    selectedFromList?.spendBudget.committedUsd,
    selectedFromList?.spendBudget.maxCostUsd,
    selectedFromList?.spendBudget.blockingScope
  ]);
  const selectedUnknownOutcomes = unknownOutcomes?.jobId === selectedJobId
    ? unknownOutcomes.modelCalls
    : [];
  const unknownOutcomesLoaded = unknownOutcomes?.jobId === selectedJobId;
  const selectedArtifactDeliveries = artifactDeliveries?.jobId === selectedJobId
    ? artifactDeliveries
    : null;

  const activeStatusFilter = jobStatusFilters.find((filter) => filter.id === jobStatusFilter);
  const trimmedJobPromptFilter = jobPromptFilter.trim();
  const runningJobCount = jobs.filter((job) => ["queued", "planning", "running", "testing", "fixing"].includes(job.status)).length;
  const latestJob = jobs[0] ?? null;
  const tourStep = copy.tourSteps[tourIndex];
  const displayedRoutingMode = latestJob?.routingMode ?? "supervisor_pipeline";
  const [firstRunPreview, setFirstRunPreview] = useState<FirstRunPreview | null>(loadFirstRunPreview);
  const [backendPanelSupervisorName, setBackendPanelSupervisorName] = useState("");
  const configuredProvider = configuredProviderLabel(firstRunPreview, language);
  const panelSupervisorDisplayName =
    firstRunPreview?.profile?.supervisorName ||
    backendPanelSupervisorName ||
    (language === "zh" ? "\u9762\u677f\u4e3b\u7ba1 Agent" : "Panel supervisor agent");
  const activeConversationProject = conversationState.projects.find((project) => project.id === conversationState.activeProjectId);
  const activeConversationThread = activeConversationProject?.threads.find((thread) => thread.id === conversationState.activeThreadId && !thread.archivedAt);
  const activeConversationMessages = activeConversationThread?.messages ?? [];
  const conversationBottomScrollKey = [
    activeView,
    conversationState.activeProjectId,
    conversationState.activeThreadId,
    activeConversationMessages.length,
    activeConversationMessages.at(-1)?.id ?? ""
  ].join(":");
  const workbenchJob = selectedFromList ?? latestJob;
  const workbenchPlanSteps = useMemo(
    () => buildWorkbenchPlanSteps(workbenchJob, timeline, language),
    [language, timeline, workbenchJob]
  );
  const enabledPermissionCount = supervisorPermissionKeys.filter((key) => workbenchConfig.permissions[key]).length;

  const allPrimaryNav = [
    { id: "dashboard" as const, icon: Gauge, label: copy.dashboard, group: copy.navGroups.operate },
    { id: "setup" as const, icon: Sparkles, label: copy.setupTab, group: copy.navGroups.operate },
    { id: "conversations" as const, icon: MessageSquare, label: copy.conversationsView, group: copy.navGroups.operate },
    { id: "jobs" as const, icon: ListChecks, label: copy.jobsView, group: copy.navGroups.operate },
    { id: "approvals" as const, icon: ShieldQuestion, label: copy.approvalsView, group: copy.navGroups.operate },
    { id: "agents" as const, icon: Bot, label: copy.agentsView, group: copy.navGroups.build },
    { id: "models" as const, icon: SlidersHorizontal, label: copy.modelsView, group: copy.navGroups.build },
    { id: "memory" as const, icon: History, label: copy.memoryView, group: copy.navGroups.build }
  ];
  const primaryNav = setupComplete || showTour
    ? allPrimaryNav.filter((item) => item.id !== "setup")
    : allPrimaryNav.filter((item) => item.id === "setup");
  const routingLabel = (mode: RoutingMode) => routingModeLabels[language][mode];
  const agentSequenceLabel = (value: string) => {
    if (language !== "zh") return value;
    return value
      .replaceAll("panel-supervisor-agent", "面板主管 Agent")
      .replaceAll("main-agent", "主控 Agent")
      .replaceAll("research-agent", "研究 Agent")
      .replaceAll("writer-agent", "写作 Agent")
      .replaceAll("image-agent", "图像 Agent")
      .replaceAll("video-agent", "视频 Agent")
      .replaceAll("test-agent", "质检 Agent")
      .replaceAll("main", "主控")
      .replaceAll("research", "研究")
      .replaceAll("writer", "写作")
      .replaceAll("image", "图像")
      .replaceAll("video", "视频")
      .replaceAll("test", "质检");
  };

  function notifyOnce(payload: DesktopNotificationPayload) {
    if (seenNotificationIds.current.has(payload.id)) {
      return;
    }
    seenNotificationIds.current.add(payload.id);
    saveSeenNotificationIds(seenNotificationIds.current);
    void showDesktopNotification(payload);
  }

  useEffect(() => {
    window.localStorage.setItem("agentOpenClaw.language", language);
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem("agentOpenClaw.activeView", activeView);
  }, [activeView]);

  useEffect(() => {
    window.localStorage.setItem("honeycomb.sideCollapsed", String(sideCollapsed));
  }, [sideCollapsed]);

  useEffect(() => {
    setPanelOutputStyle(loadPanelOutputStyle(firstRunPreview));
  }, [firstRunPreview]);

  useEffect(() => {
    if (!archiveDeleteTarget && !textInputDialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setArchiveDeleteTarget(null);
        resolveTextInputDialog(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [archiveDeleteTarget, textInputDialog]);

  useEffect(() => {
    if (activeView !== "conversations") return;
    const frameId = window.requestAnimationFrame(() => scrollConversationToBottom());
    const timeoutId = window.setTimeout(() => scrollConversationToBottom(), 80);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [activeView, conversationBottomScrollKey]);

  useEffect(() => {
    let cancelled = false;
    const localPreview = loadFirstRunPreview();
    if (localPreview) {
      setFirstRunPreview(localPreview);
    }
    loadFirstRunPreviewFromDesktop().then((desktopPreview) => {
      if (cancelled) {
        return;
      }
      if (desktopPreview) {
        setFirstRunPreview(desktopPreview);
        return;
      }
      if (isTauriRuntime() && (localPreview || setupComplete)) {
        window.localStorage.removeItem("honeycomb.firstRunPreview");
        window.localStorage.removeItem("honeycomb.setupCompleted");
        setFirstRunPreview(null);
        setSetupComplete(false);
        setShowTour(false);
        setActiveView("setup");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [setupComplete, activeView, resetFlow]);

  useEffect(() => {
    let cancelled = false;
    async function syncAgentConfigs() {
      const [desktopConfigs, loadedProviderApiKey, backendAgents, backendProviders] = await Promise.all([
        loadAgentModelConfigsFromDesktop(),
        loadProviderApiKeyFromDesktop(),
        listAgentConfigs().then((response) => response.agents).catch(() => null),
        listModelProviders().then((response) => response.providers).catch(() => null)
      ]);
      if (cancelled) return;
      if (backendAgents) {
        const backendPanelAgent = backendAgents.find((agent) => uiAgentIdFromBackend(agent.id) === "panel-supervisor-agent");
        const backendPanelName = backendPanelAgent?.displayName.trim() || "";
        setBackendPanelSupervisorName(
          backendPanelName && (backendPanelName !== "Panel Agent" || !firstRunPreview?.profile?.supervisorName)
            ? backendPanelName
            : ""
        );
      }
      setProviderApiKey(loadedProviderApiKey);
      setAgentModelConfigs((current) => {
        let merged = { ...current, ...desktopConfigs };
        if (backendAgents && backendProviders) {
          merged = mergeBackendAgentModelConfigs(merged, backendAgents, backendProviders);
        }
        const provider = firstRunPreview?.provider;
        if (provider?.apiKeyConfigured || loadedProviderApiKey) {
          const existing = merged["panel-supervisor-agent"];
          const apiKey = existing?.apiKey || loadedProviderApiKey;
          const model = existing?.model || provider?.model || "";
          const providerReference = resolveProviderForAgent(model, existing, firstRunPreview);
          merged["panel-supervisor-agent"] = {
            providerName: existing?.providerName || provider?.providerName || providerReference.providerName,
            baseUrl: existing?.baseUrl || provider?.baseUrl || providerReference.baseUrl,
            model,
            apiKey,
            apiKeyConfigured: Boolean(apiKey.trim()) || provider?.apiKeyConfigured === true,
            verifiedAt: existing?.verifiedAt,
            appliedAt: existing?.appliedAt
          };
        }
        saveAgentModelConfigs(merged);
        return merged;
      });
    }
    void syncAgentConfigs();
    return () => {
      cancelled = true;
    };
  }, [firstRunPreview]);

  useEffect(() => {
    if (!showTour && !setupComplete && activeView !== "setup") {
      setActiveView("setup");
    }
  }, [activeView, setupComplete, showTour]);

  function getJobTimeWindow() {
    if (jobTimeFilter === "24h") {
      return { since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), until: undefined };
    }
    if (jobTimeFilter === "7d") {
      return { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), until: undefined };
    }
    if (jobTimeFilter === "custom") {
      return {
        since: localDateTimeToIso(customSince),
        until: localDateTimeToIso(customUntil)
      };
    }
    return { since: undefined, until: undefined };
  }

  async function refreshJobs(preferredJobId = selectedJobId) {
    const requestSeq = ++jobsRequestSeq.current;
    const timeWindow = getJobTimeWindow();
    const response = await listJobs({
      limit: 50,
      status: activeStatusFilter?.status,
      prompt: trimmedJobPromptFilter || undefined,
      since: timeWindow.since,
      until: timeWindow.until,
      sort: "createdAt",
      order: "desc"
    });
    if (requestSeq !== jobsRequestSeq.current) {
      return selectedJobId;
    }

    setJobs(response.jobs);
    setJobListPage(response.page);
    const nextSelectedId = response.jobs.some((job) => job.id === preferredJobId)
      ? preferredJobId
      : response.jobs[0]?.id || "";
    setSelectedJobId(nextSelectedId);
    for (const job of response.jobs) {
      if (
        job.status === "waiting_for_human" &&
        [
          "artifact_delivery_pending",
          "artifact_delivery_authorization_required",
          "artifact_delivery_failed",
          "artifact_delivery_resume_failed"
        ]
          .includes(job.heartbeatNote ?? "")
      ) {
        void maybeDeliverArtifactsToDesktop(job);
      }
    }
    return nextSelectedId;
  }

  async function loadMoreJobs() {
    if (!jobListPage?.nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const requestSeq = ++jobsRequestSeq.current;
      const timeWindow = getJobTimeWindow();
      const response = await listJobs({
        limit: 50,
        status: activeStatusFilter?.status,
        prompt: trimmedJobPromptFilter || undefined,
        since: timeWindow.since,
        until: timeWindow.until,
        sort: "createdAt",
        order: "desc",
        cursor: jobListPage.nextCursor
      });
      if (requestSeq !== jobsRequestSeq.current) {
        return;
      }

      setJobs((currentJobs) => {
        const existingIds = new Set(currentJobs.map((job) => job.id));
        return [...currentJobs, ...response.jobs.filter((job) => !existingIds.has(job.id))];
      });
      setJobListPage(response.page);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function maybeDeliverArtifactsToDesktop(job: JobRecord) {
    const durableDeliveryPending = job.status === "waiting_for_human" && [
      "artifact_delivery_pending",
      "artifact_delivery_authorization_required",
      "artifact_delivery_failed",
      "artifact_delivery_resume_failed"
    ].includes(job.heartbeatNote ?? "");
    if (durableDeliveryPending) {
      if (!isTauriRuntime() || deliveryProcessingJobIds.current.has(job.id)) {
        return;
      }
      deliveryProcessingJobIds.current.add(job.id);
      try {
        const summary = await getJobDeliveries(job.id);
        const localDeliveries = summary.deliveries.filter(
          (delivery) => delivery.required &&
            ["desktop", "workspace", "custom"].includes(delivery.target) &&
            delivery.status !== "succeeded" &&
            delivery.status !== "cancelled"
        );
        for (const delivery of localDeliveries) {
          let claim: Awaited<ReturnType<typeof claimArtifactDelivery>>;
          try {
            claim = await claimArtifactDelivery(job.id, delivery.id);
          } catch {
            continue;
          }

          try {
            const file = claim.delivery.artifactFile;
            if (!file?.downloadable) {
              throw new Error("artifact_source_unavailable");
            }
            const download = await resolveArtifactDownloadRequest(file);
            if (!download) {
              throw new Error("artifact_download_url_missing");
            }
            const destination = claim.delivery.destination;
            if (!destination) {
              throw new Error(claim.delivery.authorizationError ?? "artifact_destination_authorization_missing");
            }
            const result = await invokeDesktopCommand<DesktopDownloadResult>("download_url_to_destination", {
              payload: {
                url: download.url,
                fileName: claim.delivery.requestedFileName,
                authorization: download.authorization,
                expectedSizeBytes: claim.delivery.expectedSizeBytes,
                expectedChecksumSha256: claim.delivery.expectedChecksumSha256,
                destinationKind: destination.kind,
                authorizedRootPath: destination.rootPath,
                destinationRelativePath: destination.relativeDirectory
              }
            });
            if (result.error || !result.available || !result.value) {
              throw result.error ?? new Error("desktop_export_unavailable");
            }
            if (
              claim.delivery.expectedChecksumSha256 &&
              result.value.checksumSha256.toLowerCase() !== claim.delivery.expectedChecksumSha256.toLowerCase()
            ) {
              throw new Error("download_checksum_mismatch");
            }
            await completeArtifactDelivery({
              jobId: job.id,
              deliveryId: claim.delivery.id,
              claimToken: claim.claimToken,
              deliveredPath: result.value.path,
              deliveredSizeBytes: result.value.bytes,
              deliveredChecksumSha256: result.value.checksumSha256
            });
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            await failArtifactDelivery({
              jobId: job.id,
              deliveryId: claim.delivery.id,
              claimToken: claim.claimToken,
              error: message
            }).catch(() => undefined);
          }
        }

        const latest = await getJobDeliveries(job.id);
        if (latest.readyToFinalize) {
          await finalizeArtifactDeliveries(job.id).catch(() => undefined);
        }
      } catch (caught) {
        console.warn("Failed to deliver generated artifacts", caught);
      } finally {
        deliveryProcessingJobIds.current.delete(job.id);
      }
      return;
    }

    if (job.status !== "succeeded" || !shouldExportJobToDesktop(job) || desktopExportedJobIds.current.has(job.id)) {
      return;
    }

    try {
      const artifacts = await getJobArtifacts(job.id);
      const seenMediaSources = new Set<string>();
      const mediaFiles = artifacts.artifacts
        .flatMap((artifact) => artifact.files)
        .filter((file) => {
          const kind = (file.kind ?? "").toLowerCase();
          const source = file.filePath ?? file.downloadUrl ?? file.externalUrl;
          const isMedia = kind === "image" || kind === "video" || /^image\//i.test(file.mimeType ?? "") || /^video\//i.test(file.mimeType ?? "");
          if (!file.downloadable || !source || !isMedia || seenMediaSources.has(source)) {
            return false;
          }
          seenMediaSources.add(source);
          return true;
        });

      if (!mediaFiles.length) {
        return;
      }

      const title = jobDisplayTitle(job);
      for (const [index, file] of mediaFiles.entries()) {
        const download = await resolveArtifactDownloadRequest(file);
        if (!download) {
          continue;
        }
        const suffix = mediaFiles.length > 1 ? `-${index + 1}` : "";
        const fallbackExtension = (file.kind ?? "").toLowerCase() === "video" ? ".mp4" : ".png";
        const fileName = `${title}${suffix}${extensionFromFileName(file.fileName, fallbackExtension)}`;
        const result = await invokeDesktopCommand<DesktopDownloadResult>("download_url_to_destination", {
          payload: {
            url: download.url,
            fileName,
            authorization: download.authorization,
            expectedSizeBytes: file.sizeBytes,
            expectedChecksumSha256: null,
            destinationKind: "desktop"
          }
        });
        if (result.error || !result.available) {
          throw result.error ?? new Error("desktop_export_unavailable");
        }
      }

      desktopExportedJobIds.current.add(job.id);
      saveDesktopExportedJobIds(desktopExportedJobIds.current);
    } catch (caught) {
      console.warn("Failed to export generated media to desktop", caught);
    }
  }

  async function refreshJob(targetJobId = selectedJobId) {
    const requestSeq = ++jobDetailRequestSeq.current;
    if (!targetJobId) {
      setSelectedJob(null);
      setTimeline(null);
      setUnknownOutcomes(null);
      setArtifactDeliveries(null);
      return;
    }

    const timelineCursor =
      timeline?.job.id === targetJobId && timeline.summary.nextCursor
        ? timeline.summary.nextCursor
        : undefined;
    const [job, nextTimeline, nextUnknownOutcomes, nextArtifactDeliveries] = await Promise.all([
      getJob(targetJobId),
      getJobTimeline(targetJobId, 500, undefined, timelineCursor),
      listJobUnknownOutcomes(targetJobId),
      getJobDeliveries(targetJobId)
    ]);
    if (requestSeq !== jobDetailRequestSeq.current) {
      return;
    }
    setSelectedJob(job);
    setUnknownOutcomes(nextUnknownOutcomes);
    setArtifactDeliveries(nextArtifactDeliveries);
    void maybeDeliverArtifactsToDesktop(job);
    setTimeline((currentTimeline) => {
      if (!timelineCursor || currentTimeline?.job.id !== targetJobId) {
        return nextTimeline;
      }

      const existingIds = new Set(currentTimeline.timeline.map((item) => item.id));
      const appendedItems = nextTimeline.timeline.filter((item) => !existingIds.has(item.id));
      return {
        ...nextTimeline,
        timeline: [...currentTimeline.timeline, ...appendedItems]
      };
    });
  }

  async function refreshAll(targetJobId = selectedJobId) {
    const nextSelectedId = await refreshJobs(targetJobId);
    await refreshJob(nextSelectedId);
  }

  async function probeOpenClawStatus() {
    try {
      await getHealth();
      setApiState("online");
      return true;
    } catch {
      setApiState("offline");
      return false;
    }
  }

  async function refreshFromBackend(targetJobId = selectedJobId) {
    if (manualRefreshBusy) return;
    setManualRefreshBusy(true);
    try {
      const online = await probeOpenClawStatus();
      if (!online) {
        setError(language === "zh" ? "OpenClaw 后端仍然无法连接。" : "OpenClaw backend is still unreachable.");
        return;
      }
      await refreshAll(targetJobId);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setManualRefreshBusy(false);
    }
  }

  async function refreshExperiences() {
    const response = await listExperiences(experienceFilter === "all" ? undefined : experienceFilter);
    setExperiences(response.experiences);
    setExperienceSummary(response.summary);
  }

  async function refreshApprovals() {
    const response = await listToolApprovals({ status: "pending", limit: 100 });
    setApprovals(response.approvals);
  }

  async function refreshRuntimeRepairPanel() {
    setRuntimeRepairBusy((current) => current || "refresh");
    setRuntimeRepairError("");
    try {
      const [diagnostics, repairCatalog] = await Promise.all([
        getRuntimeDiagnostics(),
        listRuntimeRepairActions()
      ]);
      setRuntimeDiagnostics(diagnostics);
      setRuntimeRepairActions(repairCatalog.actions);
    } catch (caught) {
      setRuntimeRepairError(caught instanceof Error ? caught.message : copy.workbenchRepairUnavailable);
    } finally {
      setRuntimeRepairBusy((current) => current === "refresh" ? "" : current);
    }
  }

  async function runRepairFromWorkbench(action: RuntimeRepairAction) {
    setRuntimeRepairBusy(action.id);
    setRuntimeRepairError("");
    setRuntimeRepairMessage(copy.workbenchRepairRunning);
    try {
      const repair = await runRuntimeRepairAction({
        action: action.id,
        panelAgentName: action.id === "agents.seedDefaults" ? panelSupervisorDisplayName : undefined,
        allowDiscoveredUserRuntime: false
      });
      if (repair.ok) {
        setRuntimeRepairMessage(repair.summary || copy.workbenchRepairDone);
      } else {
        setRuntimeRepairMessage("");
        setRuntimeRepairError(repair.summary || copy.workbenchRepairFailed);
      }
      await refreshRuntimeRepairPanel();
    } catch (caught) {
      setRuntimeRepairMessage("");
      setRuntimeRepairError(caught instanceof Error ? caught.message : copy.workbenchRepairFailed);
    } finally {
      setRuntimeRepairBusy("");
    }
  }

  async function decideApproval(approvalId: string, decision: "approve" | "reject") {
    setApprovalBusy(true);
    setApprovalError("");
    setApprovalMessage("");
    try {
      if (decision === "approve") {
        await approveToolApproval(approvalId, { decidedBy: "desktop-user" });
        setApprovalMessage(copy.approvalApproved);
      } else {
        await rejectToolApproval(approvalId, { decidedBy: "desktop-user" });
        setApprovalMessage(copy.approvalRejected);
      }
      await refreshApprovals();
    } catch (caught) {
      setApprovalError(caught instanceof Error ? caught.message : copy.approvalDecisionFailed);
    } finally {
      setApprovalBusy(false);
    }
  }

  async function changeExperienceStatus(
    experienceId: string,
    status: Exclude<ExperienceStatus, "candidate">
  ) {
    setMemoryBusy(true);
    setMemoryError("");
    setMemoryMessage("");
    try {
      const result = status === "adopted"
        ? await adoptExperience(experienceId)
        : await rejectExperience(experienceId);
      setMemoryMessage(
        language === "zh"
          ? status === "adopted"
            ? "经验已采纳，后续检索可以使用它。"
            : "经验已拒绝，不会进入可复用记忆。"
          : status === "adopted"
            ? "Experience adopted and available for future retrieval."
            : "Experience rejected and excluded from reusable memory."
      );
      if (!result.changed) {
        setMemoryMessage(language === "zh" ? "经验状态没有变化。" : "Experience status was already up to date.");
      }
      await refreshExperiences();
    } catch (caught) {
      setMemoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMemoryBusy(false);
    }
  }

  async function ensurePanelAgentBackendConfig() {
    const localPanelConfig = agentModelConfigs["panel-supervisor-agent"];
    const apiKey = localPanelConfig?.apiKey?.trim() || providerApiKey.trim();
    const model = localPanelConfig?.model.trim() || firstRunPreview?.provider?.model?.trim() || "";
    if (!apiKey || !model) {
      return;
    }

    const syncKey = `${model}:${apiKey.length}:${apiKey.slice(0, 4)}:${apiKey.slice(-4)}`;
    if (panelBackendConfigSyncKey.current === syncKey) {
      return;
    }

    const backendResult = await saveBackendAgentModelConfig("panel-supervisor-agent", {
      model,
      apiKey,
      allowDiscoveredUserRuntime: false
    });
    panelBackendConfigSyncKey.current = syncKey;
    const backendName = backendResult.agent.displayName.trim();
    if (backendName && (backendName !== "Panel Agent" || !firstRunPreview?.profile?.supervisorName)) {
      setBackendPanelSupervisorName(backendName);
    }
  }

  async function sendConversationMessage() {
    if (busy) return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError(language === "zh" ? "\u8bf7\u5148\u5199\u4e0b\u8981\u53d1\u9001\u7684\u5185\u5bb9\u3002" : "Type a message before sending.");
      return;
    }
    const activeProject = conversationState.projects.find((project) => project.id === conversationState.activeProjectId);
    const activeThread = activeProject?.threads.find((thread) => thread.id === conversationState.activeThreadId && !thread.archivedAt);
    if (!activeProject || !activeThread) {
      setError(language === "zh" ? "\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u53ef\u7528\u5bf9\u8bdd\u3002" : "Choose an available conversation first.");
      return;
    }
    const activeWorkspacePath = activeProject.path || workbenchConfig.workspacePath;
    const outgoingAttachments = activeThread.attachments ?? [];
    const userMessage = createConversationMessage("user", trimmedPrompt, {
      attachments: outgoingAttachments
    });
    const updatedAt = userMessage.createdAt;
    const stateWithUserMessage = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              updatedAt,
              threads: project.threads.map((thread) =>
                thread.id === activeThread.id
                  ? {
                      ...thread,
                      draft: "",
                      attachments: [],
                      messages: [...(thread.messages ?? []), userMessage],
                      title: thread.title === "New conversation" || thread.title === "\u65b0\u5bf9\u8bdd"
                        ? trimmedPrompt.slice(0, 64)
                        : thread.title,
                      updatedAt
                    }
                  : thread
              )
            }
          : project
      )
    });
    setPrompt("");
    setAttachmentMenuOpen(false);
    setError(null);
    const backendOnline = apiState === "online" || await probeOpenClawStatus();
    if (!backendOnline) {
      const offlineMessage = createConversationMessage(
        "system",
        language === "zh"
          ? "OpenClaw \u540e\u7aef\u6682\u65f6\u79bb\u7ebf\uff0c\u5185\u5bb9\u5df2\u4fdd\u5b58\u5230\u5f53\u524d\u5bf9\u8bdd\u3002\u540e\u7aef\u5728\u7ebf\u540e\u53ef\u4ee5\u7ee7\u7eed\u53d1\u9001\u65b0\u4efb\u52a1\u3002"
          : "OpenClaw is offline. The message is saved in this conversation; send a new task once the backend is online.",
        { status: "offline" }
      );
      persistConversationState({
        ...stateWithUserMessage,
        projects: stateWithUserMessage.projects.map((project) =>
          project.id === activeProject.id
            ? {
                ...project,
                threads: project.threads.map((thread) =>
                  thread.id === activeThread.id
                    ? { ...thread, messages: [...(thread.messages ?? []), offlineMessage], updatedAt: offlineMessage.createdAt }
                    : thread
                )
              }
            : project
        )
      });
      return;
    }
    setBusy(true);
    let nextConversationState = stateWithUserMessage;
    const messageWithAttachments = buildPromptWithConversationAttachments(trimmedPrompt, outgoingAttachments, language);
    try {
      await syncConversationWorkspace(conversationWorkspaceSnapshotFromState(stateWithUserMessage));
      let panelTaskPlan: TaskOrchestrationPlan | null = null;
      let panelIntent: "chat" | "task" = "chat";
      try {
        try {
          await ensurePanelAgentBackendConfig();
        } catch {
          // The backend panel endpoint reports a structured degraded plan when model setup is unavailable.
        }
        const panelResponse = await sendPanelChat({
          message: messageWithAttachments,
          messages: conversationMessagesForPanelChat([...(activeThread.messages ?? []), userMessage]),
          supervisorName: panelSupervisorDisplayName,
          projectPath: activeWorkspacePath,
          projectName: activeProject.name,
          latestJobId: latestJob?.id,
          sourceMessageId: userMessage.id,
          requesterId: "desktop-app",
          maxModelCalls,
          outputStyle: panelOutputStyle,
          language
        });
        panelIntent = panelResponse.intent;
        panelTaskPlan = panelResponse.taskPlan;
        const assistantMessage = createConversationMessage("assistant", panelResponse.message, { status: "sent" });
        nextConversationState = appendMessagesToConversationState(
          nextConversationState,
          activeProject.id,
          activeThread.id,
          [assistantMessage]
        );
      } catch (chatError) {
        const chatErrorMessage = friendlyApiErrorMessage(chatError, language);
        const failedChatMessage = createConversationMessage(
          "system",
          language === "zh"
            ? `面板 Agent 暂时无法处理这条消息：${chatErrorMessage}`
            : `The panel agent could not process this message: ${chatErrorMessage}`,
          { status: "failed" }
        );
        appendMessagesToConversationState(
          nextConversationState,
          activeProject.id,
          activeThread.id,
          [failedChatMessage]
        );
        setError(chatErrorMessage);
        return;
      }

      if (panelIntent !== "task") {
        setError(null);
        return;
      }
      if (!panelTaskPlan) {
        throw new Error(
          language === "zh"
            ? "面板 Agent 没有返回可执行的任务计划。"
            : "The panel agent did not return an executable task plan."
        );
      }

      const effectiveWorkbenchConfig = {
        ...workbenchConfig,
        workspacePath: activeWorkspacePath
      };
      const promptWithWorkbenchContext = buildSupervisorPromptWithWorkbenchContext(
        messageWithAttachments,
        effectiveWorkbenchConfig,
        panelSupervisorDisplayName,
        language
      );
      const effectiveMaxModelCalls = panelTaskPlan.maxModelCalls;
      const created = await createJob({
        prompt: promptWithWorkbenchContext,
        displayTitle: panelTaskPlan.title,
        orchestrationPlan: panelTaskPlan,
        conversationId: activeThread.id,
        sourceMessageId: userMessage.id,
        workdir: activeWorkspacePath.trim() || undefined,
        routingMode: panelTaskPlan.routingMode,
        maxModelCalls: effectiveMaxModelCalls
      });
      if (created.status === "waiting_for_human") {
        const preflightDetail = taskPreflightMessage(created.preflight, language);
        const blockedMessage = createConversationMessage(
          "assistant",
          language === "zh"
            ? `任务“${panelTaskPlan.title}”已保存，但尚未开始执行。执行前检查发现：${preflightDetail}。请到 Agents 页面补全对应 Agent 的模型和 API Key，然后恢复任务。`
            : `Task “${panelTaskPlan.title}” was saved but has not started. Preflight found: ${preflightDetail}. Configure the affected agent model and API key in Agents, then resume the task.`,
          { jobId: created.jobId, status: "sent" }
        );
        appendMessagesToConversationState(
          nextConversationState,
          activeProject.id,
          activeThread.id,
          [blockedMessage]
        );
        await refreshAll(created.jobId);
        setError(null);
        return;
      }
      const budgetNote =
        effectiveMaxModelCalls > maxModelCalls
          ? language === "zh"
            ? `\n\u5df2\u81ea\u52a8\u628a\u6a21\u578b\u8c03\u7528\u9884\u7b97\u4ece ${maxModelCalls} \u63d0\u9ad8\u5230 ${effectiveMaxModelCalls}\uff0c\u907f\u514d\u8be5\u6a21\u5f0f\u5728\u4e2d\u9014\u56e0\u9884\u7b97\u4e0d\u8db3\u505c\u4f4f\u3002`
            : `\nAutomatically raised the model-call budget from ${maxModelCalls} to ${effectiveMaxModelCalls} so this routing mode does not pause mid-run.`
          : "";
      const simulationNote = created.preflight?.status === "simulation"
        ? language === "zh"
          ? "\n\u5f53\u524d\u540e\u7aef\u5904\u4e8e\u6a21\u62df\u6a21\u5f0f\uff1a\u672c\u6b21\u4f1a\u6f14\u7ec3\u4efb\u52a1\u6d41\u7a0b\uff0c\u4f46\u4e0d\u4f1a\u8c03\u7528\u5b50 Agent \u7684\u771f\u5b9e\u6a21\u578b\uff0c\u4e5f\u4e0d\u4f1a\u751f\u6210\u771f\u5b9e\u6587\u4ef6\u3002"
          : "\nThe backend is in simulation mode. This run exercises the workflow but will not call child-agent models or create real files."
        : "";
      const createdJobTitle = panelTaskPlan.title;
      const assistantMessage = createConversationMessage(
        "assistant",
        language === "zh"
          ? `\u4efb\u52a1\u5df2\u6d3e\u53d1\uff1a${createdJobTitle}\u3002\u4f60\u53ef\u4ee5\u5728 Tasks \u9875\u67e5\u770b\u8fdb\u7a0b\u3002${budgetNote}${simulationNote}`
          : `Task dispatched: ${createdJobTitle}. You can inspect progress in Tasks.${budgetNote}${simulationNote}`,
        { jobId: created.jobId, status: "sent" }
      );
      appendMessagesToConversationState(nextConversationState, activeProject.id, activeThread.id, [assistantMessage]);
      await refreshAll(created.jobId);
    } catch (caught) {
      const errorMessage = friendlyApiErrorMessage(caught, language);
      const failedMessage = createConversationMessage(
        "system",
        language === "zh" ? `\u53d1\u9001\u5230 Agent \u56e2\u961f\u5931\u8d25\uff1a${errorMessage}` : `Failed to send to the agent team: ${errorMessage}`,
        { status: "failed" }
      );
      appendMessagesToConversationState(nextConversationState, activeProject.id, activeThread.id, [failedMessage]);
      setError(errorMessage);
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelectedJob() {
    if (!selectedJobId) return;
    setBusy(true);
    setError(null);
    try {
      await cancelJob(selectedJobId);
      await refreshAll(selectedJobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function unlockWithPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!securityRecord) return;
    const hash = await hashSecret(unlockPassword, securityRecord.passwordSalt);
    if (hash !== securityRecord.passwordHash) {
      setUnlockError(copy.unlockFailed);
      return;
    }
    window.sessionStorage.setItem("agentOpenClaw.unlocked", "true");
    setLocked(false);
    setUnlockError("");
  }

  async function unlockWithRecovery(event: React.FormEvent) {
    event.preventDefault();
    if (!securityRecord || !hasRecoveryQuestion(securityRecord) || !securityRecord.recoverySalt || !securityRecord.recoveryHash) return;
    const hash = await hashSecret(unlockRecoveryAnswer, securityRecord.recoverySalt);
    if (hash !== securityRecord.recoveryHash) {
      setUnlockError(copy.recoveryFailed);
      return;
    }
    window.sessionStorage.setItem("agentOpenClaw.unlocked", "true");
    setLocked(false);
    setActiveView("settings");
    setUnlockError("");
  }

  function selectedRecoveryQuestion() {
    if (recoveryQuestionChoice === "custom") {
      return {
        question: recoveryQuestionDraft.trim(),
        questionId: undefined
      };
    }
    const option = recoveryQuestionOptions[language].find((candidate) => candidate.id === recoveryQuestionChoice);
    return {
      question: option?.label || recoveryQuestionOptions[language][0].label,
      questionId: recoveryQuestionChoice
    };
  }

  async function saveSecuritySettings(event: React.FormEvent) {
    event.preventDefault();
    setSettingsError("");
    setSettingsMessage("");

    if (securityRecord) {
      if (!currentPasswordDraft) {
        setSettingsError(copy.currentPasswordMissing);
        return;
      }
      const currentHash = await hashSecret(currentPasswordDraft, securityRecord.passwordSalt);
      if (currentHash !== securityRecord.passwordHash) {
        setSettingsError(copy.currentPasswordFailed);
        return;
      }
      if (!securityEditUnlocked) {
        setSecurityEditUnlocked(true);
        setPasswordDraft("");
        setConfirmPasswordDraft("");
        setRecoveryAnswerDraft("");
        setSecurityRecoveryOpen(false);
        return;
      }
      if (!passwordDraft.trim() && !securityRecoveryOpen) {
        setSettingsError(copy.noSecurityChanges);
        return;
      }
      if (passwordDraft.trim() && passwordDraft !== confirmPasswordDraft) {
        setSettingsError(copy.passwordMismatch);
        return;
      }
      const recovery = selectedRecoveryQuestion();
      if (securityRecoveryOpen && (!recovery.question || !recoveryAnswerDraft.trim())) {
        setSettingsError(copy.securityMissing);
        return;
      }
      const nextRecord: SecurityRecord = {
        ...securityRecord,
        updatedAt: new Date().toISOString()
      };
      if (passwordDraft.trim()) {
        const passwordSalt = createSalt();
        nextRecord.passwordSalt = passwordSalt;
        nextRecord.passwordHash = await hashSecret(passwordDraft, passwordSalt);
      }
      if (securityRecoveryOpen) {
        const recoverySalt = createSalt();
        nextRecord.recoveryQuestion = recovery.question;
        nextRecord.recoveryQuestionId = recovery.questionId;
        nextRecord.recoverySalt = recoverySalt;
        nextRecord.recoveryHash = await hashSecret(recoveryAnswerDraft, recoverySalt);
      }
      window.localStorage.setItem("agentOpenClaw.security", JSON.stringify(nextRecord));
      setSecurityRecord(nextRecord);
      setCurrentPasswordDraft("");
      setPasswordDraft("");
      setConfirmPasswordDraft("");
      setRecoveryAnswerDraft("");
      setSecurityRecoveryOpen(false);
      setSecurityEditUnlocked(false);
      setSettingsMessage(copy.securityPasswordSaved);
      return;
    }

    if (passwordDraft || confirmPasswordDraft) {
      if (passwordDraft !== confirmPasswordDraft) {
        setSettingsError(copy.passwordMismatch);
        return;
      }
    }

    const recovery = selectedRecoveryQuestion();

    if (!passwordDraft || !recoveryAnswerDraft || !recovery.question) {
      setSettingsError(copy.securityMissing);
      return;
    }

    const passwordSalt = createSalt();
    const recoverySalt = createSalt();

    const nextRecord: SecurityRecord = {
      passwordSalt,
      passwordHash: await hashSecret(passwordDraft, passwordSalt),
      recoveryQuestion: recovery.question,
      recoveryQuestionId: recovery.questionId,
      recoverySalt,
      recoveryHash: await hashSecret(recoveryAnswerDraft, recoverySalt),
      updatedAt: new Date().toISOString()
    };

    window.localStorage.setItem("agentOpenClaw.security", JSON.stringify(nextRecord));
    setSecurityRecord(nextRecord);
    setPasswordDraft("");
    setConfirmPasswordDraft("");
    setRecoveryAnswerDraft("");
    setSettingsMessage(copy.securitySaved);
  }

  async function cancelSecurityPassword() {
    if (!securityRecord) return;
    setSettingsError("");
    setSettingsMessage("");
    if (!currentPasswordDraft) {
      setSettingsError(copy.currentPasswordMissing);
      return;
    }
    const currentHash = await hashSecret(currentPasswordDraft, securityRecord.passwordSalt);
    if (currentHash !== securityRecord.passwordHash) {
      setSettingsError(copy.currentPasswordFailed);
      return;
    }
    window.localStorage.removeItem("agentOpenClaw.security");
    window.sessionStorage.removeItem("agentOpenClaw.unlocked");
    setSecurityRecord(null);
    setCurrentPasswordDraft("");
    setPasswordDraft("");
    setConfirmPasswordDraft("");
    setRecoveryAnswerDraft("");
    setSecurityRecoveryOpen(false);
    setSecurityEditUnlocked(false);
    setSettingsMessage(copy.passwordCancelled);
  }

  function cancelSecurityEdit() {
    setSecurityEditUnlocked(false);
    setCurrentPasswordDraft("");
    setPasswordDraft("");
    setConfirmPasswordDraft("");
    setRecoveryAnswerDraft("");
    setSecurityRecoveryOpen(false);
    setSettingsError("");
    setSettingsMessage("");
  }

  function completeTour() {
    window.localStorage.setItem("honeycomb.tourCompleted", "true");
    setShowTour(false);
    if (!setupComplete) {
      setActiveView("setup");
    }
  }

  function updateWorkbenchConfig(updater: (current: SupervisorWorkbenchConfig) => SupervisorWorkbenchConfig) {
    setWorkbenchConfig((current) => {
      const next = {
        ...updater(current),
        updatedAt: new Date().toISOString()
      };
      saveSupervisorWorkbenchConfig(next);
      return next;
    });
    setWorkbenchMessage("");
  }

  function confirmWorkbenchConfigSaved() {
    saveSupervisorWorkbenchConfig({
      ...workbenchConfig,
      updatedAt: new Date().toISOString()
    });
    setWorkbenchMessage(copy.workbenchSaved);
  }

  function changePanelOutputStyle(style: PanelOutputStyle) {
    setPanelOutputStyle(style);
    window.localStorage.setItem("honeycomb.panelOutputStyle", style);
    setOutputStyleMessage(copy.outputStyleSaved);
    window.setTimeout(() => setOutputStyleMessage(""), 2400);
  }

  async function resumeSelectedJob() {
    if (!selectedJobId) return;
    let nextMaxCostUsd: number | undefined;
    if (selectedFromList?.spendBudget.blockingScope === "job") {
      nextMaxCostUsd = Number(maxCostUsdDraft);
      if (!Number.isFinite(nextMaxCostUsd) || nextMaxCostUsd <= selectedFromList.spendBudget.committedUsd) {
        setError(language === "zh" ? "新的任务费用上限必须高于当前已占用金额。" : "The new task limit must exceed the committed amount.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await resumeJob(selectedJobId, { maxCostUsd: nextMaxCostUsd });
      await refreshAll(selectedJobId);
    } catch (caught) {
      await refreshAll(selectedJobId).catch(() => undefined);
      setError(friendlyApiErrorMessage(caught, language));
    } finally {
      setBusy(false);
    }
  }

  async function reconcileSelectedModelCall(
    modelCallId: string,
    action: ModelCallReconciliationAction
  ) {
    if (!selectedJobId || reconciliationBusyId) return;
    setReconciliationBusyId(modelCallId);
    setReconciliationMessage("");
    setReconciliationError("");
    setError(null);
    try {
      const result = await reconcileJobUnknownOutcome(selectedJobId, modelCallId, action);
      if (result.canResume) {
        setReconciliationMessage(
          result.outcome?.status === "confirmed_succeeded"
            ? language === "zh"
              ? "已从服务商取回成功结果，现在可以安全恢复任务。"
              : "The successful provider result was recovered. The task can now resume safely."
            : language === "zh"
              ? "已确认服务商没有成功执行这次请求，现在可以安全恢复任务。"
              : "The provider did not complete this request. The task can now resume safely."
        );
      } else {
        setReconciliationMessage(
          result.outcome?.status === "provider_pending"
            ? language === "zh"
              ? "服务商仍在处理，任务会保持暂停；稍后再次核对即可。"
              : "The provider is still processing. The task remains paused; check again later."
            : language === "zh"
              ? "结果仍需核对，任务会保持暂停且不会重复发送。"
              : "The outcome still needs review. The task remains paused and will not be replayed."
        );
      }
      await refreshAll(selectedJobId);
    } catch (caught) {
      await refreshJob(selectedJobId).catch(() => undefined);
      setReconciliationError(friendlyApiErrorMessage(caught, language));
    } finally {
      setReconciliationBusyId("");
    }
  }

  async function confirmModelCallWasNotAccepted(modelCallId: string) {
    const reason = await requestTextInputDialog({
      title: language === "zh" ? "确认服务商未执行" : "Confirm request was not executed",
      label: language === "zh"
        ? "请填写你在服务商控制台看到的依据。确认错误可能造成重复生成或重复扣费。"
        : "Enter what you verified in the provider console. An incorrect confirmation can cause duplicate work or charges.",
      placeholder: language === "zh" ? "例如：请求记录中未找到该编号" : "For example: request ID was not found",
      confirmLabel: language === "zh" ? "确认可重试" : "Confirm safe to retry"
    });
    if (!reason?.trim()) return;
    await reconcileSelectedModelCall(modelCallId, {
      action: "confirm_not_accepted",
      reason: reason.trim()
    });
  }

  function scrollConversationToBottom(behavior: ScrollBehavior = "auto") {
    const body = conversationBodyRef.current;
    if (!body) return;
    body.scrollTo({
      top: body.scrollHeight,
      behavior
    });
  }

  function persistConversationState(nextState: ConversationWorkspaceState) {
    const normalized = normalizeConversationWorkspaceState(nextState);
    saveConversationWorkspaceState(normalized);
    setConversationState(normalized);
    return normalized;
  }

  function requestTextInputDialog(input: {
    title: string;
    label?: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }) {
    textInputDialogResolver.current?.(null);
    return new Promise<string | null>((resolve) => {
      textInputDialogResolver.current = resolve;
      setTextInputDialog({
        title: input.title,
        label: input.label ?? input.title,
        value: input.initialValue ?? "",
        placeholder: input.placeholder,
        confirmLabel: input.confirmLabel ?? (language === "zh" ? "\u786e\u5b9a" : "Confirm"),
        cancelLabel: input.cancelLabel ?? (language === "zh" ? "\u53d6\u6d88" : "Cancel")
      });
    });
  }

  function resolveTextInputDialog(value: string | null) {
    textInputDialogResolver.current?.(value);
    textInputDialogResolver.current = null;
    setTextInputDialog(null);
  }

  function projectNameFromPath(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return language === "zh" ? "\u672a\u547d\u540d\u9879\u76ee" : "Untitled project";
    return nameFromLocalPath(trimmed);
  }

  function syncActiveWorkspace(path: string) {
    updateWorkbenchConfig((current) => ({ ...current, workspacePath: path }));
  }

  function syncPromptFromConversationState(state: ConversationWorkspaceState) {
    setPrompt(activeConversationDraft(state));
  }

  function currentThreadFromState(state = conversationState) {
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
    const thread = project?.threads.find((candidate) => candidate.id === state.activeThreadId && !candidate.archivedAt);
    return { project, thread };
  }

  function appendMessagesToConversationState(
    state: ConversationWorkspaceState,
    projectId: string,
    threadId: string,
    messages: ConversationMessage[]
  ) {
    if (!messages.length) return state;
    const updatedAt = messages.at(-1)?.createdAt ?? new Date().toISOString();
    return persistConversationState({
      ...state,
      projects: state.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              updatedAt,
              threads: project.threads.map((thread) =>
                thread.id === threadId
                  ? { ...thread, messages: [...(thread.messages ?? []), ...messages], updatedAt }
                  : thread
              )
            }
          : project
      )
    });
  }

  async function pickDirectoryPath() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await invoke<string | null>("pick_directory");
      if (typeof selected === "string" && selected.trim()) return selected.trim();
    } catch {
      const fallback = await requestTextInputDialog({
        title: language === "zh" ? "\u9009\u62e9\u9879\u76ee\u6587\u4ef6\u5939" : "Choose project folder",
        label: language === "zh" ? "\u9879\u76ee\u6587\u4ef6\u5939\u8def\u5f84" : "Project folder path",
        initialValue: workbenchConfig.workspacePath,
        placeholder: "D:\\honeycomb"
      });
      return fallback?.trim() || null;
    }
    return null;
  }

  function selectConversationProject(projectId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    const visibleThreads = visibleConversationThreads(project);
    const thread = visibleThreads[0] ?? createConversationThread(language === "zh" ? "\u65b0\u5bf9\u8bdd" : "New conversation");
    const nextState = persistConversationState({
      ...conversationState,
      projects: visibleThreads.length
        ? conversationState.projects
        : conversationState.projects.map((candidate) =>
            candidate.id === project.id ? { ...candidate, threads: [thread] } : candidate
          ),
      activeProjectId: project.id,
      activeThreadId: thread.id
    });
    syncPromptFromConversationState(nextState);
    setError(null);
    setProjectMenuOpen(false);
    setOpenProjectMenuId("");
    setConversationContextMenu(null);
    syncActiveWorkspace(project.path);
  }

  function selectConversationThread(projectId: string, threadId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    const thread = project?.threads.find((candidate) => candidate.id === threadId);
    if (!project || !thread || thread.archivedAt) return;
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              threads: candidate.threads.map((item) =>
                item.id === thread.id ? { ...item, unread: false } : item
              )
            }
          : candidate
      ),
      activeProjectId: project.id,
      activeThreadId: thread.id
    });
    syncPromptFromConversationState(nextState);
    setError(null);
    setProjectMenuOpen(false);
    setOpenProjectMenuId("");
    setConversationContextMenu(null);
    syncActiveWorkspace(project.path);
  }

  async function createBlankConversationProject() {
    const path = await pickDirectoryPath();
    if (!path) return;
    const index = conversationState.projects.length + 1;
    const project = createConversationProject(projectNameFromPath(path) || (language === "zh" ? `\u9879\u76ee ${index}` : `Project ${index}`), path);
    const nextState = persistConversationState({
      projects: [...conversationState.projects, project],
      activeProjectId: project.id,
      activeThreadId: project.threads[0]?.id ?? ""
    });
    syncPromptFromConversationState(nextState);
    setProjectMenuOpen(false);
    setOpenProjectMenuId("");
    syncActiveWorkspace(path);
  }

  function createConversationThreadForActiveProject() {
    const activeProject = conversationState.projects.find((project) => project.id === conversationState.activeProjectId);
    if (!activeProject) return;
    createConversationThreadForProject(activeProject.id);
  }

  function createConversationThreadForProject(projectId: string) {
    const activeProject = conversationState.projects.find((project) => project.id === projectId);
    if (!activeProject || activeProject.archivedAt) return;
    const thread = createConversationThread(language === "zh" ? "\u65b0\u5bf9\u8bdd" : "New conversation");
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === activeProject.id
          ? { ...project, threads: [thread, ...project.threads], updatedAt: thread.updatedAt }
          : project
      ),
      activeProjectId: activeProject.id,
      activeThreadId: thread.id
    });
    syncPromptFromConversationState(nextState);
    setError(null);
    setProjectMenuOpen(false);
    setOpenProjectMenuId("");
    setConversationContextMenu(null);
    syncActiveWorkspace(activeProject.path);
  }

  function toggleActiveConversationPinned() {
    const { project, thread } = currentThreadFromState();
    if (!project || !thread) return;
    toggleConversationPinned(project.id, thread.id);
  }

  function toggleConversationPinned(projectId: string, threadId: string) {
    const updatedAt = new Date().toISOString();
    persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              updatedAt,
              threads: project.threads.map((thread) =>
                thread.id === threadId
                  ? { ...thread, pinned: !thread.pinned, updatedAt }
                  : thread
              )
            }
          : project
      )
    });
    setConversationContextMenu(null);
  }

  async function renameConversation(projectId: string, threadId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    const thread = project?.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    setConversationContextMenu(null);
    setOpenProjectMenuId("");
    const nextTitle = (await requestTextInputDialog({
      title: language === "zh" ? "\u91cd\u547d\u540d\u5bf9\u8bdd" : "Rename conversation",
      label: language === "zh" ? "\u5bf9\u8bdd\u540d\u79f0" : "Conversation name",
      initialValue: thread.title
    }))?.trim();
    if (!nextTitle) return;
    const updatedAt = new Date().toISOString();
    persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((candidate) =>
        candidate.id === projectId
          ? {
              ...candidate,
              updatedAt,
              threads: candidate.threads.map((item) =>
                item.id === threadId ? { ...item, title: nextTitle, updatedAt } : item
              )
            }
          : candidate
      )
    });
    setConversationContextMenu(null);
  }

  function markConversationUnread(projectId: string, threadId: string) {
    persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              threads: project.threads.map((thread) =>
                thread.id === threadId ? { ...thread, unread: true } : thread
              )
            }
          : project
      )
    });
    setConversationContextMenu(null);
  }

  function archiveConversation(projectId: string, threadId: string) {
    const archivedAt = new Date().toISOString();
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              updatedAt: archivedAt,
              threads: project.threads.map((thread) =>
                thread.id === threadId ? { ...thread, pinned: false, unread: false, archivedAt, updatedAt: archivedAt } : thread
              )
            }
          : project
      )
    });
    syncPromptFromConversationState(nextState);
    setConversationContextMenu(null);
  }

  function restoreConversation(projectId: string, threadId: string) {
    const updatedAt = new Date().toISOString();
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              archivedAt: undefined,
              updatedAt,
              threads: project.threads.map((thread) =>
                thread.id === threadId ? { ...thread, archivedAt: undefined, updatedAt } : thread
              )
            }
          : project
      ),
      activeProjectId: projectId,
      activeThreadId: threadId
    });
    syncPromptFromConversationState(nextState);
  }

  function requestDeleteConversation(projectId: string, threadId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    const thread = project?.threads.find((candidate) => candidate.id === threadId);
    if (!project || !thread) return;
    setArchiveDeleteTarget({
      kind: "conversation",
      projectId,
      threadId,
      title: thread.title,
      subtitle: project.path || project.name
    });
  }

  async function deleteConversationPermanently(projectId: string, threadId: string) {
    if (apiState !== "online") {
      setError(language === "zh" ? "后端离线，暂时不能永久删除对话。" : "The backend is offline, so this conversation cannot be permanently deleted yet.");
      return false;
    }
    try {
      await deleteBackendConversation(threadId);
    } catch (caught) {
      setError(friendlyApiErrorMessage(caught, language));
      return false;
    }
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId
          ? { ...project, threads: project.threads.filter((thread) => thread.id !== threadId) }
          : project
      )
    });
    syncPromptFromConversationState(nextState);
    return true;
  }

  function toggleProjectPinned(projectId: string) {
    persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId ? { ...project, pinned: !project.pinned, updatedAt: new Date().toISOString() } : project
      )
    });
    setOpenProjectMenuId("");
    setConversationContextMenu(null);
  }

  async function renameProject(projectId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    setConversationContextMenu(null);
    setOpenProjectMenuId("");
    const nextName = (await requestTextInputDialog({
      title: language === "zh" ? "\u91cd\u547d\u540d\u9879\u76ee" : "Rename project",
      label: language === "zh" ? "\u9879\u76ee\u540d\u79f0" : "Project name",
      initialValue: project.name
    }))?.trim();
    if (!nextName) return;
    persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((candidate) =>
        candidate.id === projectId ? { ...candidate, name: nextName, updatedAt: new Date().toISOString() } : candidate
      )
    });
    setOpenProjectMenuId("");
    setConversationContextMenu(null);
  }

  function archiveProject(projectId: string) {
    const archivedAt = new Date().toISOString();
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId ? { ...project, pinned: false, archivedAt, updatedAt: archivedAt } : project
      )
    });
    syncPromptFromConversationState(nextState);
    setOpenProjectMenuId("");
    setConversationContextMenu(null);
  }

  function restoreProject(projectId: string) {
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((project) =>
        project.id === projectId ? { ...project, archivedAt: undefined, updatedAt: new Date().toISOString() } : project
      ),
      activeProjectId: projectId
    });
    syncPromptFromConversationState(nextState);
  }

  function requestDeleteProject(projectId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    setArchiveDeleteTarget({
      kind: "project",
      projectId,
      title: project.name,
      subtitle: language === "zh"
        ? [project.path, `${project.threads.length} \u4e2a\u5bf9\u8bdd`].filter(Boolean).join(" / ")
        : [project.path, `${project.threads.length} ${project.threads.length === 1 ? "conversation" : "conversations"}`].filter(Boolean).join(" / "),
      archived: Boolean(project.archivedAt)
    });
    setOpenProjectMenuId("");
    setConversationContextMenu(null);
  }

  async function deleteProjectPermanently(projectId: string) {
    if (apiState !== "online") {
      setError(language === "zh" ? "后端离线，暂时不能永久删除项目。" : "The backend is offline, so this project cannot be permanently deleted yet.");
      return false;
    }
    try {
      await deleteBackendConversationProject(projectId);
    } catch (caught) {
      setError(friendlyApiErrorMessage(caught, language));
      return false;
    }
    const nextState = persistConversationState({
      ...conversationState,
      projects: conversationState.projects.filter((project) => project.id !== projectId)
    });
    syncPromptFromConversationState(nextState);
    setOpenProjectMenuId("");
    return true;
  }

  async function confirmArchiveDelete() {
    if (!archiveDeleteTarget) return;
    let deleted = false;
    if (archiveDeleteTarget.kind === "conversation") {
      deleted = await deleteConversationPermanently(archiveDeleteTarget.projectId, archiveDeleteTarget.threadId);
    } else {
      deleted = await deleteProjectPermanently(archiveDeleteTarget.projectId);
    }
    if (deleted) setArchiveDeleteTarget(null);
  }

  async function openProjectInExplorer(projectId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    const path = project?.path.trim();
    if (!path) {
      setError(language === "zh" ? "\u8fd9\u4e2a\u9879\u76ee\u8fd8\u6ca1\u6709\u6587\u4ef6\u5939\u8def\u5f84\u3002" : "This project does not have a folder path yet.");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_file_explorer", { path });
    } catch {
      await navigator.clipboard?.writeText(path);
      setError(language === "zh" ? "\u5df2\u590d\u5236\u6587\u4ef6\u5939\u8def\u5f84\uff0c\u5f53\u524d\u73af\u5883\u65e0\u6cd5\u76f4\u63a5\u6253\u5f00\u8d44\u6e90\u7ba1\u7406\u5668\u3002" : "Folder path copied. This environment could not open the file explorer directly.");
    } finally {
      setOpenProjectMenuId("");
      setConversationContextMenu(null);
    }
  }

  async function copyProjectPath(projectId: string) {
    const project = conversationState.projects.find((candidate) => candidate.id === projectId);
    const path = project?.path.trim();
    if (!path) return;
    await navigator.clipboard?.writeText(path);
    setConversationContextMenu(null);
    setOpenProjectMenuId("");
  }

  function attachPathsToActiveConversation(paths: string[]) {
    const cleaned = paths.map((path) => path.trim()).filter(Boolean);
    if (!cleaned.length) return;
    const { project, thread } = currentThreadFromState();
    if (!project || !thread) return;
    const updatedAt = new Date().toISOString();
    persistConversationState({
      ...conversationState,
      projects: conversationState.projects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              updatedAt,
              threads: candidate.threads.map((item) =>
                item.id === thread.id
                  ? {
                      ...item,
                      updatedAt,
                      attachments: [...(item.attachments ?? []), ...cleaned.map(createConversationAttachment)]
                    }
                  : item
              )
            }
          : candidate
      )
    });
  }

  async function openAttachmentPicker() {
    setAttachmentMenuOpen(false);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const paths = await invoke<string[]>("pick_files");
      if (paths.length) {
        attachPathsToActiveConversation(paths.map(String));
        return;
      }
    } catch {
      attachmentInputRef.current?.click();
    }
  }

  function handleAttachmentInput(files: FileList | null) {
    if (!files?.length) return;
    attachPathsToActiveConversation(Array.from(files).map((file) => file.name));
  }

  function updateActiveConversationDraft(nextPrompt: string) {
    setPrompt(nextPrompt);
    setConversationState((current) => {
      const updatedAt = new Date().toISOString();
      const normalized = normalizeConversationWorkspaceState({
        ...current,
        projects: current.projects.map((project) =>
          project.id === current.activeProjectId
            ? {
                ...project,
                updatedAt,
                threads: project.threads.map((thread) =>
                  thread.id === current.activeThreadId
                    ? {
                        ...thread,
                        draft: nextPrompt,
                        title: nextPrompt.trim() ? nextPrompt.trim().slice(0, 64) : thread.title,
                        updatedAt
                      }
                    : thread
                )
              }
            : project
        )
      });
      saveConversationWorkspaceState(normalized);
      return normalized;
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function checkOpenClawStatus() {
      try {
        await getHealth();
        if (!cancelled) {
          setApiState("online");
        }
      } catch {
        if (!cancelled) {
          setApiState("offline");
        }
      }
    }

    void checkOpenClawStatus();
    const interval = window.setInterval(() => {
      void checkOpenClawStatus();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (apiState !== "online") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const submittedState = conversationState;
      void syncConversationWorkspace(conversationWorkspaceSnapshotFromState(submittedState))
        .then((result) => {
          if (cancelled) return;
          const nextState = conversationWorkspaceStateFromSnapshot(result.snapshot, submittedState);
          if (JSON.stringify(nextState) === JSON.stringify(submittedState)) return;
          saveConversationWorkspaceState(nextState);
          setConversationState(nextState);
          setPrompt(activeConversationDraft(nextState));
        })
        .catch(() => {
          // Local state remains available and will be retried after the next state or API change.
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiState, conversationState]);

  useEffect(() => {
    if (apiState !== "online") return;
    let cancelled = false;

    async function pollOpenClawData() {
      try {
        await refreshAll(selectedJobId);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    }

    void pollOpenClawData();
    const interval = window.setInterval(() => {
      void pollOpenClawData();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiState, selectedJobId, jobStatusFilter, jobTimeFilter, customSince, customUntil, trimmedJobPromptFilter]);

  useEffect(() => {
    if (apiState !== "online" || !setupComplete) return;
    let cancelled = false;

    async function pollJobNotifications() {
      try {
        const response = await listJobs({
          limit: 50,
          sort: "updatedAt",
          order: "desc"
        });
        if (cancelled) {
          return;
        }
        for (const job of response.jobs) {
          if (!isNewForDesktopNotification(job.updatedAt, notificationStartedAt.current)) {
            continue;
          }
          const payload = jobDesktopNotification(job, language);
          if (payload) {
            notifyOnce(payload);
          }
        }
      } catch {
        // Job notifications are best-effort; the jobs page still owns UI errors.
      }
    }

    void pollJobNotifications();
    const interval = window.setInterval(() => {
      void pollJobNotifications();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiState, language, setupComplete]);

  useEffect(() => {
    setReconciliationMessage("");
    setReconciliationError("");
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedJobId || apiState !== "online") return;
    refreshJob(selectedJobId).catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught))
    );
  }, [selectedJobId, apiState]);

  useEffect(() => {
    if (apiState !== "online") return;
    refreshAll("").catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [jobStatusFilter, jobTimeFilter, customSince, customUntil, trimmedJobPromptFilter, apiState]);

  useEffect(() => {
    if (activeView !== "memory" || apiState !== "online") return;
    setMemoryError("");
    refreshExperiences().catch((caught) =>
      setMemoryError(caught instanceof Error ? caught.message : String(caught))
    );
  }, [activeView, apiState, experienceFilter]);

  useEffect(() => {
    if (apiState !== "online" || !setupComplete) return;
    let cancelled = false;

    async function pollPendingApprovalNotifications() {
      try {
        const response = await listToolApprovals({ status: "pending", limit: 100 });
        if (cancelled) {
          return;
        }
        for (const approval of response.approvals) {
          if (!isNewForDesktopNotification(approval.createdAt, notificationStartedAt.current)) {
            continue;
          }
          notifyOnce(approvalDesktopNotification(approval, language));
        }
      } catch {
        // Approval notifications are best-effort; the approvals page still owns UI errors.
      }
    }

    void pollPendingApprovalNotifications();
    const interval = window.setInterval(() => {
      void pollPendingApprovalNotifications();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiState, language, setupComplete]);

  useEffect(() => {
    if (activeView !== "approvals" || apiState !== "online") return;
    let cancelled = false;

    async function loadApprovals() {
      try {
        const response = await listToolApprovals({ status: "pending", limit: 100 });
        if (!cancelled) {
          setApprovals(response.approvals);
          setApprovalError("");
        }
      } catch (caught) {
        if (!cancelled) {
          setApprovalError(caught instanceof Error ? caught.message : copy.approvalLoadFailed);
        }
      }
    }

    void loadApprovals();
    const interval = window.setInterval(() => {
      void loadApprovals();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeView, apiState, copy.approvalLoadFailed]);

  useEffect(() => {
    if (activeView !== "dashboard" || apiState !== "online") return;
    refreshRuntimeRepairPanel().catch((caught) =>
      setRuntimeRepairError(caught instanceof Error ? caught.message : copy.workbenchRepairUnavailable)
    );
  }, [activeView, apiState]);

  if (locked && securityRecord) {
    const canRecover = hasRecoveryQuestion(securityRecord);
    return (
      <main className="lockScreen">
        <form className="lockPanel" onSubmit={unlockMode === "password" ? unlockWithPassword : unlockWithRecovery}>
          <div className="lockMark">
            <LockKeyhole size={32} aria-hidden="true" />
          </div>
          <h1>{copy.lockTitle}</h1>
          <p>{unlockMode === "password" ? copy.lockSubtitle : recoveryQuestionLabel(securityRecord, language)}</p>
          {unlockMode === "password" ? (
            <label>
              {copy.password}
              <input
                type="password"
                value={unlockPassword}
                onChange={(event) => setUnlockPassword(event.target.value)}
                autoFocus
              />
            </label>
          ) : (
            <label>
              {copy.recoveryAnswer}
              <input
                type="password"
                value={unlockRecoveryAnswer}
                onChange={(event) => setUnlockRecoveryAnswer(event.target.value)}
                autoFocus
              />
            </label>
          )}
          {unlockError ? <p className="error">{unlockError}</p> : null}
          <button className="primaryButton" type="submit">
            <KeyRound size={16} aria-hidden="true" />
            {copy.unlock}
          </button>
          {canRecover ? (
            <button
              className="textButton"
              type="button"
              onClick={() => {
                setUnlockError("");
                setUnlockMode(unlockMode === "password" ? "recovery" : "password");
              }}
            >
              {unlockMode === "password" ? copy.forgotPassword : copy.usePassword}
            </button>
          ) : null}
        </form>
      </main>
    );
  }

  function renderDashboard() {
    return (
      <section className="deskPage dashboardPage" data-tour-anchor="dashboard">
        <div className="pageHero">
          <div>
            <p className="eyebrow">
              <span className={`miniDot ${apiState}`} />
              {statusText}
            </p>
            <h1>{copy.dashboard}</h1>
            <p>{copy.subtitle}</p>
          </div>
          <div className="heroActions">
            <button className="secondaryButton" type="button" onClick={() => setActiveView("conversations")}>
              <MessageSquare size={16} aria-hidden="true" />
              {copy.openConversations}
            </button>
          </div>
        </div>

        <div className="overviewGrid">
          <article className="metricPanel">
            <span>{copy.gatewayPanel}</span>
            <strong>{statusText}</strong>
            <small>http://localhost:3000</small>
          </article>
          <article className="metricPanel">
            <span>{copy.totalJobs}</span>
            <strong>{jobs.length}</strong>
            <small>{copy.jobs}</small>
          </article>
          <article className="metricPanel">
            <span>{copy.runningJobs}</span>
            <strong>{runningJobCount}</strong>
            <small>{copy.statusFilters.running}</small>
          </article>
          <article className="metricPanel">
            <span>{copy.currentModel}</span>
            <strong>{firstRunPreview?.provider?.model || copy.unconfigured}</strong>
            <small>{firstRunPreview?.provider?.providerName || copy.unconfigured}</small>
          </article>
        </div>

        <div className="dashboardContent">
          <section className="deskPanel">
            <div className="panelHeader">
              <h2>{copy.latestJob}</h2>
              <button className="iconTextButton" type="button" onClick={() => setActiveView("jobs")}>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
            {latestJob ? (
              <button className="latestJobButton" type="button" onClick={() => {
                setSelectedJobId(latestJob.id);
                setActiveView("jobs");
              }}>
                <span className={`dot ${statusTone(latestJob.status)}`} />
                <span>
                  <strong>{jobDisplayTitle(latestJob)}</strong>
                  <small>{routingLabel(latestJob.routingMode)}</small>
                </span>
                <em>{copy.statuses[latestJob.status]}</em>
              </button>
            ) : (
              <p className="emptyState">{copy.noLatestJob}</p>
            )}
          </section>

          <section className="deskPanel">
            <div className="panelHeader">
              <h2>{copy.gatewayPanel}</h2>
              <RefreshCw size={16} aria-hidden="true" />
            </div>
            <div className="systemRows">
              <div>
                <span>{copy.gatewayHint}</span>
                <strong>localhost:3000</strong>
              </div>
              <div>
                <span>{copy.modelHint}</span>
                <strong>{configuredProvider}</strong>
              </div>
              <div>
                <span>{copy.agentHint}</span>
                <strong>{agentSequenceLabel("main / research / writer / image / test")}</strong>
              </div>
            </div>
          </section>
        </div>

        <section className="deskPanel capabilityPanel">
          <div className="panelHeader">
            <div>
              <h2>{copy.capabilityTitle}</h2>
              <p className="mutedText">{copy.capabilityIntro}</p>
            </div>
            <Sparkles size={17} aria-hidden="true" />
          </div>
          <div className="supervisorWorkbenchGrid">
            <article className="workbenchCard runtimeCard">
              <span className="workbenchStatusPill">{copy.workbenchLive}</span>
              <strong>{copy.workbenchRuntime}</strong>
              <div className="workbenchRows">
                <div>
                  <span>{copy.gatewayPanel}</span>
                  <em>{statusText}</em>
                </div>
                <div>
                  <span>{copy.modelHint}</span>
                  <em>{configuredProvider}</em>
                </div>
                <div>
                  <span>{copy.agentHint}</span>
                  <em>{panelSupervisorDisplayName}</em>
                </div>
              </div>
            </article>

            <article className="workbenchCard repairCard" data-testid="runtime-repair-card">
              <span className={`workbenchStatusPill repairStatus ${diagnosticTone(runtimeDiagnostics?.status)}`}>
                {copy.workbenchRepair}
              </span>
              <strong>{copy.workbenchRepairTitle}</strong>
              <p className="workbenchMuted">{copy.workbenchRepairIntro}</p>
              <div className="runtimeRepairSummary">
                <div>
                  <span>{copy.workbenchRepairStatus}</span>
                  <em>{runtimeDiagnosticStatusLabel(runtimeDiagnostics?.status, language)}</em>
                </div>
                <div>
                  <span>{copy.workbenchRepairCheckedAt}</span>
                  <em>{runtimeDiagnostics ? formatTime(runtimeDiagnostics.checkedAt, language) : "-"}</em>
                </div>
              </div>
              {runtimeRepairMessage ? <p className="successMessage compactMessage">{runtimeRepairMessage}</p> : null}
              {runtimeRepairError ? <p className="error compactMessage">{runtimeRepairError}</p> : null}
              <div className="runtimeRepairActions" aria-label={copy.workbenchRepairActions}>
                <button
                  className="repairActionButton refreshRepairButton"
                  data-testid="runtime-repair-refresh"
                  type="button"
                  onClick={() => refreshRuntimeRepairPanel()}
                  disabled={apiState !== "online" || Boolean(runtimeRepairBusy)}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>{runtimeRepairBusy === "refresh" ? copy.workbenchRepairLoading : copy.workbenchRepairRefresh}</span>
                </button>
                {runtimeRepairActions.length ? (
                  runtimeRepairActions.map((action) => {
                    const label = runtimeRepairActionCopy(action, language);
                    const running = runtimeRepairBusy === action.id;
                    return (
                      <button
                        className={`repairActionButton risk-${action.riskLevel}`}
                        data-testid={`runtime-repair-action-${action.id}`}
                        key={action.id}
                        type="button"
                        title={label.description}
                        onClick={() => runRepairFromWorkbench(action)}
                        disabled={apiState !== "online" || Boolean(runtimeRepairBusy)}
                      >
                        <Play size={13} aria-hidden="true" />
                        <span>
                          <strong>{running ? copy.workbenchRepairRunning : label.title}</strong>
                          <small>{label.description}</small>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <p className="emptyState compactEmpty">{runtimeRepairBusy === "refresh" ? copy.workbenchRepairLoading : copy.workbenchRepairNoActions}</p>
                )}
              </div>
            </article>

            <article className="workbenchCard streamCard">
              <span className="workbenchStatusPill">{copy.workbenchLive}</span>
              <strong>{copy.workbenchStreaming}</strong>
              <div className="streamSnapshot">
                <div>
                  <span>{copy.workbenchLatestJob}</span>
                  <em>{workbenchJob ? jobDisplayTitle(workbenchJob) : copy.workbenchNoJob}</em>
                </div>
                <div>
                  <span>{copy.status}</span>
                  <em>{workbenchJob ? copy.statuses[workbenchJob.status] : "-"}</em>
                </div>
                <div>
                  <span>{copy.workbenchTimelineItems}</span>
                  <em>{timeline?.summary.totalTimelineItems ?? 0}</em>
                </div>
              </div>
              <button className="secondaryButton compactButton" type="button" onClick={() => setActiveView("jobs")}>
                <ChevronRight size={14} aria-hidden="true" />
                {copy.openJobs}
              </button>
            </article>

            <article className="workbenchCard planCard">
              <span className="workbenchStatusPill">{copy.workbenchLocal}</span>
              <strong>{copy.workbenchPlan}</strong>
              <ol className="workbenchPlanList">
                {workbenchPlanSteps.map((step) => (
                  <li className={`planStep ${step.state}`} key={step.title}>
                    <span />
                    <div>
                      <strong>{step.title}</strong>
                      <p>{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </article>

            <article className="workbenchCard configCard">
              <span className="workbenchStatusPill">{copy.workbenchStored}</span>
              <strong>{copy.workbenchWorkspace}</strong>
              <label>
                {copy.workbenchWorkspaceLabel}
                <input
                  value={workbenchConfig.workspacePath}
                  placeholder={copy.workbenchWorkspacePlaceholder}
                  onChange={(event) => updateWorkbenchConfig((current) => ({ ...current, workspacePath: event.target.value }))}
                />
              </label>
              <button className="secondaryButton compactButton" type="button" onClick={confirmWorkbenchConfigSaved}>
                <CheckCircle2 size={14} aria-hidden="true" />
                {copy.workbenchSave}
              </button>
            </article>

            <article className="workbenchCard permissionCard">
              <span className="workbenchStatusPill">{enabledPermissionCount}/{supervisorPermissionKeys.length}</span>
              <strong>{copy.workbenchPermissions}</strong>
              <div className="permissionToggleGrid">
                {supervisorPermissionKeys.map((key) => (
                  <label className="permissionToggle" key={key}>
                    <input
                      type="checkbox"
                      checked={workbenchConfig.permissions[key]}
                      onChange={(event) =>
                        updateWorkbenchConfig((current) => ({
                          ...current,
                          permissions: {
                            ...current.permissions,
                            [key]: event.target.checked
                          }
                        }))
                      }
                    />
                    <span>{copy.workbenchPermissionLabels[key]}</span>
                  </label>
                ))}
              </div>
            </article>

            <article className="workbenchCard toolsCard">
              <span className="workbenchStatusPill">{copy.workbenchStored}</span>
              <strong>{copy.workbenchSkills}</strong>
              <div className="workbenchTextareas">
                <label>
                  {copy.workbenchSkillsLabel}
                  <textarea
                    value={workbenchConfig.skills}
                    placeholder={copy.workbenchSkillsPlaceholder}
                    onChange={(event) => updateWorkbenchConfig((current) => ({ ...current, skills: event.target.value }))}
                  />
                </label>
                <label>
                  {copy.workbenchMcpLabel}
                  <textarea
                    value={workbenchConfig.mcpServers}
                    placeholder={copy.workbenchMcpPlaceholder}
                    onChange={(event) => updateWorkbenchConfig((current) => ({ ...current, mcpServers: event.target.value }))}
                  />
                </label>
              </div>
              <button className="secondaryButton compactButton" type="button" onClick={confirmWorkbenchConfigSaved}>
                <CheckCircle2 size={14} aria-hidden="true" />
                {copy.workbenchSave}
              </button>
            </article>
          </div>
          {workbenchMessage ? <p className="successMessage">{workbenchMessage}</p> : null}
        </section>
      </section>
    );
  }

  function renderApprovals() {
    return (
      <section className="deskPage approvalsPage">
        <section className="pageHero compactHero">
          <div>
            <p className="eyebrow">
              <ShieldQuestion size={15} aria-hidden="true" />
              {copy.pendingApprovals}
            </p>
            <h1>{copy.approvalQueueTitle}</h1>
            <p>{copy.approvalQueueHint}</p>
          </div>
          <div className="heroActions">
            <span className={`status ${apiState}`}>{statusText}</span>
            <button
              className="secondaryButton compactButton"
              type="button"
              onClick={() => refreshApprovals().catch((caught) => setApprovalError(caught instanceof Error ? caught.message : copy.approvalLoadFailed))}
              disabled={apiState !== "online" || approvalBusy}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {copy.refresh}
            </button>
          </div>
        </section>

        {approvalMessage ? <p className="successMessage">{approvalMessage}</p> : null}
        {approvalError ? <p className="error">{approvalError}</p> : null}

        <section className="approvalQueue">
          {approvals.length ? (
            approvals.map((approval) => {
              const inputJson = compactJson(approval.input);
              const policyJson = compactJson(approval.policy);
              return (
                <article className="approvalCard" key={approval.id}>
                  <div className="approvalCardHeader">
                    <div>
                      <strong>{approval.toolName}</strong>
                      <span>{approval.id}</span>
                    </div>
                    <em className={`riskPill ${riskTone(approval.riskLevel)}`}>
                      {copy.approvalRisk}: {approval.riskLevel}
                    </em>
                  </div>

                  <dl className="approvalDetails">
                    <div>
                      <dt>{copy.approvalAction}</dt>
                      <dd>{approval.actionType}</dd>
                    </div>
                    <div>
                      <dt>{copy.approvalTarget}</dt>
                      <dd>{approval.target || "-"}</dd>
                    </div>
                    <div>
                      <dt>{copy.approvalCommand}</dt>
                      <dd>{approval.command || "-"}</dd>
                    </div>
                    <div>
                      <dt>{copy.approvalRequestedBy}</dt>
                      <dd>{approval.agentId} / {approval.requesterActor}</dd>
                    </div>
                    <div className="wide">
                      <dt>{copy.approvalReason}</dt>
                      <dd>{approval.reason || "-"}</dd>
                    </div>
                  </dl>

                  {inputJson || policyJson ? (
                    <div className="approvalPayloads">
                      {inputJson ? (
                        <pre aria-label="approval input">{inputJson}</pre>
                      ) : null}
                      {policyJson ? (
                        <pre aria-label="approval policy">{policyJson}</pre>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="approvalActions">
                    <button
                      className="secondaryButton"
                      type="button"
                      disabled={approvalBusy}
                      onClick={() => decideApproval(approval.id, "reject")}
                    >
                      <X size={15} aria-hidden="true" />
                      {copy.reject}
                    </button>
                    <button
                      className="primaryButton"
                      type="button"
                      disabled={approvalBusy}
                      onClick={() => decideApproval(approval.id, "approve")}
                    >
                      <CheckCircle2 size={15} aria-hidden="true" />
                      {copy.approve}
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="deskPanel emptyApprovalPanel">
              <ShieldQuestion size={28} aria-hidden="true" />
              <p>{copy.noPendingApprovals}</p>
            </div>
          )}
        </section>
      </section>
    );
  }

  function renderConversations() {
    const conversationCopy = language === "zh"
      ? {
          pinned: "\u7f6e\u9876",
          pinnedTitle: "\u4ece\u73b0\u5728\u5f00\u59cb\uff0c\u4e4b\u540e\u7684\u6240\u6709\u4efb\u52a1\u2026",
          project: "\u9879\u76ee",
          collapse: "\u6298\u53e0",
          more: "\u66f4\u591a",
          addProject: "\u6dfb\u52a0\u9879\u76ee",
          newBlankProject: "\u65b0\u5efa\u7a7a\u767d\u9879\u76ee",
          newConversation: "\u65b0\u5efa\u5bf9\u8bdd",
          pinConversation: "\u7f6e\u9876\u5bf9\u8bdd",
          unpinConversation: "\u53d6\u6d88\u7f6e\u9876\u5bf9\u8bdd",
          renameConversation: "\u91cd\u547d\u540d\u5bf9\u8bdd",
          archiveConversation: "\u5f52\u6863\u5bf9\u8bdd",
          markUnread: "\u6807\u8bb0\u4e3a\u672a\u8bfb",
          openInExplorer: "\u5728\u8d44\u6e90\u7ba1\u7406\u5668\u4e2d\u6253\u5f00",
          copyWorkdir: "\u590d\u5236\u5de5\u4f5c\u76ee\u5f55",
          pinProject: "\u7f6e\u9876\u9879\u76ee",
          unpinProject: "\u53d6\u6d88\u7f6e\u9876\u9879\u76ee",
          renameProject: "\u91cd\u547d\u540d\u9879\u76ee",
          archiveProject: "\u5f52\u6863\u9879\u76ee",
          removeProject: "\u79fb\u9664",
          addPhotosAndFiles: "\u6dfb\u52a0\u7167\u7247\u548c\u6587\u4ef6",
          attachedFiles: "\u5df2\u6dfb\u52a0\u6587\u4ef6",
          projectUnset: "\u9009\u62e9\u9879\u76ee\u6587\u4ef6\u5939",
          activeConversation: "\u65b0\u5bf9\u8bdd",
          panelAgent: "\u9762\u677f Agent",
          assistantIntro: "\u9009\u597d\u9879\u76ee\u540e\uff0c\u76f4\u63a5\u5728\u4e0b\u65b9\u8f93\u5165\u4efb\u52a1\u3002\u6211\u4f1a\u628a\u9879\u76ee\u8def\u5f84\u3001\u6280\u80fd\u548c MCP \u4e0a\u4e0b\u6587\u4e00\u8d77\u4ea4\u7ed9 Agent \u56e2\u961f\u3002",
          inputPlaceholder: "\u8f93\u5165\u4efb\u52a1\u6216\u6d88\u606f...",
          send: "\u53d1\u9001",
          latestJob: "\u6700\u65b0\u4efb\u52a1"
        }
      : {
          pinned: "Pinned",
          pinnedTitle: "From now on, all later tasks...",
          project: "Projects",
          collapse: "Collapse",
          more: "More",
          addProject: "Add project",
          newBlankProject: "New blank project",
          newConversation: "New conversation",
          pinConversation: "Pin conversation",
          unpinConversation: "Unpin conversation",
          renameConversation: "Rename conversation",
          archiveConversation: "Archive conversation",
          markUnread: "Mark unread",
          openInExplorer: "Open in File Explorer",
          copyWorkdir: "Copy work directory",
          pinProject: "Pin project",
          unpinProject: "Unpin project",
          renameProject: "Rename project",
          archiveProject: "Archive project",
          removeProject: "Remove",
          addPhotosAndFiles: "Add photos and files",
          attachedFiles: "Attached files",
          projectUnset: "Choose project folder",
          activeConversation: "New conversation",
          panelAgent: "Panel agent",
          assistantIntro: "Pick a project, then type the task below. I will attach the project path, skills, and MCP context before handing it to the agent team.",
          inputPlaceholder: "Type a task or message...",
          send: "Send",
          latestJob: "Latest job"
        };
    const canStartJob = !busy && Boolean(prompt.trim());
    const activeProject = conversationState.projects.find((project) => project.id === conversationState.activeProjectId) ?? conversationState.projects[0];
    const activeThread = activeProject?.threads.find((thread) => thread.id === conversationState.activeThreadId) ?? activeProject?.threads[0];
    const activeProjectPath = activeProject?.path || workbenchConfig.workspacePath.trim();
    const conversationTitle = activeProject?.name || activeProjectPath || activeThread?.title || conversationCopy.activeConversation;
    const activeAttachments = activeThread?.attachments ?? [];
    const activeMessages = activeThread?.messages ?? [];
    const visibleProjects = visibleConversationProjects(conversationState.projects);
    const pinnedThreads = visibleProjects.flatMap((project) =>
      visibleConversationThreads(project).filter((thread) => thread.pinned).map((thread) => ({ project, thread }))
    );
    const contextProject = conversationContextMenu
      ? conversationState.projects.find((project) => project.id === conversationContextMenu.projectId)
      : null;
    const contextThread = conversationContextMenu?.kind === "thread"
      ? contextProject?.threads.find((thread) => thread.id === conversationContextMenu.threadId)
      : null;
    const renderThreadRow = (project: ConversationProject, thread: ConversationThread) => (
      <div
        className={[
          "codexThreadItem",
          thread.id === conversationState.activeThreadId ? "active" : "",
          thread.unread ? "unread" : ""
        ].filter(Boolean).join(" ")}
        key={thread.id}
        onContextMenu={(event) => {
          event.preventDefault();
          setConversationContextMenu({
            kind: "thread",
            projectId: project.id,
            threadId: thread.id,
            x: event.clientX,
            y: event.clientY
          });
        }}
      >
        <button className="codexThreadMain" type="button" onClick={() => selectConversationThread(project.id, thread.id)}>
          <span>{thread.title}</span>
          <small>{formatTime(thread.updatedAt, language)}</small>
        </button>
        <div className="codexThreadActions">
          <button
            type="button"
            title={thread.pinned ? conversationCopy.unpinConversation : conversationCopy.pinConversation}
            aria-label={thread.pinned ? conversationCopy.unpinConversation : conversationCopy.pinConversation}
            onClick={(event) => {
              event.stopPropagation();
              toggleConversationPinned(project.id, thread.id);
            }}
          >
            <Pin size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            title={conversationCopy.archiveConversation}
            aria-label={conversationCopy.archiveConversation}
            onClick={(event) => {
              event.stopPropagation();
              archiveConversation(project.id, thread.id);
            }}
          >
            <Archive size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
    const renderProjectMenu = (project: ConversationProject) => (
      <div className="codexProjectMenu projectRowMenu">
        <button type="button" onClick={() => toggleProjectPinned(project.id)}>
          <Pin size={15} aria-hidden="true" />
          {project.pinned ? conversationCopy.unpinProject : conversationCopy.pinProject}
        </button>
        <button type="button" onClick={() => void openProjectInExplorer(project.id)}>
          <FolderOpen size={15} aria-hidden="true" />
          {conversationCopy.openInExplorer}
        </button>
        <button type="button" onClick={() => void renameProject(project.id)}>
          <Pencil size={15} aria-hidden="true" />
          {conversationCopy.renameProject}
        </button>
        <button type="button" onClick={() => archiveProject(project.id)}>
          <Archive size={15} aria-hidden="true" />
          {conversationCopy.archiveProject}
        </button>
        <button type="button" onClick={() => requestDeleteProject(project.id)}>
          <Trash2 size={15} aria-hidden="true" />
          {conversationCopy.removeProject}
        </button>
      </div>
    );

    return (
      <section className="deskPage conversationsPage codexConversationsPage" data-tour-anchor="conversations" onClick={() => setConversationContextMenu(null)}>
        <aside className={pinnedThreads.length ? "codexProjectSidebar" : "codexProjectSidebar noPinned"}>
          {pinnedThreads.length ? (
            <section className="codexPinnedBlock">
              <p>{conversationCopy.pinned}</p>
              {pinnedThreads.map(({ project, thread }) => renderThreadRow(project, thread))}
            </section>
          ) : null}

          <section className="codexProjectBlock">
            <div className="codexProjectToolbar">
              <button className="codexProjectTitle" type="button" onClick={() => setProjectListCollapsed((collapsed) => !collapsed)}>
                {conversationCopy.project}
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              <div className="codexProjectActions">
                <button
                  type="button"
                  title={conversationCopy.collapse}
                  aria-label={conversationCopy.collapse}
                  onClick={() => setProjectListCollapsed((collapsed) => !collapsed)}
                >
                  {projectListCollapsed ? <PanelLeftOpen size={14} aria-hidden="true" /> : <PanelLeftClose size={14} aria-hidden="true" />}
                </button>
                <div className="codexProjectOverflow">
                  <button
                    className={activeProject && openProjectMenuId === activeProject.id ? "active" : ""}
                    type="button"
                    title={conversationCopy.more}
                    aria-label={conversationCopy.more}
                    onClick={() => {
                      if (activeProject) setOpenProjectMenuId((current) => current === activeProject.id ? "" : activeProject.id);
                      setProjectMenuOpen(false);
                    }}
                  >
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </button>
                </div>
                <div className="codexAddProject">
                  <button
                    className={projectMenuOpen ? "active" : ""}
                    type="button"
                    title={conversationCopy.addProject}
                    aria-label={conversationCopy.addProject}
                    onClick={() => {
                      setProjectMenuOpen((open) => !open);
                      setOpenProjectMenuId("");
                    }}
                  >
                    <FolderPlus size={14} aria-hidden="true" />
                  </button>
                  {projectMenuOpen ? (
                    <div className="codexProjectMenu">
                      <button type="button" onClick={() => void createBlankConversationProject()}>
                        <FolderPlus size={15} aria-hidden="true" />
                        {conversationCopy.newBlankProject}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {!projectListCollapsed ? (
              <div className="codexProjectList">
                {visibleProjects.map((project) => (
                  <article className={project.id === conversationState.activeProjectId ? "codexProjectGroup active" : "codexProjectGroup"} key={project.id}>
                    <div
                      className="codexProjectRowShell"
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setConversationContextMenu({
                          kind: "project",
                          projectId: project.id,
                          x: event.clientX,
                          y: event.clientY
                        });
                        setOpenProjectMenuId("");
                        setProjectMenuOpen(false);
                      }}
                    >
                      <button className="codexProjectRow" type="button" onClick={() => selectConversationProject(project.id)} title={project.path || project.name}>
                        <FolderOpen size={15} aria-hidden="true" />
                        <strong>{project.name}</strong>
                        {project.pinned ? <Pin size={12} aria-hidden="true" /> : null}
                      </button>
                      <div className="codexProjectRowActions">
                        <button
                          type="button"
                          title={conversationCopy.more}
                          aria-label={conversationCopy.more}
                          onClick={() => setOpenProjectMenuId((current) => current === project.id ? "" : project.id)}
                        >
                          <MoreHorizontal size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          title={conversationCopy.newConversation}
                          aria-label={conversationCopy.newConversation}
                          onClick={() => createConversationThreadForProject(project.id)}
                        >
                          <MessageSquare size={14} aria-hidden="true" />
                        </button>
                      </div>
                      {openProjectMenuId === project.id ? renderProjectMenu(project) : null}
                    </div>
                    <div className="codexThreadList">
                      {visibleConversationThreads(project).map((thread) => renderThreadRow(project, thread))}
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        </aside>

        <section className="codexChatPane">
          <header className="codexChatHeader">
            <strong>{conversationTitle}</strong>
            <div>
              <button type="button" aria-label={conversationCopy.more}>
                <MoreHorizontal size={17} aria-hidden="true" />
              </button>
              <button type="button" aria-label={copy.jobsView} onClick={() => setActiveView("jobs")}>
                <ListChecks size={16} aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="codexChatBody" ref={conversationBodyRef}>
            <article className="codexAssistantMessage">
              <ul>
                <li>
                  <strong>{panelSupervisorDisplayName}</strong>
                  <p>{conversationCopy.assistantIntro}</p>
                  <p><code>{activeProjectPath || conversationCopy.projectUnset}</code></p>
                </li>
                <li>
                  <strong>{copy.smartRouting}</strong>
                  <p>
                    {copy.smartRoutingHint} <code>{routingLabel(displayedRoutingMode)}</code>
                  </p>
                </li>
                <li>
                  <strong>{conversationCopy.latestJob}</strong>
                  <p>{latestJob ? jobDisplayTitle(latestJob) : copy.noLatestJob}</p>
                </li>
              </ul>
            </article>
            {activeMessages.length ? (
              <div className="codexMessageList">
                {activeMessages.map((message) => (
                  <article className={`codexMessageBubble ${message.role}`} key={message.id}>
                    <div>
                      <strong>
                        {message.role === "user"
                          ? (language === "zh" ? "\u4f60" : "You")
                          : panelSupervisorDisplayName}
                      </strong>
                      <small>{formatTime(message.createdAt, language)}</small>
                    </div>
                    <p>{message.body}</p>
                    {message.attachments?.length ? (
                      <div className="codexMessageAttachments">
                        {message.attachments.map((attachment) => (
                          <span key={attachment.id}>
                            <Paperclip size={12} aria-hidden="true" />
                            {attachment.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
          </div>

          <form
            className="codexComposer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendConversationMessage();
            }}
          >
            <label className="visuallyHidden" htmlFor="prompt">{conversationCopy.inputPlaceholder}</label>
            <textarea
              id="prompt"
              value={prompt}
              placeholder={conversationCopy.inputPlaceholder}
              onChange={(event) => updateActiveConversationDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.altKey || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                if (canStartJob) {
                  void sendConversationMessage();
                }
              }}
            />
            {activeAttachments.length ? (
              <div className="codexAttachmentTray" aria-label={conversationCopy.attachedFiles}>
                {activeAttachments.map((attachment) => (
                  <span key={attachment.id}>
                    <Paperclip size={12} aria-hidden="true" />
                    {attachment.name}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="codexComposerFooter">
              <div className="codexComposerLeft">
                <div className="codexAttachmentPicker">
                  <button
                    className="codexIconButton"
                    type="button"
                    aria-label={conversationCopy.addPhotosAndFiles}
                    onClick={() => setAttachmentMenuOpen((open) => !open)}
                  >
                    <Plus size={18} aria-hidden="true" />
                  </button>
                  {attachmentMenuOpen ? (
                    <div className="codexAttachmentMenu">
                      <button type="button" onClick={() => void openAttachmentPicker()}>
                        <Paperclip size={15} aria-hidden="true" />
                        {conversationCopy.addPhotosAndFiles}
                      </button>
                    </div>
                  ) : null}
                </div>
                <input
                  ref={attachmentInputRef}
                  className="visuallyHidden"
                  type="file"
                  multiple
                  onChange={(event) => {
                    handleAttachmentInput(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              <div className="codexComposerRight">
                <button data-testid="start-job-button" className="codexSendButton" type="submit" disabled={!canStartJob} aria-label={conversationCopy.send}>
                  <Send size={18} aria-hidden="true" />
                </button>
              </div>
            </div>
            {error ? <p className="error">{error}</p> : null}
          </form>
          {conversationContextMenu?.kind === "thread" && contextThread && contextProject ? (
            <div
              className="codexContextMenu"
              style={{ left: conversationContextMenu.x, top: conversationContextMenu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button type="button" onClick={() => toggleConversationPinned(contextProject.id, contextThread.id)}>
                <Pin size={15} aria-hidden="true" />
                {contextThread.pinned ? conversationCopy.unpinConversation : conversationCopy.pinConversation}
              </button>
              <button type="button" onClick={() => void renameConversation(contextProject.id, contextThread.id)}>
                <Pencil size={15} aria-hidden="true" />
                {conversationCopy.renameConversation}
              </button>
              <button type="button" onClick={() => archiveConversation(contextProject.id, contextThread.id)}>
                <Archive size={15} aria-hidden="true" />
                {conversationCopy.archiveConversation}
              </button>
              <button type="button" onClick={() => markConversationUnread(contextProject.id, contextThread.id)}>
                <Mail size={15} aria-hidden="true" />
                {conversationCopy.markUnread}
              </button>
              <span />
              <button type="button" onClick={() => void openProjectInExplorer(contextProject.id)}>
                <ExternalLink size={15} aria-hidden="true" />
                {conversationCopy.openInExplorer}
              </button>
              <button type="button" onClick={() => void copyProjectPath(contextProject.id)}>
                <Copy size={15} aria-hidden="true" />
                {conversationCopy.copyWorkdir}
              </button>
            </div>
          ) : null}
          {conversationContextMenu?.kind === "project" && contextProject ? (
            <div
              className="codexContextMenu"
              style={{ left: conversationContextMenu.x, top: conversationContextMenu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button type="button" onClick={() => toggleProjectPinned(contextProject.id)}>
                <Pin size={15} aria-hidden="true" />
                {contextProject.pinned ? conversationCopy.unpinProject : conversationCopy.pinProject}
              </button>
              <button type="button" onClick={() => void openProjectInExplorer(contextProject.id)}>
                <FolderOpen size={15} aria-hidden="true" />
                {conversationCopy.openInExplorer}
              </button>
              <button type="button" onClick={() => void renameProject(contextProject.id)}>
                <Pencil size={15} aria-hidden="true" />
                {conversationCopy.renameProject}
              </button>
              <button type="button" onClick={() => archiveProject(contextProject.id)}>
                <Archive size={15} aria-hidden="true" />
                {conversationCopy.archiveProject}
              </button>
              <button type="button" onClick={() => requestDeleteProject(contextProject.id)}>
                <Trash2 size={15} aria-hidden="true" />
                {conversationCopy.removeProject}
              </button>
            </div>
          ) : null}
        </section>
      </section>
    );
  }

  function renderJobs() {
    const taskCopy = language === "zh"
      ? {
          monitorTitle: "\u4efb\u52a1\u8fd0\u884c",
          monitorSubtitle: "\u8fd9\u91cc\u53ea\u770b\u4efb\u52a1\u8fdb\u7a0b\u3001\u5b50 Agent \u72b6\u6001\u548c\u5386\u53f2\u5217\u8868\uff1b\u65b0\u4efb\u52a1\u4ece\u5de6\u4fa7\u7684\u201c\u5bf9\u8bdd\u201d\u9875\u53d1\u8d77\u3002",
          process: "\u8fdb\u7a0b",
          subAgents: "\u5b50 Agent \u72b6\u6001",
          waiting: "\u7b49\u5f85",
          recentRuns: "\u4efb\u52a1\u5217\u8868",
          selectedRun: "\u5f53\u524d\u4efb\u52a1"
        }
      : {
          monitorTitle: "Task Runs",
          monitorSubtitle: "This page tracks job progress, sub-agent state, and the task list. New work starts from Conversations.",
          process: "Process",
          subAgents: "Sub-agent status",
          waiting: "Waiting",
          recentRuns: "Job List",
          selectedRun: "Selected Job"
        };
    const selectedProgress = selectedFromList ? jobProgress(selectedFromList.status) : 0;
    const agentDefinitions = [
      { id: "main-agent", short: "main" },
      { id: "research-agent", short: "research" },
      { id: "writer-agent", short: "writer" },
      { id: "image-agent", short: "image" },
      { id: "video-agent", short: "video" },
      { id: "test-agent", short: "test" }
    ];
    const timelineItems = timeline?.timeline ?? [];
    const agentStatusCards = agentDefinitions.map((agent) => {
      const latestEvent = timelineItems.find((item) => {
        const actor = (item.actor ?? "").toLowerCase();
        return actor.includes(agent.id) || actor.includes(agent.short);
      });
      const tone = latestEvent
        ? selectedFromList?.status === "succeeded"
          ? "success"
          : selectedFromList?.status === "failed" || selectedFromList?.status === "cancelled"
            ? "danger"
            : "active"
        : "idle";
      return {
        ...agent,
        label: agentSequenceLabel(agent.id),
        tone,
        status: latestEvent ? compactEventType(latestEvent.eventType) : selectedFromList ? taskCopy.waiting : "-",
        detail: latestEvent?.title ?? (selectedFromList ? copy.statuses[selectedFromList.status] : copy.noJobSelected)
      };
    });

    return (
      <section className="deskPage jobsPage" data-tour-anchor="jobs">
        <section className="jobsProcessPanel">
          <div className="taskMonitorHeader">
            <div>
              <p className="eyebrow">
                <ListChecks size={15} aria-hidden="true" />
                {taskCopy.process}
              </p>
              <h1>{taskCopy.monitorTitle}</h1>
              <p>{taskCopy.monitorSubtitle}</p>
            </div>
            <button className="secondaryButton compactButton" type="button" onClick={() => setActiveView("conversations")}>
              <MessageSquare size={15} aria-hidden="true" />
              {copy.openConversations}
            </button>
          </div>
          <div className="selectedRunProgress">
            <div>
              <span>{selectedFromList ? jobDisplayTitle(selectedFromList) : taskCopy.selectedRun}</span>
              <strong>{selectedFromList ? copy.statuses[selectedFromList.status] : copy.noJobSelected}</strong>
            </div>
            <div className="processMeter" aria-label={taskCopy.process}>
              <span style={{ width: `${selectedProgress}%` }} />
            </div>
          </div>
          <div className="agentStatusGrid" aria-label={taskCopy.subAgents}>
            {agentStatusCards.map((agent) => (
              <article className={`agentStatusCard ${agent.tone}`} key={agent.id}>
                <span className={`dot ${agent.tone === "idle" ? "active" : agent.tone}`} />
                <strong>{agent.label}</strong>
                <em>{agent.status}</em>
                <small>{agent.detail}</small>
              </article>
            ))}
          </div>
        </section>

        <div className="jobsSummaryStrip">
          <div>
            <span>{copy.runningJobs}</span>
            <strong>{runningJobCount}</strong>
          </div>
          <div>
            <span>{copy.totalJobs}</span>
            <strong>{jobListPage?.hasMore ? `${jobs.length}+` : jobs.length}</strong>
          </div>
          <div>
            <span>{copy.latestJob}</span>
            <strong>{latestJob ? jobDisplayTitle(latestJob) : copy.noLatestJob}</strong>
          </div>
        </div>

        <section className="jobWorkspace">
          <aside className="jobList">
            <div className="sectionHeader">
              <h2>{taskCopy.recentRuns}</h2>
              <span>{jobListPage?.hasMore ? `${jobs.length}+` : jobs.length}</span>
            </div>
            <div className="jobFilters">
              <div className="filterSegments" aria-label={copy.jobStatusFilter}>
                {jobStatusFilters.map((filter) => (
                  <button
                    key={filter.id}
                    className={filter.id === jobStatusFilter ? "filterSegment active" : "filterSegment"}
                    data-filter={filter.id}
                    type="button"
                    onClick={() => setJobStatusFilter(filter.id)}
                  >
                    {copy.statusFilters[filter.id]}
                  </button>
                ))}
              </div>
              <label className="searchField">
                <Search size={15} aria-hidden="true" />
                <input
                  id="jobSearch"
                  type="search"
                  aria-label={copy.searchPromptsAria}
                  placeholder={copy.searchPrompts}
                  value={jobPromptFilter}
                  onChange={(event) => setJobPromptFilter(event.target.value)}
                />
              </label>
              <div className="filterSegments timeFilterSegments" aria-label={copy.jobTimeFilter}>
                {jobTimeFilters.map((filter) => (
                  <button
                    key={filter.id}
                    className={filter.id === jobTimeFilter ? "filterSegment active" : "filterSegment"}
                    data-time-filter={filter.id}
                    type="button"
                    onClick={() => setJobTimeFilter(filter.id)}
                  >
                    {copy.timeFilters[filter.id]}
                  </button>
                ))}
              </div>
              {jobTimeFilter === "custom" ? (
                <div className="customTimeFilters">
                  <label htmlFor="jobSince">{copy.since}</label>
                  <input
                    id="jobSince"
                    type="datetime-local"
                    value={customSince}
                    onChange={(event) => {
                      setJobTimeFilter("custom");
                      setCustomSince(event.target.value);
                    }}
                  />
                  <label htmlFor="jobUntil">{copy.until}</label>
                  <input
                    id="jobUntil"
                    type="datetime-local"
                    value={customUntil}
                    onChange={(event) => {
                      setJobTimeFilter("custom");
                      setCustomUntil(event.target.value);
                    }}
                  />
                </div>
              ) : null}
            </div>
            <ol>
              {jobs.map((job) => (
                <li key={job.id}>
                  <button
                    className={job.id === selectedJobId ? "jobRow selected" : "jobRow"}
                    data-job-id={job.id}
                    type="button"
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    <span className={`dot ${statusTone(job.status)}`} />
                    <span className="jobMeta">
                      <strong>{jobDisplayTitle(job)}</strong>
                      <span>{routingLabel(job.routingMode)}</span>
                    </span>
                    <span className="jobStatus">
                      {job.executionRetry
                        ? language === "zh" ? "\u91cd\u8bd5\u4e2d" : "Retrying"
                        : job.executionQueue?.status === "queued"
                        ? language === "zh" ? "\u6392\u961f" : "Queued"
                        : copy.statuses[job.status]}
                    </span>
                    <span className="jobTime">{formatTime(job.createdAt, language)}</span>
                  </button>
                </li>
              ))}
              {jobs.length === 0 ? <li className="emptyState">{copy.noJobsMatch}</li> : null}
            </ol>
            {jobListPage?.hasMore ? (
              <div className="loadMoreRow">
                <button className="secondaryButton" type="button" onClick={loadMoreJobs} disabled={busy}>
                  {copy.loadMore}
                </button>
              </div>
            ) : null}
          </aside>

          <section className="jobDetail">
            <div className="sectionHeader detailHeader">
              <div>
                <h2>{selectedFromList ? jobDisplayTitle(selectedFromList) : taskCopy.selectedRun}</h2>
                <p>{selectedFromList ? `${selectedFromList.id} / ${selectedFromList.ingressOrigin} / ${routingLabel(selectedFromList.routingMode)}` : "-"}</p>
              </div>
              <div className="detailActions">
                {isResumable(selectedFromList) && unknownOutcomesLoaded && selectedUnknownOutcomes.length === 0 ? (
                  <button
                    className="primaryButton"
                    type="button"
                    onClick={resumeSelectedJob}
                    disabled={busy}
                  >
                    <Play size={15} aria-hidden="true" />
                    {language === "zh" ? "\u6062\u590d\u4efb\u52a1" : "Resume task"}
                  </button>
                ) : null}
                <button
                  className="dangerButton"
                  type="button"
                  onClick={cancelSelectedJob}
                  disabled={!isCancellable(selectedFromList) || busy}
                >
                  {selectedFromList?.status === "cancelled" ? copy.cancelled : copy.cancel}
                </button>
              </div>
            </div>

            {selectedFromList ? (
              <dl className="stats">
                <div>
                  <dt>{copy.status}</dt>
                  <dd>{copy.statuses[selectedFromList.status]}</dd>
                </div>
                <div>
                  <dt>{copy.created}</dt>
                  <dd>{formatTime(selectedFromList.createdAt, language)}</dd>
                </div>
                <div>
                  <dt>{copy.budget}</dt>
                  <dd>
                    {selectedFromList.maxModelCalls}
                    {selectedFromList.spendBudget.enabled
                      ? ` / ${formatUsd(selectedFromList.spendBudget.committedUsd)}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>{copy.timeline}</dt>
                  <dd>{timeline?.summary.totalTimelineItems ?? 0}</dd>
                </div>
              </dl>
            ) : (
              <p className="emptyState">{copy.noJobLoaded}</p>
            )}

            {selectedFromList?.spendBudget.enabled ? (
              <section
                className={`jobSpendNotice ${selectedFromList.spendBudget.blocked ? "blocked" : ""}`}
                role={selectedFromList.spendBudget.blocked ? "alert" : "status"}
              >
                {selectedFromList.spendBudget.blocked
                  ? <AlertTriangle size={18} aria-hidden="true" />
                  : <Gauge size={18} aria-hidden="true" />}
                <div>
                  <h3>
                    {selectedFromList.spendBudget.blocked
                      ? language === "zh" ? "费用上限已暂停任务" : "Spend limit paused the task"
                      : language === "zh" ? "任务费用" : "Task spend"}
                  </h3>
                  <div className="jobSpendMetrics">
                    <span>{language === "zh" ? "已结算" : "Settled"} <strong>{formatUsd(selectedFromList.spendBudget.settledUsd)}</strong></span>
                    <span>{language === "zh" ? "已预留" : "Reserved"} <strong>{formatUsd(selectedFromList.spendBudget.reservedUsd)}</strong></span>
                    <span>{language === "zh" ? "任务上限" : "Task limit"} <strong>{formatUsd(selectedFromList.spendBudget.maxCostUsd)}</strong></span>
                    <span>{language === "zh" ? "剩余" : "Remaining"} <strong>{formatUsd(selectedFromList.spendBudget.remainingUsd)}</strong></span>
                  </div>
                  {selectedFromList.spendBudget.blocked ? (
                    <p>{spendBlockingMessage(selectedFromList, language)}</p>
                  ) : null}
                  {selectedFromList.spendBudget.blockingScope === "job" ? (
                    <label className="jobSpendLimitEditor">
                      <span>{language === "zh" ? "新上限" : "New limit"}</span>
                      <input
                        type="number"
                        min={selectedFromList.spendBudget.committedUsd + 0.000001}
                        step="0.01"
                        value={maxCostUsdDraft}
                        onChange={(event) => setMaxCostUsdDraft(event.target.value)}
                      />
                      <span>USD</span>
                    </label>
                  ) : null}
                </div>
              </section>
            ) : null}

            {selectedArtifactDeliveries && selectedArtifactDeliveries.requiredCount > 0 ? (
              <section className="jobPreflightNotice" role="status" aria-live="polite">
                {selectedArtifactDeliveries.failedCount > 0 ? (
                  <AlertTriangle size={18} aria-hidden="true" />
                ) : selectedArtifactDeliveries.readyToFinalize ? (
                  <CheckCircle2 size={18} aria-hidden="true" />
                ) : (
                  <RefreshCw size={18} aria-hidden="true" />
                )}
                <div>
                  <h3>{language === "zh" ? "\u4ea7\u7269\u4ea4\u4ed8\u72b6\u6001" : "Artifact delivery"}</h3>
                  <p>
                    {language === "zh"
                      ? `\u5df2\u786e\u8ba4 ${selectedArtifactDeliveries.succeededCount}/${selectedArtifactDeliveries.requiredCount}\uff0c\u4ea4\u4ed8\u4e2d ${selectedArtifactDeliveries.deliveringCount}\uff0c\u7b49\u5f85 ${selectedArtifactDeliveries.pendingCount}\uff0c\u5931\u8d25 ${selectedArtifactDeliveries.failedCount}\u3002`
                      : `${selectedArtifactDeliveries.succeededCount}/${selectedArtifactDeliveries.requiredCount} confirmed, ${selectedArtifactDeliveries.deliveringCount} delivering, ${selectedArtifactDeliveries.pendingCount} pending, ${selectedArtifactDeliveries.failedCount} failed.`}
                  </p>
                  <div className="jobPreflightAgents">
                    {selectedArtifactDeliveries.deliveries.map((delivery) => (
                      <span key={delivery.id} title={delivery.deliveredPath ?? delivery.lastError ?? undefined}>
                        {delivery.requestedFileName}: {delivery.status}
                      </span>
                    ))}
                  </div>
                </div>
              </section>
            ) : null}

            {selectedFromList?.status === "waiting_for_human" &&
            [
              "required_media_delivery_missing",
              "required_image_normalization_failed",
              "required_document_delivery_missing"
            ]
              .includes(selectedFromList.heartbeatNote ?? "") ? (
              <section className="jobPreflightNotice" role="alert">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <h3>
                    {language === "zh"
                      ? selectedFromList.heartbeatNote === "required_document_delivery_missing"
                        ? "文档文件尚未达到交付标准"
                        : selectedFromList.heartbeatNote === "required_image_normalization_failed"
                          ? "图片无法安全转换为目标规格"
                          : "真实媒体文件尚未达到交付标准"
                      : selectedFromList.heartbeatNote === "required_document_delivery_missing"
                        ? "The document file is not ready for delivery"
                        : selectedFromList.heartbeatNote === "required_image_normalization_failed"
                          ? "The image could not be safely normalized"
                          : "The media file is not ready for delivery"}
                  </h3>
                  <p>
                    {language === "zh"
                      ? selectedFromList.heartbeatNote === "required_document_delivery_missing"
                        ? "Honeycomb 没有找到真实文档，文件结构无法通过解析，或 Agent 的文字不能安全转换成要求的格式。任务不会用错误扩展名冒充 DOCX、PDF 或其他文档。"
                        : selectedFromList.heartbeatNote === "required_image_normalization_failed"
                          ? "源图的比例差异过大、文件无法读取，或输出超过安全限制。Honeycomb 没有强行裁切或交付错误文件。"
                          : "Honeycomb 没有找到可下载的本地图片或视频，或者文件格式、尺寸与任务要求不一致，因此没有把任务标记为成功。"
                      : selectedFromList.heartbeatNote === "required_document_delivery_missing"
                        ? "Honeycomb found no real document, its structure failed parsing, or the agent text could not be safely converted to the requested format. A renamed fake DOCX or PDF is never delivered."
                        : selectedFromList.heartbeatNote === "required_image_normalization_failed"
                          ? "The source aspect ratio is too different, the file is unreadable, or the output exceeds safety limits. Honeycomb did not force a destructive crop or deliver a bad file."
                          : "Honeycomb did not find a downloadable local image or video, or its format or dimensions do not match the task. The task was not marked successful."}
                  </p>
                </div>
              </section>
            ) : null}

            {selectedFromList?.executionPreflight?.status === "blocked" ? (
              <section className="jobPreflightNotice" role="alert">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <h3>{language === "zh" ? "执行前检查未通过" : "Execution preflight blocked"}</h3>
                  <p>{taskPreflightMessage(selectedFromList.executionPreflight, language)}</p>
                  <div className="jobPreflightAgents">
                    {selectedFromList.executionPreflight.agents
                      .filter((agent) => !agent.ready)
                      .map((agent) => (
                        <span key={agent.agentId}>{agent.agentId}</span>
                      ))}
                  </div>
                </div>
                <button className="secondaryButton compactButton" type="button" onClick={() => setActiveView("agents")}>
                  <Settings size={14} aria-hidden="true" />
                  {language === "zh" ? "配置 Agent" : "Configure agents"}
                </button>
              </section>
            ) : null}

            {selectedFromList?.executionPreflight?.status === "simulation" ? (
              <section className="jobPreflightNotice jobSimulationNotice" role="status">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <h3>{language === "zh" ? "\u5f53\u524d\u662f\u6a21\u62df\u6267\u884c" : "Simulation run"}</h3>
                  <p>
                    {language === "zh"
                      ? "\u8fd9\u6b21\u4efb\u52a1\u4e0d\u4f1a\u8c03\u7528\u5b50 Agent \u7684\u771f\u5b9e\u6a21\u578b\uff0c\u4e5f\u4e0d\u4f1a\u751f\u6210\u771f\u5b9e\u6587\u4ef6\u3002\u8bf7\u786e\u8ba4 Agent \u6a21\u578b\u548c API Key \u5747\u5df2\u914d\u7f6e\uff0c\u7136\u540e\u91cd\u542f Honeycomb\u3002"
                      : "This run will not call real child-agent models or create real files. Configure agent models and API keys, then restart Honeycomb."}
                  </p>
                </div>
                <button className="secondaryButton compactButton" type="button" onClick={() => setActiveView("agents")}>
                  <Settings size={14} aria-hidden="true" />
                  {language === "zh" ? "\u68c0\u67e5 Agent" : "Check agents"}
                </button>
              </section>
            ) : null}

            {selectedUnknownOutcomes.length > 0 ? (
              <section className="jobReconciliationNotice" role="alert" aria-live="polite">
                <AlertTriangle size={18} aria-hidden="true" />
                <div className="jobReconciliationBody">
                  <h3>{language === "zh" ? "模型调用结果需要核对" : "Model call outcome needs reconciliation"}</h3>
                  <p>
                    {language === "zh"
                      ? "为避免重复生成和重复扣费，Honeycomb 已暂停任务。核对完成前不能直接恢复。"
                      : "Honeycomb paused the task to prevent duplicate work or charges. It cannot resume until reconciliation is complete."}
                  </p>
                  <div className="jobReconciliationCalls">
                    {selectedUnknownOutcomes.map((modelCall) => (
                      <div className="jobReconciliationCall" key={modelCall.id}>
                        <div className="jobReconciliationMeta">
                          <strong>{modelCall.agentId}</strong>
                          <span>
                            {[
                              modelCall.requestReference?.providerId,
                              modelCall.requestReference?.model
                            ].filter(Boolean).join(" / ") || (language === "zh" ? "旧请求信息不完整" : "Legacy request details unavailable")}
                          </span>
                          <span>{reconciliationStatusLabel(modelCall.reconciliation?.status, language)}</span>
                          <small>{reconciliationNoticeText(modelCall.reconciliation?.status, language)}</small>
                        </div>
                        <div className="jobReconciliationActions">
                          <button
                            className="primaryButton compactButton"
                            type="button"
                            onClick={() => reconcileSelectedModelCall(modelCall.id, { action: "query_provider" })}
                            disabled={Boolean(reconciliationBusyId)}
                          >
                            <RefreshCw size={14} aria-hidden="true" />
                            {reconciliationBusyId === modelCall.id
                              ? language === "zh" ? "正在核对" : "Checking"
                              : language === "zh" ? "核对服务商" : "Check provider"}
                          </button>
                          <button
                            className="secondaryButton compactButton"
                            type="button"
                            onClick={() => confirmModelCallWasNotAccepted(modelCall.id)}
                            disabled={Boolean(reconciliationBusyId)}
                          >
                            <ShieldQuestion size={14} aria-hidden="true" />
                            {language === "zh" ? "人工确认未执行" : "Confirm not executed"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {reconciliationMessage ? <p className="jobReconciliationFeedback success">{reconciliationMessage}</p> : null}
                  {reconciliationError ? <p className="jobReconciliationFeedback error">{reconciliationError}</p> : null}
                </div>
              </section>
            ) : reconciliationMessage ? (
              <section className="jobReconciliationResolved" role="status">
                <CheckCircle2 size={18} aria-hidden="true" />
                <p>{reconciliationMessage}</p>
              </section>
            ) : null}

            {selectedFromList?.executionRetry ? (
              <section className="jobQueueNotice retrying" role="status" aria-live="polite">
                <RefreshCw size={18} aria-hidden="true" />
                <div>
                  <h3>
                    {language === "zh"
                      ? "\u6a21\u578b\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u6b63\u5728\u81ea\u52a8\u91cd\u8bd5"
                      : "Model service is temporarily unavailable; retrying"}
                  </h3>
                  <p>
                    {selectedFromList.executionRetry.agentId} / {selectedFromList.executionRetry.providerId}
                  </p>
                  <div className="jobQueueMetrics">
                    <span>
                      {language === "zh" ? "\u4e0b\u6b21\u5c1d\u8bd5" : "Next attempt"}
                      {` ${selectedFromList.executionRetry.nextAttemptNo}/${selectedFromList.executionRetry.maxAttempts}`}
                    </span>
                    <span>
                      {modelRetryFailureLabel(selectedFromList.executionRetry.failureCategory, language)}
                    </span>
                    <span>
                      {language === "zh" ? "\u7b49\u5f85" : "Wait"}
                      {` ${Math.max(0, Math.ceil((Date.parse(selectedFromList.executionRetry.retryAt) - Date.now()) / 1000))}s`}
                    </span>
                    <span>{formatTime(selectedFromList.executionRetry.retryAt, language)}</span>
                  </div>
                </div>
              </section>
            ) : null}

            {selectedFromList?.executionQueue ? (
              <section className={`jobQueueNotice ${selectedFromList.executionQueue.status}`} role="status">
                <Gauge size={18} aria-hidden="true" />
                <div>
                  <h3>
                    {selectedFromList.executionQueue.status === "queued"
                      ? language === "zh" ? "\u6b63\u5728\u7b49\u5f85\u6a21\u578b\u6267\u884c\u540d\u989d" : "Waiting for a model slot"
                      : language === "zh" ? "\u5b50 Agent \u6b63\u5728\u8c03\u7528\u6a21\u578b" : "Child agent is calling its model"}
                  </h3>
                  <p>
                    {selectedFromList.executionQueue.agentId} / {selectedFromList.executionQueue.providerId}
                  </p>
                  <div className="jobQueueMetrics">
                    {selectedFromList.executionQueue.status === "queued" ? (
                      <span>
                        {language === "zh" ? "\u670d\u52a1\u5546\u961f\u5217" : "Provider queue"}
                        {` ${selectedFromList.executionQueue.providerPosition}`}
                      </span>
                    ) : null}
                    <span>
                      {language === "zh" ? "\u5168\u5c40" : "Global"}
                      {` ${selectedFromList.executionQueue.active.global}/${selectedFromList.executionQueue.limits.global}`}
                    </span>
                    <span>
                      Provider {`${selectedFromList.executionQueue.active.provider}/${selectedFromList.executionQueue.limits.provider}`}
                    </span>
                    <span>
                      Agent {`${selectedFromList.executionQueue.active.agent}/${selectedFromList.executionQueue.limits.agent}`}
                    </span>
                  </div>
                </div>
              </section>
            ) : null}

            <div className="timelineHeader">
              <h3>{copy.timeline}</h3>
              <span>{timeline?.summary.truncated ? copy.latestItems : copy.complete}</span>
            </div>
            <ol className="timeline">
              {timeline?.timeline.length ? (
                timeline.timeline.map((item) => (
                  <li key={item.id} className="timelineItem">
                    <time>{formatTime(item.at, language)}</time>
                    <span className={`source source-${item.source}`}>{copy.sources[item.source]}</span>
                    <div>
                      <strong>{compactEventType(item.eventType)}</strong>
                      <p>{item.title}</p>
                      {item.actor ? <small>{item.actor}</small> : null}
                    </div>
                  </li>
                ))
              ) : (
                <li className="emptyState">{copy.noTimelineEvents}</li>
              )}
            </ol>
          </section>
        </section>
      </section>
    );
  }

  function openAgentConfig(agentId: string) {
    const existing = agentModelConfigs[agentId];
    const isPanelSupervisor = agentId === "panel-supervisor-agent";
    const inheritedApiKey = agentId === "panel-supervisor-agent" ? providerApiKey : "";
    const existingHasUsableKey = Boolean(existing?.apiKey?.trim()) ||
      existing?.apiKeyConfigured === true;
    const model = existingHasUsableKey && existing?.model
      ? existing.model
      : isPanelSupervisor
        ? firstRunPreview?.provider?.model || ""
        : "";
    const providerReference = resolveProviderForAgent(model, existing, isPanelSupervisor ? firstRunPreview : null);
    setExpandedAgentId((current) => (current === agentId ? "" : agentId));
    setAgentConfigDraft({
      providerName: existingHasUsableKey && existing?.providerName
        ? existing.providerName
        : isPanelSupervisor
          ? firstRunPreview?.provider?.providerName || providerReference.providerName
          : providerReference.providerName,
      baseUrl: existingHasUsableKey && existing?.baseUrl
        ? existing.baseUrl
        : isPanelSupervisor
          ? firstRunPreview?.provider?.baseUrl || providerReference.baseUrl
          : providerReference.baseUrl,
      model,
      apiKey: existing?.apiKey || inheritedApiKey,
      apiKeyConfigured: existingHasUsableKey || Boolean(inheritedApiKey)
    });
    setShowAgentApiKey(false);
    setAgentConfigMessage("");
    setAgentConfigError("");
  }

  function updateAgentConfigDraft(field: keyof AgentConfigDraft, value: string) {
    setAgentConfigDraft((current) => ({ ...current, [field]: value }));
    setAgentConfigMessage("");
    setAgentConfigError("");
  }

  async function saveAgentConfig(agentId: string) {
    if (agentConfigSaving) return;
    setAgentConfigError("");
    setAgentConfigMessage(copy.agentConfigSaving);
    const existing = agentModelConfigs[agentId];
    const inheritedApiKey = agentId === "panel-supervisor-agent" ? providerApiKey : "";
    const hasSavedApiKey = existing?.apiKeyConfigured === true || Boolean(existing?.apiKey?.trim());
    const apiKey = agentConfigDraft.apiKey.trim() || existing?.apiKey?.trim() || inheritedApiKey;
    const model = agentConfigDraft.model.trim();
    if (!model || (!apiKey && !hasSavedApiKey)) {
      setAgentConfigMessage("");
      setAgentConfigError(copy.agentConfigMissing);
      return;
    }
    setAgentConfigSaving(true);
    try {
      const backendResult = await saveBackendAgentModelConfig(agentId, {
        model,
        ...(apiKey ? { apiKey } : {}),
        allowDiscoveredUserRuntime: true
      });
      const verifiedAt = new Date().toISOString();
      const savedConfig = {
        providerName: backendResult.provider.displayName,
        baseUrl: backendResult.provider.baseUrl,
        model: backendResult.agent.model || model,
        apiKey,
        apiKeyConfigured: true,
        verifiedAt: backendResult.verification.checkedAt || verifiedAt,
        appliedAt: backendResult.openclawSync.appliedAt || verifiedAt
      };
      const nextConfigs = {
        ...agentModelConfigs,
        [agentId]: savedConfig
      };
      saveAgentModelConfigs(nextConfigs);
      setAgentModelConfigs(nextConfigs);
      setAgentConfigDraft(savedConfig);
      if (agentId === "panel-supervisor-agent" && apiKey) {
        void invokeDesktopCommand("save_provider_api_key", { payload: apiKey });
        setProviderApiKey(apiKey);
      }
      if (apiKey) {
        void saveAgentModelConfigToDesktop(agentId, savedConfig);
      }
      setAgentConfigMessage(
        backendResult.openclawSync.ok
          ? copy.agentConfigSaved
          : `${copy.agentConfigSaved} ${language === "zh" ? "但 OpenClaw 同步需要稍后重试。" : "OpenClaw sync needs a retry."}`
      );
    } catch (caught) {
      setAgentConfigMessage("");
      setAgentConfigError(describeAgentConfigSaveError(caught, language, agentId, model));
    } finally {
      setAgentConfigSaving(false);
    }
  }

  function cancelAgentConfig() {
    setExpandedAgentId("");
    setAgentConfigMessage("");
    setAgentConfigError("");
    setAgentConfigSaving(false);
    setShowAgentApiKey(false);
  }

  function renderAgents() {
    const agents = [
      {
        id: "panel-supervisor-agent",
        name: panelSupervisorDisplayName,
        description: language === "zh" ? "同时担任面板 agent 和主控 agent，负责理解任务、选择编排、分配工作并整合结果。" : "Acts as both the panel agent and main control agent: understands tasks, chooses routing, delegates work, and synthesizes results.",
        modelTag: configuredProvider,
        configured: firstRunPreview?.provider?.apiKeyConfigured === true
      },
      {
        id: "research-agent",
        name: language === "zh" ? "研究 Agent" : "Research agent",
        description: language === "zh" ? "收集背景、证据、约束和风险，为后续工作建立可靠上下文。" : "Collects context, evidence, constraints, and risks before downstream work starts.",
        modelTag: copy.unconfigured,
        configured: false
      },
      {
        id: "writer-agent",
        name: language === "zh" ? "写作 Agent" : "Writer agent",
        description: language === "zh" ? "把研究和计划转化为清晰、成熟、可以交付的文字产出。" : "Turns research and plans into clear, polished, deliverable writing.",
        modelTag: copy.unconfigured,
        configured: false
      },
      {
        id: "image-agent",
        name: language === "zh" ? "图像 Agent" : "Image agent",
        description: language === "zh" ? "生成视觉方案、图片 brief 和可执行的图像提示词。" : "Produces visual directions, image briefs, and executable image prompts.",
        modelTag: copy.unconfigured,
        configured: false
      },
      {
        id: "video-agent",
        name: language === "zh" ? "视频 Agent" : "Video agent",
        description: language === "zh" ? "生成分镜、镜头设计、视频脚本和可执行的视频制作提示词。" : "Produces storyboards, shot plans, video scripts, and executable video production prompts.",
        modelTag: copy.unconfigured,
        configured: false
      },
      {
        id: "test-agent",
        name: language === "zh" ? "质检 Agent" : "Test agent",
        description: language === "zh" ? "按照用户质量标准检查结果，并给出通过或修改建议。" : "Checks results against the user's quality bar and recommends pass or revision.",
        modelTag: copy.unconfigured,
        configured: false
      }
    ];
    return (
      <section className="deskPage utilityPage">
        <div className="pageHero compactHero">
          <div>
            <p className="eyebrow">{copy.agentHint}</p>
            <h1>{copy.agentsView}</h1>
          </div>
        </div>
        <div className="agentGrid">
          {agents.map((agent) => {
            const savedConfig = agentModelConfigs[agent.id];
            const savedConfigured = savedConfig?.apiKeyConfigured === true || Boolean(savedConfig?.apiKey?.trim());
            const providerKeyConfigured = agent.id === "panel-supervisor-agent" &&
              firstRunPreview?.provider?.apiKeyConfigured === true;
            const configured = agent.id === "panel-supervisor-agent"
              ? savedConfigured || providerKeyConfigured
              : savedConfigured;
            const modelTag = savedConfigured
              ? [savedConfig.providerName, savedConfig.model].filter(Boolean).join(" · ")
              : agent.modelTag;
            const agentModelLabel = agent.id === "image-agent"
              ? copy.imageAgentModel
              : agent.id === "video-agent"
                ? copy.videoAgentModel
                : copy.model;
            const agentModelHint = agent.id === "image-agent"
              ? copy.imageAgentModelHint
              : agent.id === "video-agent"
                ? copy.videoAgentModelHint
                : "";
            const expanded = expandedAgentId === agent.id;
            return (
              <article className={expanded ? "deskPanel agentPanel expanded" : "deskPanel agentPanel"} key={agent.id}>
                <Bot size={20} aria-hidden="true" />
                <div>
                  <h2>{agent.name}</h2>
                  <small>{agent.id}</small>
                </div>
                <p>{agent.description}</p>
                <span className={configured ? "agentModelTag" : "agentModelTag pending"}>{modelTag}</span>
                <small className="agentConfigHint">
                  {configured ? (agent.id === "panel-supervisor-agent" ? copy.panelAgentConfigured : copy.agentConfigured) : copy.specialistNeedsKey}
                </small>
                <button className="primaryButton compactButton agentConfigureButton" type="button" onClick={() => openAgentConfig(agent.id)}>
                  <KeyRound size={14} aria-hidden="true" />
                  {copy.configureModelKey}
                </button>
                {expanded ? (
                  <div className="agentConfigPanel">
                    <div className="panelHeader">
                      <div>
                        <h3>{copy.agentConfigTitle}</h3>
                        <p className="mutedText">{agent.name}</p>
                      </div>
                      <span className={agentConfigDraft.apiKeyConfigured ? "agentModelTag" : "agentModelTag pending"}>
                        {agentConfigDraft.apiKeyConfigured ? copy.agentConfigured : copy.unconfigured}
                      </span>
                    </div>
                    <div className="agentConfigFields">
                      <label>
                        {agentModelLabel}
                        <input value={agentConfigDraft.model} onChange={(event) => updateAgentConfigDraft("model", event.target.value)} />
                        {agentModelHint ? <small className="agentConfigFieldHint">{agentModelHint}</small> : null}
                      </label>
                      <label>
                        {copy.apiKey}
                        <span className="apiKeyInputShell">
                          <input
                            type={showAgentApiKey ? "text" : "password"}
                            value={agentConfigDraft.apiKey}
                            placeholder={agentConfigDraft.apiKeyConfigured ? "••••••••" : ""}
                            onChange={(event) => updateAgentConfigDraft("apiKey", event.target.value)}
                            autoComplete="off"
                          />
                          <button
                            className="apiKeyToggle"
                            type="button"
                            aria-label={showAgentApiKey ? "Hide API Key" : "Show API Key"}
                            onClick={() => setShowAgentApiKey((current) => !current)}
                          >
                            {showAgentApiKey ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                          </button>
                        </span>
                      </label>
                    </div>
                    {agentConfigError ? <p className="error">{agentConfigError}</p> : null}
                    {agentConfigMessage ? <p className="successMessage">{agentConfigMessage}</p> : null}
                    <div className="agentConfigActions">
                      <button className="primaryButton compactButton" type="button" disabled={agentConfigSaving} onClick={() => void saveAgentConfig(agent.id)}>
                        <CheckCircle2 size={14} aria-hidden="true" />
                        {copy.saveAgentConfig}
                      </button>
                      <button className="secondaryButton compactButton" type="button" onClick={cancelAgentConfig}>
                        {copy.cancelConfig}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  function renderModels() {
    const flowSteps = routingModeFlows[language][routingMode];
    return (
      <section className="deskPage utilityPage">
        <div className="pageHero compactHero">
          <div>
            <p className="eyebrow">{copy.gatewayPanel}</p>
            <h1>{copy.modelsView}</h1>
          </div>
        </div>
        <div className="modelLayout">
          <section className="deskPanel routingModePanel">
            <div className="panelHeader">
              <div>
                <h2>{copy.routing}</h2>
                <p className="mutedText">{copy.modelsFlowHint}</p>
              </div>
              <span className="agentModelTag">{configuredProvider}</span>
            </div>
            <div className="routingList modelRoutingList">
              {routingModes.map((mode) => (
                <button
                  key={mode}
                  className={mode === routingMode ? "routingOption selected" : "routingOption"}
                  type="button"
                  onClick={() => setRoutingMode(mode)}
                >
                  <span>{routingLabel(mode)}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="deskPanel routingFlowPanel">
            <div className="panelHeader">
              <div>
                <h2>{copy.routingFlow} · {routingLabel(routingMode)}</h2>
                <p className="mutedText">{language === "zh" ? "这张流程图说明该模式如何组织任务，而不是强制每次任务都使用它。" : "This diagram explains how the mode organizes work; each task can still choose a different mode."}</p>
              </div>
            </div>
            <div className="routingFlowChart">
              {flowSteps.map((step, index) => (
                <article key={`${routingMode}-${step.title}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    );
  }

  function renderMemory() {
    const statusLabels: Record<ExperienceStatus, string> = {
      candidate: language === "zh" ? "待确认" : "Pending review",
      adopted: language === "zh" ? "已采纳" : "Adopted",
      rejected: language === "zh" ? "已拒绝" : "Rejected"
    };
    const filterLabels: Record<ExperienceStatus | "all", string> = {
      all: language === "zh" ? "全部" : "All",
      candidate: statusLabels.candidate,
      adopted: statusLabels.adopted,
      rejected: statusLabels.rejected
    };
    const scopeLabel = (experience: ExperienceRecord) => {
      if (experience.scope === "routing_mode" && routingModes.includes(experience.scopeKey as RoutingMode)) {
        return routingLabel(experience.scopeKey as RoutingMode);
      }
      return experience.scopeKey;
    };
    const kindLabel = (experience: ExperienceRecord) => {
      const labels: Record<ExperienceRecord["kind"], string> = {
        routing_outcome: language === "zh" ? "编排运行结果" : "Routing outcome",
        success_pattern: language === "zh" ? "成功模式" : "Success pattern",
        failure_pattern: language === "zh" ? "失败模式" : "Failure pattern",
        agent_lesson: language === "zh" ? "Agent 经验" : "Agent lesson",
        user_preference: language === "zh" ? "用户偏好" : "User preference"
      };
      return labels[experience.kind] ?? experience.kind;
    };
    const percentLabel = (value: number | undefined) => `${Math.round((value ?? 0) * 100)}%`;

    return (
      <section className="deskPage utilityPage">
        <div className="pageHero compactHero">
          <div>
            <p className="eyebrow">{copy.memoryHint}</p>
            <h1>{copy.memoryView}</h1>
          </div>
        </div>
        <div className="settingsGrid">
          <section className="deskPanel">
            <h2>{language === "zh" ? "提示词库" : "Prompt library"}</h2>
            <div className="systemRows">
              <div>
                <span>{language === "zh" ? "首次启动配置包" : "First Run bundle"}</span>
                <strong>{language === "zh" ? "桌面首次启动" : "desktop-first-run"}</strong>
              </div>
              <div>
                <span>{language === "zh" ? "Agent 提示词" : "Agent prompts"}</span>
                <strong>{language === "zh" ? "主控 / 研究 / 写作 / 图像 / 质检" : "main / research / writer / image / test"}</strong>
              </div>
            </div>
          </section>
          <section className="deskPanel">
            <h2>{language === "zh" ? "经验记忆" : "Experience memory"}</h2>
            <p className="mutedText">
              {language === "zh"
                ? "任务历史、产物、评审和最终总结会沉淀为可复用经验。写入前由用户确认，避免错误经验自动扩散。"
                : "Job history, artifacts, reviews, and final summaries become reusable experience after user review, so weak conclusions do not spread automatically."}
            </p>
            <div className="memoryStates">
              <span>{language === "zh" ? "待确认经验" : "Pending review"} <strong>{experienceSummary.candidate}</strong></span>
              <span>{language === "zh" ? "已采纳经验" : "Adopted"} <strong>{experienceSummary.adopted}</strong></span>
              <span>{language === "zh" ? "已拒绝经验" : "Rejected"} <strong>{experienceSummary.rejected}</strong></span>
            </div>
          </section>
        </div>
        <section className="deskPanel memoryWorkspace">
          <div className="panelHeader memoryToolbar">
            <div>
              <h2>{language === "zh" ? "经验候选" : "Experience candidates"}</h2>
              <p className="mutedText">
                {language === "zh"
                  ? "任务成功只会生成待确认候选；只有你采纳后，它才会成为可复用记忆。"
                  : "Successful jobs create review candidates only. They become reusable memory after you adopt them."}
              </p>
            </div>
            <button
              className="secondaryButton compactButton"
              type="button"
              onClick={() => refreshExperiences().catch((caught) => setMemoryError(caught instanceof Error ? caught.message : String(caught)))}
              disabled={apiState !== "online" || memoryBusy}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {language === "zh" ? "刷新" : "Refresh"}
            </button>
          </div>
          <div className="memoryFilters" aria-label={language === "zh" ? "经验状态筛选" : "Experience status filters"}>
            {(["candidate", "adopted", "rejected", "all"] as const).map((status) => (
              <button
                key={status}
                className={experienceFilter === status ? "memoryFilterButton active" : "memoryFilterButton"}
                type="button"
                onClick={() => setExperienceFilter(status)}
              >
                {filterLabels[status]}
              </button>
            ))}
          </div>
          {memoryError ? <p className="error">{memoryError}</p> : null}
          {memoryMessage ? <p className="successMessage">{memoryMessage}</p> : null}
          {apiState !== "online" ? (
            <div className="emptyState">
              {language === "zh" ? "后端离线，连接后即可查看经验候选。" : "The backend is offline. Connect it to review experience candidates."}
            </div>
          ) : experiences.length === 0 ? (
            <div className="emptyState">
              {language === "zh" ? "当前筛选条件下没有经验。" : "No experiences match this filter."}
            </div>
          ) : (
            <div className="experienceList" data-testid="experience-list">
              {experiences.map((experience) => (
                <article className="experienceCard" key={experience.id}>
                  <div className="experienceHeader">
                    <div>
                      <span className={`experienceStatus ${experience.status}`}>{statusLabels[experience.status]}</span>
                      <h3>{kindLabel(experience)}</h3>
                    </div>
                    <strong>{percentLabel(experience.confidence)}</strong>
                  </div>
                  <p>
                    {experience.summary}
                  </p>
                  <dl className="experienceMeta">
                    <div>
                      <dt>{language === "zh" ? "作用域" : "Scope"}</dt>
                      <dd>{scopeLabel(experience)}</dd>
                    </div>
                    <div>
                      <dt>{language === "zh" ? "来源任务" : "Source job"}</dt>
                      <dd>{experience.sourceJobId}</dd>
                    </div>
                    <div>
                      <dt>{language === "zh" ? "证据" : "Evidence"}</dt>
                      <dd>{experience.evidence.length} {language === "zh" ? "组" : "groups"}</dd>
                    </div>
                    <div>
                      <dt>{language === "zh" ? "出现次数" : "Occurrences"}</dt>
                      <dd>{experience.occurrenceCount}</dd>
                    </div>
                    <div>
                      <dt>{language === "zh" ? "效用" : "Utility"}</dt>
                      <dd>{percentLabel(experience.utilityScore)}</dd>
                    </div>
                    <div>
                      <dt>{language === "zh" ? "衰退" : "Decay"}</dt>
                      <dd>{percentLabel(experience.decayScore)}</dd>
                    </div>
                    <div>
                      <dt>{language === "zh" ? "召回" : "Recalls"}</dt>
                      <dd>{experience.recallCount}</dd>
                    </div>
                  </dl>
                  {experience.status === "candidate" ? (
                    <div className="experienceActions">
                      <button
                        className="primaryButton compactButton"
                        type="button"
                        data-testid="experience-adopt"
                        disabled={memoryBusy}
                        onClick={() => changeExperienceStatus(experience.id, "adopted")}
                      >
                        <CheckCircle2 size={14} aria-hidden="true" />
                        {language === "zh" ? "采纳" : "Adopt"}
                      </button>
                      <button
                        className="secondaryButton compactButton"
                        type="button"
                        data-testid="experience-reject"
                        disabled={memoryBusy}
                        onClick={() => changeExperienceStatus(experience.id, "rejected")}
                      >
                        <X size={14} aria-hidden="true" />
                        {language === "zh" ? "拒绝" : "Reject"}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    );
  }

  function renderSettings() {
    const archiveCopy = language === "zh"
      ? {
          title: "\u5f52\u6863",
          intro: "\u7ba1\u7406\u5df2\u5f52\u6863\u7684\u9879\u76ee\u548c\u5bf9\u8bdd\uff0c\u53ef\u4ee5\u6062\u590d\u6216\u76f4\u63a5\u5220\u9664\u5bf9\u8bdd\u3002",
          conversations: "\u5f52\u6863\u5bf9\u8bdd",
          projects: "\u5f52\u6863\u9879\u76ee",
          empty: "\u6682\u65e0\u5f52\u6863\u5185\u5bb9",
          restore: "\u6062\u590d",
          delete: "\u5f7b\u5e95\u5220\u9664"
        }
      : {
          title: "Archive",
          intro: "Manage archived projects and conversations. Conversations can be restored or deleted permanently.",
          conversations: "Archived conversations",
          projects: "Archived projects",
          empty: "Nothing archived",
          restore: "Restore",
          delete: "Delete permanently"
        };
    const archivedConversations = conversationState.projects.flatMap((project) =>
      project.threads
        .filter((thread) => thread.archivedAt)
        .map((thread) => ({ project, thread }))
    );
    const archivedProjects = conversationState.projects.filter((project) => project.archivedAt);

    return (
      <section className="deskPage utilityPage" data-tour-anchor="settings">
        <div className="pageHero compactHero">
          <div>
            <p className="eyebrow">{copy.settingsHint}</p>
            <h1>{copy.settingsView}</h1>
          </div>
        </div>
        <div className="settingsGrid">
          <form className="deskPanel securityPanel" onSubmit={saveSecuritySettings}>
            <div className="panelHeader">
              <h2>{copy.securityTitle}</h2>
              {securityRecord ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}
            </div>
            <p>{securityRecord ? copy.securityConfiguredIntro : copy.securityIntro}</p>
            {securityRecord ? (
              securityEditUnlocked ? (
                <>
                  <label>
                    {copy.newPassword}
                    <input type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} />
                  </label>
                  <label>
                    {copy.confirmPassword}
                    <input type="password" value={confirmPasswordDraft} onChange={(event) => setConfirmPasswordDraft(event.target.value)} />
                  </label>
                  <div className="securityActions">
                    <button className="primaryButton" type="submit">
                      <ShieldQuestion size={16} aria-hidden="true" />
                      {copy.savePassword}
                    </button>
                    <button className="secondaryButton" type="button" onClick={() => setSecurityRecoveryOpen((current) => !current)}>
                      {copy.changeRecoveryQuestion}
                    </button>
                    <button className="secondaryButton" type="button" onClick={() => void cancelSecurityPassword()}>
                      {copy.cancelPassword}
                    </button>
                    <button className="secondaryButton" type="button" onClick={cancelSecurityEdit}>
                      {copy.cancelModify}
                    </button>
                  </div>
                  {securityRecoveryOpen ? (
                    <div className="recoveryManagePanel">
                      <p>{recoveryQuestionLabel(securityRecord, language)}</p>
                      <label>
                        {copy.recoveryQuestion}
                        <select
                          value={recoveryQuestionChoice}
                          onChange={(event) => setRecoveryQuestionChoice(event.target.value as RecoveryQuestionId | "custom")}
                        >
                          {recoveryQuestionOptions[language].map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                          ))}
                          <option value="custom">{copy.recoveryQuestionOther}</option>
                        </select>
                      </label>
                      {recoveryQuestionChoice === "custom" ? (
                        <label>
                          {copy.customRecoveryQuestion}
                          <input value={recoveryQuestionDraft} onChange={(event) => setRecoveryQuestionDraft(event.target.value)} />
                        </label>
                      ) : null}
                      <label>
                        {copy.recoveryAnswer}
                        <input type="password" value={recoveryAnswerDraft} onChange={(event) => setRecoveryAnswerDraft(event.target.value)} />
                      </label>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <label>
                    {copy.panelPassword}
                    <input type="password" value={currentPasswordDraft} onChange={(event) => setCurrentPasswordDraft(event.target.value)} />
                  </label>
                  <button className="primaryButton" type="submit">
                    <ShieldQuestion size={16} aria-hidden="true" />
                    {copy.savePassword}
                  </button>
                </>
              )
            ) : (
              <>
                <label>
                  {copy.password}
                  <input type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} />
                </label>
                <label>
                  {copy.confirmPassword}
                  <input type="password" value={confirmPasswordDraft} onChange={(event) => setConfirmPasswordDraft(event.target.value)} />
                </label>
                <label>
                  {copy.recoveryQuestion}
                  <select
                    value={recoveryQuestionChoice}
                    onChange={(event) => setRecoveryQuestionChoice(event.target.value as RecoveryQuestionId | "custom")}
                  >
                    {recoveryQuestionOptions[language].map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                    <option value="custom">{copy.recoveryQuestionOther}</option>
                  </select>
                </label>
                {recoveryQuestionChoice === "custom" ? (
                  <label>
                    {copy.customRecoveryQuestion}
                    <input value={recoveryQuestionDraft} onChange={(event) => setRecoveryQuestionDraft(event.target.value)} />
                  </label>
                ) : null}
                <label>
                  {copy.recoveryAnswer}
                  <input type="password" value={recoveryAnswerDraft} onChange={(event) => setRecoveryAnswerDraft(event.target.value)} />
                </label>
              </>
            )}
            {settingsError ? <p className="error">{settingsError}</p> : null}
            {settingsMessage ? <p className="successMessage">{settingsMessage}</p> : null}
            {!securityRecord ? (
              <button className="primaryButton" type="submit">
                <ShieldQuestion size={16} aria-hidden="true" />
                {copy.saveSecurity}
              </button>
            ) : null}
          </form>

          <section className="deskPanel">
            <div className="panelHeader">
              <h2>{copy.languageLabel}</h2>
              <Languages size={18} aria-hidden="true" />
            </div>
            <div className="languageToggle" role="group" aria-label={copy.languageLabel}>
              {languageOptions.map((option) => (
                <button
                  key={option.id}
                  className={option.id === language ? "languageButton active" : "languageButton"}
                  type="button"
                  onClick={() => setLanguage(option.id)}
                  aria-pressed={option.id === language}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section className="deskPanel">
            <div className="panelHeader">
              <div>
                <h2>{copy.outputStyleTitle}</h2>
                <p className="mutedText">{copy.outputStyleIntro}</p>
              </div>
              <MessageSquare size={18} aria-hidden="true" />
            </div>
            <div className="languageToggle" role="group" aria-label={copy.outputStyleTitle}>
              {panelOutputStyles.map((style) => (
                <button
                  key={style}
                  className={style === panelOutputStyle ? "languageButton active" : "languageButton"}
                  type="button"
                  onClick={() => changePanelOutputStyle(style)}
                  aria-pressed={style === panelOutputStyle}
                >
                  {copy.outputStyles[style]}
                </button>
              ))}
            </div>
            {outputStyleMessage ? <p className="successMessage">{outputStyleMessage}</p> : null}
          </section>

          <section className="deskPanel archivePanel">
            <div className="panelHeader">
              <div>
                <h2>{archiveCopy.title}</h2>
                <p className="mutedText">{archiveCopy.intro}</p>
              </div>
              <Archive size={18} aria-hidden="true" />
            </div>
            {!archivedConversations.length && !archivedProjects.length ? (
              <p className="emptyState compactEmpty">{archiveCopy.empty}</p>
            ) : null}
            {archivedConversations.length ? (
              <div className="archiveList">
                <strong>{archiveCopy.conversations}</strong>
                {archivedConversations.map(({ project, thread }) => (
                  <article key={thread.id}>
                    <span>
                      <b>{thread.title}</b>
                      <small>{project.name} / {formatTime(thread.archivedAt, language)}</small>
                    </span>
                    <button className="secondaryButton compactButton" type="button" onClick={() => restoreConversation(project.id, thread.id)}>
                      <RefreshCw size={13} aria-hidden="true" />
                      {archiveCopy.restore}
                    </button>
                    <button className="dangerButton compactButton" type="button" onClick={() => requestDeleteConversation(project.id, thread.id)}>
                      <Trash2 size={13} aria-hidden="true" />
                      {archiveCopy.delete}
                    </button>
                  </article>
                ))}
              </div>
            ) : null}
            {archivedProjects.length ? (
              <div className="archiveList">
                <strong>{archiveCopy.projects}</strong>
                {archivedProjects.map((project) => (
                  <article key={project.id}>
                    <span>
                      <b>{project.name}</b>
                      <small>{[project.path, formatTime(project.archivedAt, language)].filter(Boolean).join(" / ")}</small>
                    </span>
                    <button className="secondaryButton compactButton" type="button" onClick={() => restoreProject(project.id)}>
                      <RefreshCw size={13} aria-hidden="true" />
                      {archiveCopy.restore}
                    </button>
                    <button className="dangerButton compactButton" type="button" onClick={() => requestDeleteProject(project.id)}>
                      <Trash2 size={13} aria-hidden="true" />
                      {archiveCopy.delete}
                    </button>
                  </article>
                ))}
              </div>
            ) : null}
          </section>

          <section className="deskPanel resetPanel">
            <div className="panelHeader">
              <h2>{copy.resetTitle}</h2>
              <RefreshCw size={18} aria-hidden="true" />
            </div>
            <p>{copy.resetIntro}</p>
            <div className="resetActions">
              <button
                className="secondaryButton resetActionButton"
                type="button"
                onClick={() => {
                  setResetFlow("panelAgent");
                  setActiveView("setup");
                }}
              >
                <Sparkles size={16} aria-hidden="true" />
                <span>
                  <strong>{copy.resetPanelAgent}</strong>
                  <small>{copy.resetPanelAgentHint}</small>
                </span>
              </button>
              <button
                className="secondaryButton resetActionButton"
                type="button"
                onClick={() => {
                  setResetFlow("workProfile");
                  setActiveView("setup");
                }}
              >
                <Bot size={16} aria-hidden="true" />
                <span>
                  <strong>{copy.resetWorkProfile}</strong>
                  <small>{copy.resetWorkProfileHint}</small>
                </span>
              </button>
            </div>
          </section>
        </div>
      </section>
    );
  }

  function renderArchiveDeleteDialog() {
    if (!archiveDeleteTarget) return null;
    const title = language === "zh"
      ? archiveDeleteTarget.kind === "conversation"
        ? "\u5220\u9664\u5df2\u5f52\u6863\u804a\u5929\uff1f"
        : archiveDeleteTarget.archived
          ? "\u5220\u9664\u5df2\u5f52\u6863\u9879\u76ee\uff1f"
          : "\u5220\u9664\u9879\u76ee\uff1f"
      : archiveDeleteTarget.kind === "conversation"
        ? "Delete archived chat?"
        : archiveDeleteTarget.archived
          ? "Delete archived project?"
          : "Delete project?";
    const body = language === "zh"
      ? archiveDeleteTarget.kind === "conversation"
        ? "\u8fd9\u4f1a\u4ece\u672c\u673a\u5f7b\u5e95\u5220\u9664\u8fd9\u4e2a\u5df2\u5f52\u6863\u804a\u5929\uff0c\u65e0\u6cd5\u6062\u590d\u3002"
        : "\u8fd9\u4f1a\u4ece\u672c\u673a\u5f7b\u5e95\u5220\u9664\u8fd9\u4e2a\u9879\u76ee\u548c\u5176\u5bf9\u8bdd\uff0c\u65e0\u6cd5\u6062\u590d\u3002"
      : archiveDeleteTarget.kind === "conversation"
        ? "This permanently deletes the archived chat from this device. It cannot be restored."
        : "This permanently deletes the project and its conversations from this device. It cannot be restored.";
    const cancelLabel = language === "zh" ? "\u53d6\u6d88" : "Cancel";
    const deleteLabel = language === "zh" ? "\u5f7b\u5e95\u5220\u9664" : "Delete permanently";

    return (
      <div
        className="archiveDeleteOverlay"
        data-testid="archive-delete-dialog"
        onClick={(event) => {
          if (event.currentTarget === event.target) {
            setArchiveDeleteTarget(null);
          }
        }}
      >
        <section className="archiveDeleteDialog" role="dialog" aria-modal="true" aria-labelledby="archive-delete-title">
          <button className="archiveDeleteClose" type="button" aria-label={cancelLabel} onClick={() => setArchiveDeleteTarget(null)}>
            <X size={16} aria-hidden="true" />
          </button>
          <div className="archiveDeleteIcon">
            <Trash2 size={20} aria-hidden="true" />
          </div>
          <h2 id="archive-delete-title">{title}</h2>
          <p>{body}</p>
          <div className="archiveDeleteTarget">
            <b>{archiveDeleteTarget.title}</b>
            <small>{archiveDeleteTarget.subtitle}</small>
          </div>
          <div className="archiveDeleteActions">
            <button className="secondaryButton" type="button" onClick={() => setArchiveDeleteTarget(null)}>
              {cancelLabel}
            </button>
            <button className="dangerButton" type="button" onClick={confirmArchiveDelete}>
              <Trash2 size={15} aria-hidden="true" />
              {deleteLabel}
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderTextInputDialog() {
    if (!textInputDialog) return null;
    const titleId = "text-input-dialog-title";

    return (
      <div
        className="archiveDeleteOverlay textInputOverlay"
        data-testid="text-input-dialog"
        onClick={(event) => {
          if (event.currentTarget === event.target) {
            resolveTextInputDialog(null);
          }
        }}
      >
        <form
          className="textInputDialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onSubmit={(event) => {
            event.preventDefault();
            resolveTextInputDialog(textInputDialog.value);
          }}
        >
          <button className="archiveDeleteClose" type="button" aria-label={textInputDialog.cancelLabel} onClick={() => resolveTextInputDialog(null)}>
            <X size={16} aria-hidden="true" />
          </button>
          <h2 id={titleId}>{textInputDialog.title}</h2>
          <label>
            <span>{textInputDialog.label}</span>
            <input
              autoFocus
              value={textInputDialog.value}
              placeholder={textInputDialog.placeholder}
              onChange={(event) => setTextInputDialog((current) => current ? { ...current, value: event.target.value } : current)}
            />
          </label>
          <div className="archiveDeleteActions">
            <button className="secondaryButton" type="button" onClick={() => resolveTextInputDialog(null)}>
              {textInputDialog.cancelLabel}
            </button>
            <button className="primaryButton" type="submit" disabled={!textInputDialog.value.trim()}>
              {textInputDialog.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    );
  }

  function renderActiveView() {
    if (resetFlow) {
      return (
        <FirstRunPanel
          language={language}
          flow={resetFlow}
          onCancel={() => {
            setResetFlow(null);
            setActiveView("settings");
          }}
          onComplete={() => {
            setResetFlow(null);
            const refreshedPreview = loadFirstRunPreview();
            setFirstRunPreview(refreshedPreview);
            setPanelOutputStyle(loadPanelOutputStyle(refreshedPreview));
            setSetupComplete(true);
            setShowTour(false);
            setActiveView("settings");
          }}
        />
      );
    }
    if (!setupComplete && !showTour) {
      return (
        <FirstRunPanel
          language={language}
          onComplete={(nextView) => {
            const refreshedPreview = loadFirstRunPreview();
            setFirstRunPreview(refreshedPreview);
            setPanelOutputStyle(loadPanelOutputStyle(refreshedPreview));
            setSetupComplete(true);
            setActiveView(nextView ?? "dashboard");
            setShowTour(window.localStorage.getItem("honeycomb.tourCompleted") !== "true");
          }}
        />
      );
    }
    if (activeView === "dashboard") return renderDashboard();
    if (activeView === "setup" && !setupComplete) {
      return (
        <FirstRunPanel
          language={language}
          onComplete={(nextView) => {
            const refreshedPreview = loadFirstRunPreview();
            setFirstRunPreview(refreshedPreview);
            setPanelOutputStyle(loadPanelOutputStyle(refreshedPreview));
            setSetupComplete(true);
            setActiveView(nextView ?? "dashboard");
            setShowTour(window.localStorage.getItem("honeycomb.tourCompleted") !== "true");
          }}
        />
      );
    }
    if (activeView === "setup") return renderDashboard();
    if (activeView === "conversations") return renderConversations();
    if (activeView === "jobs") return renderJobs();
    if (activeView === "approvals") return renderApprovals();
    if (activeView === "agents") return renderAgents();
    if (activeView === "models") return renderModels();
    if (activeView === "memory") return renderMemory();
    return renderSettings();
  }

  return (
    <main className={`shell darkShell ${sideCollapsed ? "sideCollapsed" : ""}`}>
      <aside className="activityRail" data-tour-anchor="activity">
        <div className="railBrand">
          <HoneycombLogo size={30} />
        </div>
        <nav aria-label="Primary">
          <button
            className="railButton"
            data-testid="sidebar-toggle"
            type="button"
            title={sideCollapsed ? (language === "zh" ? "展开侧栏" : "Expand sidebar") : (language === "zh" ? "收起侧栏" : "Collapse sidebar")}
            aria-label={sideCollapsed ? (language === "zh" ? "展开侧栏" : "Expand sidebar") : (language === "zh" ? "收起侧栏" : "Collapse sidebar")}
            onClick={() => setSideCollapsed((current) => !current)}
          >
            {sideCollapsed ? <PanelLeftOpen size={20} aria-hidden="true" /> : <PanelLeftClose size={20} aria-hidden="true" />}
          </button>
          {primaryNav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={activeView === item.id ? "railButton active" : "railButton"}
                data-testid={
                  item.id === "setup"
                    ? "setup-view-tab"
                    : item.id === "conversations"
                      ? "conversation-view-tab"
                      : item.id === "jobs"
                        ? "console-view-tab"
                        : undefined
                }
                type="button"
                title={item.label}
                aria-label={item.label}
                onClick={() => setActiveView(item.id)}
              >
                <Icon size={20} aria-hidden="true" />
              </button>
            );
          })}
        </nav>
        <div className="railBottom">
          {setupComplete || showTour ? (
            <button className="railButton" type="button" title={copy.settingsView} aria-label={copy.settingsView} onClick={() => setActiveView("settings")}>
              <Settings size={20} aria-hidden="true" />
            </button>
          ) : null}
          <button className="railButton" type="button" title={copy.languageLabel} aria-label={copy.languageLabel} onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>
            <Languages size={20} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <aside className="sideBar" aria-hidden={sideCollapsed}>
        <div className="sideHeader">
          <div>
            <strong>{copy.appName}</strong>
            <small>{copy.subtitle}</small>
          </div>
        </div>
        <nav className="sideNav" aria-label="Sections">
          {[copy.navGroups.operate, copy.navGroups.build].map((group) => (
            <div className="navGroup" key={group}>
              <span>{group}</span>
              {primaryNav.filter((item) => item.group === group).map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={activeView === item.id ? "navItem active" : "navItem"}
                    data-testid={
                      item.id === "setup"
                        ? "setup-view-tab-secondary"
                        : item.id === "conversations"
                          ? "conversation-view-tab-secondary"
                          : item.id === "jobs"
                            ? "console-view-tab-secondary"
                            : undefined
                    }
                    type="button"
                    onClick={() => setActiveView(item.id)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sideFooter">
          <span className={`status ${apiState}`}>{statusText}</span>
          <button className="secondaryButton compactButton" type="button" onClick={() => void refreshFromBackend()} disabled={busy || manualRefreshBusy}>
            <RefreshCw size={15} aria-hidden="true" />
            {copy.refresh}
          </button>
        </div>
      </aside>

      <section className="workspace">{renderActiveView()}</section>

      {renderArchiveDeleteDialog()}
      {renderTextInputDialog()}

      {showTour ? (
        <div className="tourOverlay" data-anchor={tourStep.anchor satisfies TourAnchor}>
          <div className="tourCard">
            <button className="tourClose" type="button" aria-label={copy.tourSkip} onClick={completeTour}>
              <X size={16} aria-hidden="true" />
            </button>
            <div className="tourMark">
              <HoneycombLogo size={42} mode="talking" />
              <span>{copy.tourProgress} {tourIndex + 1} / {copy.tourSteps.length}</span>
            </div>
            <h2>{tourStep.title}</h2>
            <p>{tourStep.body}</p>
            <div className="tourActions">
              <button className="textButton" type="button" onClick={completeTour}>
                {copy.tourSkip}
              </button>
              <button
                className="primaryButton"
                type="button"
                onClick={() => {
                  if (tourIndex >= copy.tourSteps.length - 1) {
                    completeTour();
                    return;
                  }
                  const nextIndex = tourIndex + 1;
                  setTourIndex(nextIndex);
                  const nextAnchor = copy.tourSteps[nextIndex].anchor;
                  if (nextAnchor === "jobs") setActiveView("jobs");
                  if (nextAnchor === "settings") setActiveView("settings");
                  if (nextAnchor === "dashboard" || nextAnchor === "activity") setActiveView("dashboard");
                }}
              >
                {tourIndex >= copy.tourSteps.length - 1 ? copy.tourDone : copy.tourNext}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
