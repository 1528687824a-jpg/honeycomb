import assert from "node:assert/strict";
import test from "node:test";
import { projectJobExecutionState, type JobExecutionStateInput } from "../packages/shared/src/job-execution-state";
import {
  createJobExecutionSummary,
  selectChangedJobExecutionSummaries
} from "../packages/db/src/job-execution-summary";
import { emptyJobSpendBudget } from "../packages/shared/src/spend-policy";
import type { ArtifactDeliveryRecord, StageRecord, ToolApprovalRecord } from "../packages/shared/src/types";

const now = "2026-07-14T12:00:00.000Z";

function job(overrides: Partial<JobExecutionStateInput["job"]> = {}): JobExecutionStateInput["job"] {
  return {
    id: "JOB-STATE-1",
    displayTitle: "Tea poster",
    status: "running",
    routingMode: "supervisor_pipeline",
    workflowId: "workflow-1",
    orchestrationPlan: null,
    executionPreflight: null,
    executionQueue: null,
    executionRetry: null,
    spendBudget: emptyJobSpendBudget(null),
    heartbeatAt: now,
    heartbeatStatus: "healthy",
    heartbeatSource: "stage-agent",
    heartbeatNote: null,
    stalledAt: null,
    createdAt: "2026-07-14T11:00:00.000Z",
    updatedAt: now,
    completedAt: null,
    ...overrides
  };
}

function stage(input: Partial<StageRecord> & Pick<StageRecord, "id" | "stageIndex" | "agentId" | "status">): StageRecord {
  return {
    id: input.id,
    jobId: "JOB-STATE-1",
    stageIndex: input.stageIndex,
    stageType: input.stageType ?? "production",
    agentId: input.agentId,
    name: input.name ?? input.id,
    status: input.status,
    inputArtifactId: null,
    outputArtifactId: null,
    acceptanceCriteria: [],
    retryCount: 0,
    maxRetries: 2,
    originalAgentSessionId: null,
    originalTestSessionId: null,
    createdAt: "2026-07-14T11:00:00.000Z",
    updatedAt: input.updatedAt ?? now
  };
}

function approval(agentId: string): ToolApprovalRecord {
  return {
    id: "APR-1",
    jobId: "JOB-STATE-1",
    sessionId: "SESSION-1",
    stageId: "STAGE-2",
    agentId,
    requesterActor: "tool-gateway",
    toolName: "workspace.write",
    actionType: "write_file",
    riskLevel: "medium",
    reason: "Write the generated file",
    command: null,
    target: "poster.png",
    input: {},
    policy: {},
    status: "pending",
    decisionReason: null,
    decidedBy: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: "2026-07-14T13:00:00.000Z",
    decidedAt: null,
    consumedAt: null
  };
}

function delivery(overrides: Partial<ArtifactDeliveryRecord> = {}): ArtifactDeliveryRecord {
  return {
    id: "DEL-1",
    jobId: "JOB-STATE-1",
    artifactFileId: "FILE-1",
    deliverableIndex: 0,
    required: true,
    target: "desktop",
    targetPath: null,
    requestedFileName: "poster.png",
    authorizationStatus: "authorized",
    authorizationKind: "desktop",
    authorizationId: null,
    authorizedRootPath: null,
    destinationRelativePath: null,
    destinationPath: null,
    authorizationError: null,
    status: "pending",
    attemptCount: 0,
    claimToken: null,
    leaseExpiresAt: null,
    expectedSizeBytes: null,
    expectedChecksumSha256: null,
    deliveredPath: null,
    deliveredSizeBytes: null,
    deliveredChecksumSha256: null,
    lastError: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides
  };
}

function project(overrides: Partial<JobExecutionStateInput> = {}) {
  return projectJobExecutionState({
    generatedAt: now,
    job: job(),
    stages: [],
    plan: null,
    pendingApprovals: [],
    modelCalls: [],
    queues: [],
    deliveries: [],
    artifacts: {
      artifactCount: 0,
      fileCount: 0,
      availableFileCount: 0,
      failedFileCount: 0,
      updatedAt: null
    },
    ...overrides
  });
}

test("task state uses persisted stage and approval records instead of timeline guesses", () => {
  const state = project({
    stages: [
      stage({ id: "STAGE-1", stageIndex: 1, agentId: "research-agent", status: "completed" }),
      stage({ id: "STAGE-2", stageIndex: 2, agentId: "image-agent", status: "running" })
    ],
    pendingApprovals: [approval("image-agent")]
  });

  assert.equal(state.job.phase, "waiting_for_approval");
  assert.equal(state.progress.percent, 68);
  assert.deepEqual(state.progress.currentStageIds, ["STAGE-2"]);
  assert.equal(state.primaryBlocker?.code, "tool_approval_required");
  assert.equal(state.agents.find((agent) => agent.agentId === "research-agent")?.state, "completed");
  assert.equal(state.agents.find((agent) => agent.agentId === "image-agent")?.state, "waiting_for_approval");
});

