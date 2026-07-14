import type { ModelCallLeaseRecoveryClassification } from "./execution-lease-policy";
import type {
  ArtifactDeliveryRecord,
  JobRecord,
  JobStatus,
  RoutingMode,
  StageRecord,
  StageStatus,
  TaskPlanWithItems,
  ToolApprovalRecord
} from "./types";

export const JOB_EXECUTION_PHASES = [
  "created",
  "queued",
  "planning",
  "running",
  "testing",
  "fixing",
  "retry_waiting",
  "waiting_for_approval",
  "waiting_for_reconciliation",
  "waiting_for_delivery",
  "waiting_for_human",
  "stalled",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export type JobExecutionPhase = (typeof JOB_EXECUTION_PHASES)[number];

export const AGENT_EXECUTION_STATES = [
  "pending",
  "queued",
  "running",
  "testing",
  "fixing",
  "retry_waiting",
  "waiting_for_approval",
  "waiting_for_human",
  "stalled",
  "completed",
  "failed",
  "cancelled",
  "skipped"
] as const;

export type AgentExecutionState = (typeof AGENT_EXECUTION_STATES)[number];

export type JobExecutionRecommendedAction =
  | "reconcile_model_call"
  | "approve_tool"
  | "configure_agent_runtime"
  | "increase_spend_limit"
  | "authorize_delivery_destination"
  | "retry_artifact_delivery"
  | "wait_for_delivery"
  | "scan_expired_model_calls"
  | "resume_job"
  | "review_task";

export type JobExecutionBlockerCode =
  | "model_call_reconciliation_required"
  | "tool_approval_required"
  | "agent_runtime_configuration_blocked"
  | "spend_limit_blocked"
  | "artifact_delivery_authorization_required"
  | "artifact_delivery_failed"
  | "artifact_delivery_pending"
  | "execution_stalled"
  | "job_waiting_for_human"
  | "job_failed";

export type JobExecutionModelCallActivity = {
  id: string;
  idempotencyKey: string;
  stageId: string | null;
  agentId: string;
  actionType: string;
  status: "started" | "retry_waiting" | "succeeded" | "failed" | "failed_unknown_outcome" | "cancelled";
  classification: ModelCallLeaseRecoveryClassification;
  providerId: string | null;
  model: string | null;
  leaseExpiresAt: string | null;
  recoveryStatus: string | null;
  error: string | null;
  updatedAt: string;
};

export type JobExecutionQueueActivity = {
  id: string;
  requestKey: string;
  stageId: string | null;
  agentId: string;
  providerId: string;
  status: "queued" | "acquired";
  queuedAt: string;
  acquiredAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
};

export type JobExecutionArtifactInventory = {
  artifactCount: number;
  fileCount: number;
  availableFileCount: number;
  failedFileCount: number;
};

export type JobExecutionApprovalActivity = {
  id: string;
  stageId: string | null;
  agentId: string;
  toolName: string;
  actionType: string;
  riskLevel: ToolApprovalRecord["riskLevel"];
  reason: string | null;
  target: string | null;
  status: "pending";
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type JobExecutionStateInput = {
  generatedAt: string;
  job: Pick<
    JobRecord,
    | "id"
    | "displayTitle"
    | "status"
    | "routingMode"
    | "workflowId"
    | "orchestrationPlan"
    | "executionPreflight"
    | "executionQueue"
    | "executionRetry"
    | "spendBudget"
    | "heartbeatAt"
    | "heartbeatStatus"
    | "heartbeatSource"
    | "heartbeatNote"
    | "stalledAt"
    | "createdAt"
    | "updatedAt"
    | "completedAt"
  >;
  stages: StageRecord[];
  plan: TaskPlanWithItems | null;
  pendingApprovals: ToolApprovalRecord[];
  modelCalls: JobExecutionModelCallActivity[];
  queues: JobExecutionQueueActivity[];
  deliveries: ArtifactDeliveryRecord[];
  artifacts: JobExecutionArtifactInventory;
};

export type JobExecutionCurrentAction = {
  kind:
    | "coordination"
    | "stage"
    | "quality_gate"
    | "model_call"
    | "queue"
    | "retry"
    | "approval"
    | "configuration"
    | "idle";
  status: string;
  stageId: string | null;
  actionType: string | null;
  providerId: string | null;
  model: string | null;
  since: string | null;
  retryAt: string | null;
};

export type JobExecutionAgentState = {
  agentId: string;
  roles: Array<"coordinator" | "production" | "quality_gate" | "skipped">;
  state: AgentExecutionState;
  stageIds: string[];
  activeStageIds: string[];
  completedStageCount: number;
  totalStageCount: number;
  currentAction: JobExecutionCurrentAction;
  lastError: string | null;
  skippedReason: string | null;
  updatedAt: string;
};

export type JobExecutionBlocker = {
  code: JobExecutionBlockerCode;
  severity: "warning" | "action_required" | "error";
  source: "model_call" | "approval" | "preflight" | "budget" | "delivery" | "heartbeat" | "job";
  agentIds: string[];
  sourceIds: string[];
  detail: string | null;
  recommendedAction: JobExecutionRecommendedAction;
};

export type JobExecutionState = {
  version: "honeycomb.job-execution-state.v1";
  generatedAt: string;
  job: {
    id: string;
    displayTitle: string;
    status: JobStatus;
    phase: JobExecutionPhase;
    routingMode: RoutingMode;
    workflowId: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  };
  progress: {
    percent: number;
    totalStages: number;
    completedStages: number;
    activeStages: number;
    blockedStages: number;
    currentStageIds: string[];
    currentAgentIds: string[];
  };
  stages: StageRecord[];
  agents: JobExecutionAgentState[];
  plan: TaskPlanWithItems | null;
  runtime: {
    heartbeat: {
      status: JobRecord["heartbeatStatus"];
      at: string | null;
      source: string | null;
      note: string | null;
      stalledAt: string | null;
    };
    modelCalls: {
      total: number;
      active: number;
      retryWaiting: number;
      reconciliationRequired: number;
      providerResumeAvailable: number;
      calls: JobExecutionModelCallActivity[];
    };
    queues: {
      queued: number;
      acquired: number;
      entries: JobExecutionQueueActivity[];
    };
    approvals: {
      pending: number;
      entries: JobExecutionApprovalActivity[];
    };
    artifacts: JobExecutionArtifactInventory;
    deliveries: {
      required: number;
      succeeded: number;
      pending: number;
      delivering: number;
      failed: number;
      authorizationRequired: number;
    };
    spend: JobRecord["spendBudget"];
  };
  blockers: JobExecutionBlocker[];
  primaryBlocker: JobExecutionBlocker | null;
  recommendedActions: JobExecutionRecommendedAction[];
};

const COMPLETED_STAGE_STATUSES = new Set<StageStatus>(["completed", "test_passed", "skipped"]);
const ACTIVE_STAGE_STATUSES = new Set<StageStatus>(["running", "test_pending", "test_failed", "fixing"]);
const BLOCKED_STAGE_STATUSES = new Set<StageStatus>(["waiting_for_human", "failed"]);

function stageProgress(status: StageStatus) {
  switch (status) {
    case "pending":
      return 0;
    case "running":
      return 0.35;
    case "test_pending":
      return 0.75;
    case "test_failed":
    case "fixing":
    case "waiting_for_human":
      return 0.65;
    case "completed":
    case "test_passed":
    case "failed":
    case "skipped":
      return 1;
  }
}

function fallbackProgress(status: JobStatus) {
  switch (status) {
    case "created": return 0;
    case "queued": return 5;
    case "planning": return 15;
    case "running": return 45;
    case "testing": return 80;
    case "fixing": return 70;
    case "waiting_for_human": return 60;
    case "succeeded": return 100;
    case "failed": return 100;
    case "cancelled": return 0;
  }
}

function stageAgentState(stages: StageRecord[]): AgentExecutionState {
  const statuses = new Set(stages.map((stage) => stage.status));
  if (statuses.has("failed")) return "failed";
  if (statuses.has("waiting_for_human")) return "waiting_for_human";
  if (statuses.has("fixing") || statuses.has("test_failed")) return "fixing";
  if (statuses.has("test_pending")) return "testing";
  if (statuses.has("running")) return "running";
  if (statuses.has("pending")) return "pending";
  if (stages.some((stage) => stage.status !== "skipped")) return "completed";
  return "skipped";
}

function coordinatorState(status: JobStatus): AgentExecutionState {
  switch (status) {
    case "created": return "pending";
    case "queued": return "queued";
    case "planning":
    case "running": return "running";
    case "testing": return "testing";
    case "fixing": return "fixing";
    case "waiting_for_human": return "waiting_for_human";
    case "succeeded": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
  }
}

function latestByUpdatedAt<T extends { updatedAt: string }>(entries: T[]) {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

function action(input: Partial<JobExecutionCurrentAction> & Pick<JobExecutionCurrentAction, "kind" | "status">): JobExecutionCurrentAction {
  return {
    kind: input.kind,
    status: input.status,
    stageId: input.stageId ?? null,
    actionType: input.actionType ?? null,
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    since: input.since ?? null,
    retryAt: input.retryAt ?? null
  };
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

export function projectJobExecutionState(input: JobExecutionStateInput): JobExecutionState {
  const stages = [...input.stages].sort((left, right) => left.stageIndex - right.stageIndex);
  const reconciliationCalls = input.modelCalls.filter(
    (call) => call.status === "failed_unknown_outcome" || call.classification === "reconciliation_required"
  );
  const providerResumeCalls = input.modelCalls.filter(
    (call) => call.classification === "provider_resume_available"
  );
  const activeCalls = input.modelCalls.filter(
    (call) => call.status === "started" && call.classification === "active"
  );
  const retryCalls = input.modelCalls.filter((call) => call.status === "retry_waiting");
  const requiredDeliveries = input.deliveries.filter((delivery) => delivery.required && delivery.status !== "cancelled");
  const failedDeliveries = requiredDeliveries.filter((delivery) => delivery.status === "failed");
  const authorizationBlockedDeliveries = requiredDeliveries.filter(
    (delivery) => delivery.status !== "succeeded" && delivery.authorizationStatus !== "authorized"
  );
  const pendingDeliveries = requiredDeliveries.filter((delivery) => delivery.status === "pending");
  const deliveringDeliveries = requiredDeliveries.filter((delivery) => delivery.status === "delivering");
  const completedDeliveries = requiredDeliveries.filter((delivery) => delivery.status === "succeeded");

  const blockers: JobExecutionBlocker[] = [];
  const addBlocker = (blocker: JobExecutionBlocker) => {
    if (!blockers.some((current) => current.code === blocker.code)) blockers.push(blocker);
  };

  if (reconciliationCalls.length > 0) {
    addBlocker({
      code: "model_call_reconciliation_required",
      severity: "action_required",
      source: "model_call",
      agentIds: unique(reconciliationCalls.map((call) => call.agentId)),
      sourceIds: reconciliationCalls.map((call) => call.id),
      detail: reconciliationCalls[0]?.error ?? null,
      recommendedAction: "reconcile_model_call"
    });
  }
  if (input.pendingApprovals.length > 0) {
    addBlocker({
      code: "tool_approval_required",
      severity: "action_required",
      source: "approval",
      agentIds: unique(input.pendingApprovals.map((approval) => approval.agentId)),
      sourceIds: input.pendingApprovals.map((approval) => approval.id),
      detail: input.pendingApprovals[0]?.reason ?? null,
      recommendedAction: "approve_tool"
    });
  }
  if (input.job.executionPreflight?.status === "blocked") {
    addBlocker({
      code: "agent_runtime_configuration_blocked",
      severity: "action_required",
      source: "preflight",
      agentIds: unique(input.job.executionPreflight.blockingIssues.map((issue) => issue.agentId)),
      sourceIds: input.job.executionPreflight.blockingIssues.map((issue) => issue.code),
      detail: input.job.executionPreflight.blockingIssues[0]?.message ?? null,
      recommendedAction: "configure_agent_runtime"
    });
  }
  if (input.job.spendBudget.blocked) {
    addBlocker({
      code: "spend_limit_blocked",
      severity: "action_required",
      source: "budget",
      agentIds: [],
      sourceIds: input.job.spendBudget.blockingScope ? [input.job.spendBudget.blockingScope] : [],
      detail: input.job.spendBudget.blockingReason,
      recommendedAction: "increase_spend_limit"
    });
  }
  if (authorizationBlockedDeliveries.length > 0) {
    addBlocker({
      code: "artifact_delivery_authorization_required",
      severity: "action_required",
      source: "delivery",
      agentIds: [],
      sourceIds: authorizationBlockedDeliveries.map((delivery) => delivery.id),
      detail: authorizationBlockedDeliveries[0]?.authorizationError ?? null,
      recommendedAction: "authorize_delivery_destination"
    });
  }
  if (failedDeliveries.length > 0) {
    addBlocker({
      code: "artifact_delivery_failed",
      severity: "action_required",
      source: "delivery",
      agentIds: [],
      sourceIds: failedDeliveries.map((delivery) => delivery.id),
      detail: failedDeliveries[0]?.lastError ?? null,
      recommendedAction: "retry_artifact_delivery"
    });
  }
  if (
    input.job.status === "waiting_for_human" &&
    pendingDeliveries.length + deliveringDeliveries.length > 0
  ) {
    addBlocker({
      code: "artifact_delivery_pending",
      severity: "warning",
      source: "delivery",
      agentIds: [],
      sourceIds: [...pendingDeliveries, ...deliveringDeliveries].map((delivery) => delivery.id),
      detail: input.job.heartbeatNote,
      recommendedAction: "wait_for_delivery"
    });
  }
  if (providerResumeCalls.length > 0 || input.job.heartbeatStatus === "stalled") {
    addBlocker({
      code: "execution_stalled",
      severity: "warning",
      source: "heartbeat",
      agentIds: unique(providerResumeCalls.map((call) => call.agentId)),
      sourceIds: providerResumeCalls.map((call) => call.id),
      detail: input.job.heartbeatNote,
      recommendedAction: providerResumeCalls.length > 0 ? "resume_job" : "scan_expired_model_calls"
    });
  }
  if (input.job.status === "waiting_for_human" && blockers.length === 0) {
    addBlocker({
      code: "job_waiting_for_human",
      severity: "action_required",
      source: "job",
      agentIds: [],
      sourceIds: [],
      detail: input.job.heartbeatNote,
      recommendedAction: "review_task"
    });
  }
  if (["succeeded", "failed", "cancelled"].includes(input.job.status)) {
    blockers.length = 0;
    if (input.job.status === "failed") {
      addBlocker({
        code: "job_failed",
        severity: "error",
        source: "job",
        agentIds: [],
        sourceIds: [],
        detail: input.job.heartbeatNote,
        recommendedAction: "review_task"
      });
    }
  }

  let phase: JobExecutionPhase;
  if (["succeeded", "failed", "cancelled"].includes(input.job.status)) {
    phase = input.job.status as JobExecutionPhase;
  } else if (reconciliationCalls.length > 0) {
    phase = "waiting_for_reconciliation";
  } else if (input.pendingApprovals.length > 0) {
    phase = "waiting_for_approval";
  } else if (input.job.executionPreflight?.status === "blocked" || input.job.spendBudget.blocked) {
    phase = "waiting_for_human";
  } else if (
    input.job.status === "waiting_for_human" &&
    (requiredDeliveries.length > completedDeliveries.length)
  ) {
    phase = "waiting_for_delivery";
  } else if (providerResumeCalls.length > 0 || input.job.heartbeatStatus === "stalled") {
    phase = "stalled";
  } else if (input.job.executionRetry || retryCalls.length > 0) {
    phase = "retry_waiting";
  } else if (input.queues.some((entry) => entry.status === "queued") || input.job.executionQueue?.status === "queued") {
    phase = "queued";
  } else {
    phase = input.job.status;
  }

  const agentIds: string[] = [];
  const roles = new Map<string, Set<JobExecutionAgentState["roles"][number]>>();
  const skipReasons = new Map<string, string>();
  const registerAgent = (agentId: string | null | undefined, role: JobExecutionAgentState["roles"][number]) => {
    if (!agentId) return;
    if (!agentIds.includes(agentId)) agentIds.push(agentId);
    const current = roles.get(agentId) ?? new Set<JobExecutionAgentState["roles"][number]>();
    current.add(role);
    roles.set(agentId, current);
  };

  registerAgent("main-agent", "coordinator");
  for (const agentId of input.job.orchestrationPlan?.selectedAgents ?? []) registerAgent(agentId, "production");
  for (const stage of stages) registerAgent(stage.agentId, "production");
  registerAgent(input.job.orchestrationPlan?.qualityGate.agentId, "quality_gate");
  for (const approval of input.pendingApprovals) registerAgent(approval.agentId, "production");
  for (const call of input.modelCalls) registerAgent(call.agentId, "production");
  for (const queue of input.queues) registerAgent(queue.agentId, "production");
  registerAgent(input.job.executionQueue?.agentId, "production");
  registerAgent(input.job.executionRetry?.agentId, "production");
  for (const preflightAgent of input.job.executionPreflight?.agents ?? []) {
    registerAgent(
      preflightAgent.agentId,
      preflightAgent.purpose === "quality_gate"
        ? "quality_gate"
        : preflightAgent.purpose === "synthesis"
          ? "coordinator"
          : "production"
    );
  }
  for (const skipped of input.job.orchestrationPlan?.skippedAgents ?? []) {
    registerAgent(skipped.agentId, "skipped");
    skipReasons.set(skipped.agentId, skipped.reason);
  }

  const qualityGateAgentId = input.job.orchestrationPlan?.qualityGate.agentId ?? null;
  const agents = agentIds.map((agentId): JobExecutionAgentState => {
    const agentStages = stages.filter((stage) => stage.agentId === agentId);
    const agentApprovals = input.pendingApprovals.filter((approval) => approval.agentId === agentId);
    const agentCalls = input.modelCalls.filter((call) => call.agentId === agentId);
    const agentReconciliation = agentCalls.filter(
      (call) => call.status === "failed_unknown_outcome" || call.classification === "reconciliation_required"
    );
    const agentProviderResume = agentCalls.filter((call) => call.classification === "provider_resume_available");
    const agentRetry = input.job.executionRetry?.agentId === agentId
      ? input.job.executionRetry
      : null;
    const agentPreflightIssues = input.job.executionPreflight?.blockingIssues.filter(
      (issue) => issue.agentId === agentId
    ) ?? [];
    const persistedQueue = input.job.executionQueue?.agentId === agentId
      ? input.job.executionQueue
      : null;
    const latestRetryCall = latestByUpdatedAt(agentCalls.filter((call) => call.status === "retry_waiting"));
    const latestQueue = latestByUpdatedAt(input.queues.filter((queue) => queue.agentId === agentId));
    const latestActiveCall = latestByUpdatedAt(agentCalls.filter(
      (call) => call.status === "started" && call.classification === "active"
    ));
    const latestStage = latestByUpdatedAt(agentStages);

    let state = agentId === "main-agent"
      ? coordinatorState(input.job.status)
      : agentStages.length > 0
        ? stageAgentState(agentStages)
        : skipReasons.has(agentId)
          ? "skipped" as const
          : "pending" as const;
    let currentAction = agentId === "main-agent"
      ? action({ kind: "coordination", status: input.job.status, since: input.job.updatedAt })
      : latestStage
        ? action({ kind: "stage", status: latestStage.status, stageId: latestStage.id, since: latestStage.updatedAt })
        : action({ kind: "idle", status: state, since: input.job.createdAt });

    if (qualityGateAgentId === agentId && agentStages.length === 0) {
      const testingStage = latestByUpdatedAt(stages.filter((stage) => stage.status === "test_pending"));
      const failedTestStage = latestByUpdatedAt(stages.filter(
        (stage) => stage.status === "test_failed" || stage.status === "fixing"
      ));
      const passedStages = stages.filter((stage) => COMPLETED_STAGE_STATUSES.has(stage.status));
      if (testingStage) {
        state = "testing";
        currentAction = action({ kind: "quality_gate", status: "test_pending", stageId: testingStage.id, since: testingStage.updatedAt });
      } else if (failedTestStage) {
        state = "pending";
        currentAction = action({ kind: "quality_gate", status: "waiting_for_fix", stageId: failedTestStage.id, since: failedTestStage.updatedAt });
      } else if (stages.length > 0 && passedStages.length === stages.length) {
        state = "completed";
        currentAction = action({ kind: "quality_gate", status: "completed", since: latestStage?.updatedAt ?? input.job.updatedAt });
      }
    }

    if (agentReconciliation.length > 0) {
      const call = latestByUpdatedAt(agentReconciliation)!;
      state = "waiting_for_human";
      currentAction = action({
        kind: "model_call",
        status: "reconciliation_required",
        stageId: call.stageId,
        actionType: call.actionType,
        providerId: call.providerId,
        model: call.model,
        since: call.updatedAt
      });
    } else if (agentApprovals.length > 0) {
      const approval = latestByUpdatedAt(agentApprovals)!;
      state = "waiting_for_approval";
      currentAction = action({
        kind: "approval",
        status: approval.actionType,
        stageId: approval.stageId,
        actionType: approval.toolName,
        since: approval.createdAt
      });
    } else if (agentProviderResume.length > 0) {
      const call = latestByUpdatedAt(agentProviderResume)!;
      state = "stalled";
      currentAction = action({
        kind: "model_call",
        status: "provider_resume_available",
        stageId: call.stageId,
        actionType: call.actionType,
        providerId: call.providerId,
        model: call.model,
        since: call.updatedAt
      });
    } else if (agentPreflightIssues.length > 0) {
      state = "waiting_for_human";
      currentAction = action({
        kind: "configuration",
        status: agentPreflightIssues[0].code,
        providerId: agentPreflightIssues[0].providerId,
        model: agentPreflightIssues[0].model,
        since: input.job.executionPreflight?.checkedAt ?? input.job.updatedAt
      });
    } else if (agentRetry || latestRetryCall) {
      state = "retry_waiting";
      currentAction = action({
        kind: "retry",
        status: agentRetry?.failureCategory ?? latestRetryCall?.status ?? "retry_waiting",
        stageId: latestRetryCall?.stageId ?? null,
        actionType: agentRetry?.actionType ?? latestRetryCall?.actionType ?? null,
        providerId: agentRetry?.providerId ?? latestRetryCall?.providerId ?? null,
        model: latestRetryCall?.model ?? null,
        since: agentRetry?.updatedAt ?? latestRetryCall?.updatedAt ?? null,
        retryAt: agentRetry?.retryAt ?? null
      });
    } else if (latestQueue || persistedQueue) {
      const queueStatus = latestQueue?.status ?? persistedQueue!.status;
      state = queueStatus === "queued" ? "queued" : "running";
      currentAction = action({
        kind: "queue",
        status: queueStatus,
        stageId: latestQueue?.stageId ?? null,
        providerId: latestQueue?.providerId ?? persistedQueue?.providerId ?? null,
        since: latestQueue?.queuedAt ?? persistedQueue?.queuedAt ?? null
      });
    } else if (latestActiveCall) {
      state = "running";
      currentAction = action({
        kind: "model_call",
        status: latestActiveCall.status,
        stageId: latestActiveCall.stageId,
        actionType: latestActiveCall.actionType,
        providerId: latestActiveCall.providerId,
        model: latestActiveCall.model,
        since: latestActiveCall.updatedAt
      });
    }

    if (input.job.status === "succeeded" && state !== "skipped") {
      state = "completed";
      currentAction = action({
        kind: agentId === "main-agent" ? "coordination" : agentStages.length > 0 ? "stage" : "idle",
        status: "completed",
        stageId: latestStage?.id ?? null,
        since: input.job.completedAt ?? input.job.updatedAt
      });
    } else if (input.job.status === "failed" && !["completed", "skipped"].includes(state)) {
      state = "failed";
      currentAction = action({
        kind: agentId === "main-agent" ? "coordination" : latestStage ? "stage" : "idle",
        status: "failed",
        stageId: latestStage?.id ?? null,
        since: input.job.completedAt ?? input.job.updatedAt
      });
    } else if (input.job.status === "cancelled" && !["completed", "skipped"].includes(state)) {
      state = "cancelled";
      currentAction = action({
        kind: agentId === "main-agent" ? "coordination" : latestStage ? "stage" : "idle",
        status: "cancelled",
        stageId: latestStage?.id ?? null,
        since: input.job.completedAt ?? input.job.updatedAt
      });
    }

    return {
      agentId,
      roles: [...(roles.get(agentId) ?? [])],
      state,
      stageIds: agentStages.map((stage) => stage.id),
      activeStageIds: agentStages.filter((stage) => ACTIVE_STAGE_STATUSES.has(stage.status)).map((stage) => stage.id),
      completedStageCount: agentStages.filter((stage) => COMPLETED_STAGE_STATUSES.has(stage.status)).length,
      totalStageCount: agentStages.length,
      currentAction,
      lastError: ["completed", "cancelled", "skipped"].includes(state)
        ? null
        : latestByUpdatedAt(agentCalls.filter((call) => Boolean(call.error)))?.error ?? null,
      skippedReason: skipReasons.get(agentId) ?? null,
      updatedAt: currentAction.since ?? input.job.updatedAt
    };
  });

  const completedStages = stages.filter((stage) => COMPLETED_STAGE_STATUSES.has(stage.status)).length;
  const currentStages = stages.filter((stage) => ACTIVE_STAGE_STATUSES.has(stage.status) || BLOCKED_STAGE_STATUSES.has(stage.status));
  const percent = input.job.status === "succeeded"
    ? 100
    : stages.length > 0
      ? Math.round((stages.reduce((sum, stage) => sum + stageProgress(stage.status), 0) / stages.length) * 100)
      : fallbackProgress(input.job.status);
  const recommendedActions = unique(blockers.map((blocker) => blocker.recommendedAction));

  return {
    version: "honeycomb.job-execution-state.v1",
    generatedAt: input.generatedAt,
    job: {
      id: input.job.id,
      displayTitle: input.job.displayTitle,
      status: input.job.status,
      phase,
      routingMode: input.job.routingMode,
      workflowId: input.job.workflowId,
      createdAt: input.job.createdAt,
      updatedAt: input.job.updatedAt,
      completedAt: input.job.completedAt
    },
    progress: {
      percent,
      totalStages: stages.length,
      completedStages,
      activeStages: stages.filter((stage) => ACTIVE_STAGE_STATUSES.has(stage.status)).length,
      blockedStages: stages.filter((stage) => BLOCKED_STAGE_STATUSES.has(stage.status)).length,
      currentStageIds: currentStages.map((stage) => stage.id),
      currentAgentIds: unique(agents.filter((agent) => [
        "queued",
        "running",
        "testing",
        "fixing",
        "retry_waiting",
        "waiting_for_approval",
        "waiting_for_human",
        "stalled"
      ].includes(agent.state)).map((agent) => agent.agentId))
    },
    stages,
    agents,
    plan: input.plan,
    runtime: {
      heartbeat: {
        status: input.job.heartbeatStatus,
        at: input.job.heartbeatAt,
        source: input.job.heartbeatSource,
        note: input.job.heartbeatNote,
        stalledAt: input.job.stalledAt
      },
      modelCalls: {
        total: input.modelCalls.length,
        active: activeCalls.length,
        retryWaiting: retryCalls.length,
        reconciliationRequired: reconciliationCalls.length,
        providerResumeAvailable: providerResumeCalls.length,
        calls: input.modelCalls
      },
      queues: {
        queued: input.queues.filter((entry) => entry.status === "queued").length,
        acquired: input.queues.filter((entry) => entry.status === "acquired").length,
        entries: input.queues
      },
      approvals: {
        pending: input.pendingApprovals.length,
        entries: input.pendingApprovals.map((approval) => ({
          id: approval.id,
          stageId: approval.stageId,
          agentId: approval.agentId,
          toolName: approval.toolName,
          actionType: approval.actionType,
          riskLevel: approval.riskLevel,
          reason: approval.reason,
          target: approval.target,
          status: "pending" as const,
          createdAt: approval.createdAt,
          updatedAt: approval.updatedAt,
          expiresAt: approval.expiresAt
        }))
      },
      artifacts: input.artifacts,
      deliveries: {
        required: requiredDeliveries.length,
        succeeded: completedDeliveries.length,
        pending: pendingDeliveries.length,
        delivering: deliveringDeliveries.length,
        failed: failedDeliveries.length,
        authorizationRequired: authorizationBlockedDeliveries.length
      },
      spend: input.job.spendBudget
    },
    blockers,
    primaryBlocker: blockers[0] ?? null,
    recommendedActions
  };
}
