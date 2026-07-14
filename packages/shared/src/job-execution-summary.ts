import type {
  AgentExecutionState,
  JobExecutionBlockerCode,
  JobExecutionPhase,
  JobExecutionRecommendedAction,
  JobExecutionState
} from "./job-execution-state";
import type { JobStatus, RoutingMode } from "./types";

export const JOB_EXECUTION_SUMMARY_VERSION = "honeycomb.job-execution-summary.v1" as const;
export const JOB_EXECUTION_SUMMARY_QUERY_VERSION = "honeycomb.job-execution-summary-query.v1" as const;

export type JobExecutionSummaryAgent = {
  agentId: string;
  roles: Array<"coordinator" | "production" | "quality_gate" | "skipped">;
  state: AgentExecutionState;
  currentAction: {
    kind: JobExecutionState["agents"][number]["currentAction"]["kind"];
    status: string;
    stageId: string | null;
    actionType: string | null;
  };
  updatedAt: string;
};

export type JobExecutionSummary = {
  version: typeof JOB_EXECUTION_SUMMARY_VERSION;
  revision: string;
  jobId: string;
  displayTitle: string;
  status: JobStatus;
  phase: JobExecutionPhase;
  routingMode: RoutingMode;
  progress: {
    percent: number;
    totalStages: number;
    completedStages: number;
    activeStages: number;
    blockedStages: number;
    currentStageIds: string[];
    currentAgentIds: string[];
  };
  agentCounts: {
    total: number;
    active: number;
    waiting: number;
    failed: number;
    completed: number;
    skipped: number;
  };
  agents: JobExecutionSummaryAgent[];
  plan: {
    status: string;
    totalItems: number;
    completedItems: number;
    activeItems: number;
    blockedItems: number;
  } | null;
  primaryBlocker: {
    code: JobExecutionBlockerCode;
    severity: "warning" | "action_required" | "error";
    agentIds: string[];
    detail: string | null;
    recommendedAction: JobExecutionRecommendedAction;
  } | null;
  recommendedActions: JobExecutionRecommendedAction[];
  runtime: {
    modelCalls: {
      active: number;
      retryWaiting: number;
      reconciliationRequired: number;
      providerResumeAvailable: number;
    };
    queues: { queued: number; acquired: number };
    approvals: { pending: number };
    artifacts: JobExecutionState["runtime"]["artifacts"];
    deliveries: JobExecutionState["runtime"]["deliveries"];
    spend: {
      enabled: boolean;
      settledUsd: number;
      reservedUsd: number;
      remainingUsd: number | null;
      blocked: boolean;
      blockingScope: JobExecutionState["runtime"]["spend"]["blockingScope"];
    };
  };
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type JobExecutionSummaryDraft = Omit<JobExecutionSummary, "revision">;

export type JobExecutionSummaryQueryResponse = {
  version: typeof JOB_EXECUTION_SUMMARY_QUERY_VERSION;
  generatedAt: string;
  requested: number;
  returned: number;
  summaries: JobExecutionSummary[];
  unchangedJobIds: string[];
  missingJobIds: string[];
  revisions: Record<string, string>;
};

const ACTIVE_AGENT_STATES = new Set<AgentExecutionState>([
  "queued",
  "running",
  "testing",
  "fixing",
  "retry_waiting"
]);
const WAITING_AGENT_STATES = new Set<AgentExecutionState>([
  "waiting_for_approval",
  "waiting_for_human",
  "stalled"
]);

const PUBLIC_BLOCKER_DETAILS: Record<JobExecutionBlockerCode, string> = {
  model_call_reconciliation_required: "A provider result needs reconciliation.",
  tool_approval_required: "A tool action is waiting for approval.",
  agent_runtime_configuration_blocked: "An agent runtime configuration needs attention.",
  spend_limit_blocked: "The task spend limit blocks further model calls.",
  artifact_delivery_authorization_required: "The delivery destination needs authorization.",
  artifact_delivery_failed: "Artifact delivery failed and can be retried.",
  artifact_delivery_pending: "Artifact delivery is still pending.",
  execution_stalled: "Task execution is stalled.",
  job_waiting_for_human: "The task is waiting for user input.",
  job_failed: "Task execution failed."
};

export function projectJobExecutionSummary(state: JobExecutionState): JobExecutionSummaryDraft {
  const completedItems = state.plan?.items.filter((item) => item.status === "completed").length ?? 0;
  const activeItems = state.plan?.items.filter((item) => item.status === "in_progress").length ?? 0;
  const blockedItems = state.plan?.items.filter((item) => item.status === "blocked").length ?? 0;
  const agents = state.agents.map((agent): JobExecutionSummaryAgent => ({
    agentId: agent.agentId,
    roles: agent.roles,
    state: agent.state,
    currentAction: {
      kind: agent.currentAction.kind,
      status: agent.currentAction.status,
      stageId: agent.currentAction.stageId,
      actionType: agent.currentAction.actionType
    },
    updatedAt: agent.updatedAt
  }));

  return {
    version: JOB_EXECUTION_SUMMARY_VERSION,
    jobId: state.job.id,
    displayTitle: state.job.displayTitle,
    status: state.job.status,
    phase: state.job.phase,
    routingMode: state.job.routingMode,
    progress: { ...state.progress },
    agentCounts: {
      total: agents.length,
      active: agents.filter((agent) => ACTIVE_AGENT_STATES.has(agent.state)).length,
      waiting: agents.filter((agent) => WAITING_AGENT_STATES.has(agent.state)).length,
      failed: agents.filter((agent) => agent.state === "failed").length,
      completed: agents.filter((agent) => agent.state === "completed").length,
      skipped: agents.filter((agent) => agent.state === "skipped").length
    },
    agents,
    plan: state.plan ? {
      status: state.plan.plan.status,
      totalItems: state.plan.items.length,
      completedItems,
      activeItems,
      blockedItems
    } : null,
    primaryBlocker: state.primaryBlocker ? {
      code: state.primaryBlocker.code,
      severity: state.primaryBlocker.severity,
      agentIds: state.primaryBlocker.agentIds,
      detail: PUBLIC_BLOCKER_DETAILS[state.primaryBlocker.code],
      recommendedAction: state.primaryBlocker.recommendedAction
    } : null,
    recommendedActions: state.recommendedActions,
    runtime: {
      modelCalls: {
        active: state.runtime.modelCalls.active,
        retryWaiting: state.runtime.modelCalls.retryWaiting,
        reconciliationRequired: state.runtime.modelCalls.reconciliationRequired,
        providerResumeAvailable: state.runtime.modelCalls.providerResumeAvailable
      },
      queues: {
        queued: state.runtime.queues.queued,
        acquired: state.runtime.queues.acquired
      },
      approvals: { pending: state.runtime.approvals.pending },
      artifacts: state.runtime.artifacts,
      deliveries: state.runtime.deliveries,
      spend: {
        enabled: state.runtime.spend.enabled,
        settledUsd: state.runtime.spend.settledUsd,
        reservedUsd: state.runtime.spend.reservedUsd,
        remainingUsd: state.runtime.spend.remainingUsd,
        blocked: state.runtime.spend.blocked,
        blockingScope: state.runtime.spend.blockingScope
      }
    },
    createdAt: state.job.createdAt,
    updatedAt: state.stateUpdatedAt,
    completedAt: state.job.completedAt
  };
}