test("unknown provider outcomes outrank delivery failures and keep the responsible agent visible", () => {
  const state = project({
    job: job({ status: "waiting_for_human", heartbeatStatus: "paused", heartbeatNote: "model_call_reconciliation_required" }),
    stages: [stage({ id: "STAGE-1", stageIndex: 1, agentId: "image-agent", status: "waiting_for_human" })],
    modelCalls: [{
      id: "MC-1",
      idempotencyKey: "call-1",
      stageId: "STAGE-1",
      agentId: "image-agent",
      actionType: "stage-agent",
      status: "failed_unknown_outcome",
      classification: "reconciliation_required",
      providerId: "image-provider",
      model: "image-model",
      leaseExpiresAt: null,
      recoveryStatus: "reconciliation_required",
      error: "provider outcome is unknown",
      updatedAt: now
    }],
    deliveries: [delivery({ status: "failed", lastError: "desktop write failed" })]
  });

  assert.equal(state.job.phase, "waiting_for_reconciliation");
  assert.deepEqual(state.blockers.map((blocker) => blocker.code), [
    "model_call_reconciliation_required",
    "artifact_delivery_failed"
  ]);
  assert.equal(state.agents.find((agent) => agent.agentId === "image-agent")?.state, "waiting_for_human");
  assert.deepEqual(state.recommendedActions, ["reconcile_model_call", "retry_artifact_delivery"]);
});

test("unknown provider outcomes also outrank approvals on the same agent", () => {
  const state = project({
    pendingApprovals: [approval("image-agent")],
    modelCalls: [{
      id: "MC-AMBIGUOUS",
      idempotencyKey: "call-ambiguous",
      stageId: "STAGE-2",
      agentId: "image-agent",
      actionType: "stage-agent",
      status: "failed_unknown_outcome",
      classification: "reconciliation_required",
      providerId: "image-provider",
      model: "image-model",
      leaseExpiresAt: null,
      recoveryStatus: "reconciliation_required",
      error: "provider outcome is unknown",
      updatedAt: now
    }]
  });

  const imageAgent = state.agents.find((agent) => agent.agentId === "image-agent");
  assert.equal(state.job.phase, "waiting_for_reconciliation");
  assert.equal(state.primaryBlocker?.code, "model_call_reconciliation_required");
  assert.equal(imageAgent?.state, "waiting_for_human");
  assert.equal(imageAgent?.currentAction.status, "reconciliation_required");
});

test("persisted provider video tasks are stalled and resumable without becoming unknown outcomes", () => {
  const state = project({
    job: job({ heartbeatStatus: "stalled", heartbeatNote: "provider_video_resume_available", stalledAt: now }),
    modelCalls: [{
      id: "MC-VIDEO",
      idempotencyKey: "video-call",
      stageId: "STAGE-VIDEO",
      agentId: "video-agent",
      actionType: "stage-agent",
      status: "started",
      classification: "provider_resume_available",
      providerId: "video-provider",
      model: "video-model",
      leaseExpiresAt: "2026-07-14T11:59:00.000Z",
      recoveryStatus: "provider_resume_available",
      error: null,
      updatedAt: now
    }]
  });

  assert.equal(state.job.phase, "stalled");
  assert.equal(state.runtime.modelCalls.providerResumeAvailable, 1);
  assert.equal(state.runtime.modelCalls.reconciliationRequired, 0);
  assert.equal(state.agents.find((agent) => agent.agentId === "video-agent")?.state, "stalled");
  assert.deepEqual(state.recommendedActions, ["resume_job"]);
});

test("terminal success suppresses stale operational blockers", () => {
  const state = project({
    job: job({ status: "succeeded", heartbeatStatus: "terminal", completedAt: now }),
    stages: [stage({ id: "STAGE-1", stageIndex: 1, agentId: "image-agent", status: "completed" })],
    pendingApprovals: [approval("image-agent")],
    deliveries: [delivery({ status: "failed", lastError: "stale failure" })]
  });

  assert.equal(state.job.phase, "succeeded");
  assert.equal(state.progress.percent, 100);
  assert.deepEqual(state.blockers, []);
  assert.deepEqual(state.recommendedActions, []);
  assert.equal(state.agents.find((agent) => agent.agentId === "image-agent")?.state, "completed");
  assert.equal(state.agents.find((agent) => agent.agentId === "image-agent")?.currentAction.status, "completed");
});

test("preflight configuration blockers name the affected agent before stages exist", () => {
  const state = project({
    job: job({
      status: "waiting_for_human",
      heartbeatStatus: "paused",
      executionPreflight: {
        version: "honeycomb.task-preflight.v1",
        status: "blocked",
        mode: "real",
        runner: "provider-direct",
        checkedAt: now,
        agents: [{
          agentId: "image-agent",
          purpose: "production",
          stageTypes: ["image"],
          ready: false,
          selectedRouteIndex: null,
          routes: []
        }],
        blockingIssues: [{
          code: "provider_api_key_missing",
          severity: "blocking",
          agentId: "image-agent",
          providerId: "image-provider",
          model: "image-model",
          message: "Provider API key is missing"
        }],
        warnings: []
      }
    })
  });

  assert.equal(state.job.phase, "waiting_for_human");
  assert.equal(state.primaryBlocker?.code, "agent_runtime_configuration_blocked");
  assert.equal(state.agents.find((agent) => agent.agentId === "image-agent")?.state, "waiting_for_human");
  assert.equal(state.agents.find((agent) => agent.agentId === "image-agent")?.currentAction.kind, "configuration");
});

