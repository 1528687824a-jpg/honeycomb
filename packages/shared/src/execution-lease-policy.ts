import type {
  JobHeartbeatStatus,
  JobStatus
} from "./types";

export type JobExecutionClaimDecision = {
  allowed: boolean;
  reused: boolean;
  reason: "unclaimed" | "same_workflow" | "resumable" | "active_workflow" | "terminal" | "archived";
};

export function resolveJobExecutionClaim(input: {
  status: JobStatus;
  heartbeatStatus: JobHeartbeatStatus;
  currentWorkflowId: string | null;
  requestedWorkflowId: string;
  archivedAt: string | null;
}): JobExecutionClaimDecision {
  if (input.archivedAt) {
    return { allowed: false, reused: false, reason: "archived" };
  }
  if (["succeeded", "failed", "cancelled"].includes(input.status)) {
    return { allowed: false, reused: false, reason: "terminal" };
  }
  if (input.currentWorkflowId === input.requestedWorkflowId) {
    return { allowed: true, reused: true, reason: "same_workflow" };
  }
  if (!input.currentWorkflowId && (input.status === "created" || input.status === "queued")) {
    return { allowed: true, reused: false, reason: "unclaimed" };
  }
  if (input.status === "waiting_for_human" || input.heartbeatStatus === "stalled") {
    return { allowed: true, reused: false, reason: "resumable" };
  }
  return { allowed: false, reused: false, reason: "active_workflow" };
}

export function resolveResumeWorkflowId(input: {
  resumeReason: "waiting_for_human" | "stalled";
  currentWorkflowId: string | null;
  requestedWorkflowId: string;
}) {
  return input.resumeReason === "stalled" && input.currentWorkflowId
    ? input.currentWorkflowId
    : input.requestedWorkflowId;
}

type LeaseModelCallStatus =
  | "started"
  | "retry_waiting"
  | "succeeded"
  | "failed"
  | "failed_unknown_outcome"
  | "cancelled";

export type ModelCallLeaseRecoveryClassification =
  | "inactive"
  | "active"
  | "provider_resume_available"
  | "reconciliation_required";

export function classifyModelCallLeaseRecovery(input: {
  status: LeaseModelCallStatus;
  leaseExpiresAt: string | null;
  now: string;
  requestReference: {
    runner?: string | null;
    kind?: string | null;
    providerTaskId?: string | null;
  } | null;
}): ModelCallLeaseRecoveryClassification {
  if (input.status !== "started") {
    return "inactive";
  }
  if (leaseIsActive(input.leaseExpiresAt, input.now)) {
    return "active";
  }
  const reference = input.requestReference;
  if (
    reference?.runner === "provider-direct" &&
    reference.kind === "video" &&
    typeof reference.providerTaskId === "string" &&
    reference.providerTaskId.trim()
  ) {
    return "provider_resume_available";
  }
  return "reconciliation_required";
}

export type ModelCallLeaseClaimDecision = {
  allowed: boolean;
  reused: boolean;
  reason:
    | "new"
    | "retry"
    | "same_owner"
    | "expired_provider_resume"
    | "in_progress"
    | "reconciliation_required"
    | "status_not_claimable";
};

function leaseIsActive(leaseExpiresAt: string | null, now: string) {
  if (!leaseExpiresAt) return false;
  const expiresAtMs = Date.parse(leaseExpiresAt);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
}

export function resolveModelCallLeaseClaim(input: {
  status: LeaseModelCallStatus | null;
  currentClaimToken: string | null;
  requestedClaimToken: string;
  leaseExpiresAt: string | null;
  now: string;
  allowExpiredStartedTakeover: boolean;
}): ModelCallLeaseClaimDecision {
  if (!input.status) {
    return { allowed: true, reused: false, reason: "new" };
  }
  if (input.status === "failed" || input.status === "retry_waiting") {
    return { allowed: true, reused: false, reason: "retry" };
  }
  if (input.status !== "started") {
    return { allowed: false, reused: false, reason: "status_not_claimable" };
  }
  if (input.currentClaimToken && input.currentClaimToken === input.requestedClaimToken) {
    return { allowed: true, reused: true, reason: "same_owner" };
  }
  if (leaseIsActive(input.leaseExpiresAt, input.now)) {
    return { allowed: false, reused: false, reason: "in_progress" };
  }
  if (input.allowExpiredStartedTakeover) {
    return { allowed: true, reused: false, reason: "expired_provider_resume" };
  }
  return { allowed: false, reused: false, reason: "reconciliation_required" };
}