test("persisted job queue state keeps its agent visible after queue history cleanup", () => {
  const state = project({
    job: job({
      executionQueue: {
        version: "honeycomb.model-call-queue.v1",
        status: "queued",
        requestKey: "queue-1",
        idempotencyKey: "call-1",
        routeIndex: 0,
        agentId: "writer-agent",
        providerId: "text-provider",
        queuedAt: now,
        acquiredAt: null,
        leaseExpiresAt: "2026-07-14T12:05:00.000Z",
        globalPosition: 2,
        providerPosition: 1,
        agentPosition: 1,
        limits: { global: 4, provider: 2, agent: 1 },
        active: { global: 4, provider: 1, agent: 0 },
        blockingScopes: ["global"],
        retryAfterMs: 1_000
      }
    })
  });

  assert.equal(state.job.phase, "queued");
  assert.equal(state.agents.find((agent) => agent.agentId === "writer-agent")?.state, "queued");
  assert.equal(state.agents.find((agent) => agent.agentId === "writer-agent")?.currentAction.kind, "queue");
});

test("task-list summary preserves progress and agent state without execution secrets", () => {
  const pendingApproval = {
    ...approval("image-agent"),
    reason: "Write C:\\Users\\Administrator\\Desktop\\poster.png with Bearer secret-token",
    command: "secret-shell-command",
    input: { apiKey: "secret-input-key" },
    policy: { hiddenRule: "secret-policy" }
  };
  const state = project({
    stages: [
      stage({ id: "STAGE-1", stageIndex: 1, agentId: "research-agent", status: "completed" }),
      stage({ id: "STAGE-2", stageIndex: 2, agentId: "image-agent", status: "running" })
    ],
    pendingApprovals: [pendingApproval],
    modelCalls: [{
      id: "MC-SUMMARY",
      idempotencyKey: "secret-idempotency-key",
      stageId: "STAGE-2",
      agentId: "image-agent",
      actionType: "stage-agent",
      status: "started",
      classification: "active",
      providerId: "image-provider",
      model: "image-model",
      leaseExpiresAt: "2026-07-14T12:10:00.000Z",
      recoveryStatus: null,
      error: null,
      updatedAt: now
    }]
  });
  const summary = createJobExecutionSummary(state);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.phase, "waiting_for_approval");
  assert.equal(summary.progress.percent, 68);
  assert.equal(summary.agentCounts.total, 3);
  assert.equal(summary.agentCounts.waiting, 1);
  assert.equal(summary.primaryBlocker?.code, "tool_approval_required");
  assert.match(summary.revision, /^[a-f0-9]{64}$/);
  assert.equal(serialized.includes("secret-shell-command"), false);
  assert.equal(serialized.includes("secret-input-key"), false);
  assert.equal(serialized.includes("secret-policy"), false);
  assert.equal(serialized.includes("secret-idempotency-key"), false);
  assert.equal(serialized.includes("C:\\Users\\Administrator"), false);
  assert.equal(serialized.includes("secret-token"), false);
});

test("task-list revision ignores projection time but changes with visible execution state", () => {
  const first = createJobExecutionSummary(project({ generatedAt: "2026-07-14T12:00:00.000Z" }));
  const refreshed = createJobExecutionSummary(project({ generatedAt: "2026-07-14T12:00:10.000Z" }));
  const blocked = createJobExecutionSummary(project({
    generatedAt: "2026-07-14T12:00:10.000Z",
    pendingApprovals: [approval("image-agent")]
  }));

  assert.equal(first.revision, refreshed.revision);
  assert.notEqual(first.revision, blocked.revision);
});

test("task-list freshness includes artifact inventory updates", () => {
  const state = project({
    artifacts: {
      artifactCount: 1,
      fileCount: 1,
      availableFileCount: 1,
      failedFileCount: 0,
      updatedAt: "2026-07-14T12:05:00.000Z"
    }
  });

  assert.equal(state.stateUpdatedAt, "2026-07-14T12:05:00.000Z");
  assert.equal(createJobExecutionSummary(state).updatedAt, "2026-07-14T12:05:00.000Z");
});

test("task-list incremental selection returns only changed summaries", () => {
  const unchanged = createJobExecutionSummary(project());
  const changed = createJobExecutionSummary(project({
    job: job({ id: "JOB-STATE-2", displayTitle: "Changed task", status: "queued" })
  }));
  const selected = selectChangedJobExecutionSummaries(
    [unchanged, changed],
    { [unchanged.jobId]: unchanged.revision, [changed.jobId]: "0".repeat(64) }
  );

  assert.deepEqual(selected.unchangedJobIds, [unchanged.jobId]);
  assert.deepEqual(selected.changed.map((summary) => summary.jobId), [changed.jobId]);
});
