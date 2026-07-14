import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveJobExecutionClaim,
  resolveModelCallLeaseClaim,
  resolveResumeWorkflowId
} from "../packages/shared/src/execution-lease-policy";

test("a created job can be claimed exactly once by a new workflow", () => {
  assert.deepEqual(resolveJobExecutionClaim({
    status: "created",
    heartbeatStatus: "healthy",
    currentWorkflowId: null,
    requestedWorkflowId: "workflow-a",
    archivedAt: null
  }), {
    allowed: true,
    reused: false,
    reason: "unclaimed"
  });

  assert.deepEqual(resolveJobExecutionClaim({
    status: "queued",
    heartbeatStatus: "healthy",
    currentWorkflowId: "workflow-a",
    requestedWorkflowId: "workflow-b",
    archivedAt: null
  }), {
    allowed: false,
    reused: false,
    reason: "active_workflow"
  });
});

test("the same workflow can idempotently reclaim its job", () => {
  assert.deepEqual(resolveJobExecutionClaim({
    status: "running",
    heartbeatStatus: "healthy",
    currentWorkflowId: "workflow-a",
    requestedWorkflowId: "workflow-a",
    archivedAt: null
  }), {
    allowed: true,
    reused: true,
    reason: "same_workflow"
  });
});

test("waiting and stalled jobs allow a new execution generation", () => {
  for (const input of [
    { status: "waiting_for_human" as const, heartbeatStatus: "paused" as const },
    { status: "running" as const, heartbeatStatus: "stalled" as const }
  ]) {
    assert.equal(resolveJobExecutionClaim({
      ...input,
      currentWorkflowId: "workflow-a",
      requestedWorkflowId: "workflow-b",
      archivedAt: null
    }).allowed, true);
  }
});

test("terminal and archived jobs cannot be claimed", () => {
  assert.equal(resolveJobExecutionClaim({
    status: "succeeded",
    heartbeatStatus: "terminal",
    currentWorkflowId: "workflow-a",
    requestedWorkflowId: "workflow-a",
    archivedAt: null
  }).reason, "terminal");
  assert.equal(resolveJobExecutionClaim({
    status: "waiting_for_human",
    heartbeatStatus: "paused",
    currentWorkflowId: "workflow-a",
    requestedWorkflowId: "workflow-b",
    archivedAt: "2026-07-14T00:00:00.000Z"
  }).reason, "archived");
});

test("stalled recovery reuses the durable DBOS workflow id", () => {
  assert.equal(resolveResumeWorkflowId({
    resumeReason: "stalled",
    currentWorkflowId: "workflow-a",
    requestedWorkflowId: "workflow-b"
  }), "workflow-a");
  assert.equal(resolveResumeWorkflowId({
    resumeReason: "waiting_for_human",
    currentWorkflowId: "workflow-a",
    requestedWorkflowId: "workflow-b"
  }), "workflow-b");
});

test("an active model-call lease rejects a second owner", () => {
  assert.deepEqual(resolveModelCallLeaseClaim({
    status: "started",
    currentClaimToken: "owner-a",
    requestedClaimToken: "owner-b",
    leaseExpiresAt: "2026-07-14T00:10:00.000Z",
    now: "2026-07-14T00:00:00.000Z",
    allowExpiredStartedTakeover: false
  }), {
    allowed: false,
    reused: false,
    reason: "in_progress"
  });
});

test("an expired unknown model call requires reconciliation", () => {
  assert.equal(resolveModelCallLeaseClaim({
    status: "started",
    currentClaimToken: "owner-a",
    requestedClaimToken: "owner-b",
    leaseExpiresAt: "2026-07-13T23:59:59.000Z",
    now: "2026-07-14T00:00:00.000Z",
    allowExpiredStartedTakeover: false
  }).reason, "reconciliation_required");
});

test("an expired queryable provider task can transfer its lease without another create call", () => {
  assert.deepEqual(resolveModelCallLeaseClaim({
    status: "started",
    currentClaimToken: "owner-a",
    requestedClaimToken: "owner-b",
    leaseExpiresAt: "2026-07-13T23:59:59.000Z",
    now: "2026-07-14T00:00:00.000Z",
    allowExpiredStartedTakeover: true
  }), {
    allowed: true,
    reused: false,
    reason: "expired_provider_resume"
  });
});

test("failed and retry-waiting model calls can acquire a fresh lease", () => {
  for (const status of ["failed", "retry_waiting"] as const) {
    assert.equal(resolveModelCallLeaseClaim({
      status,
      currentClaimToken: null,
      requestedClaimToken: "owner-b",
      leaseExpiresAt: null,
      now: "2026-07-14T00:00:00.000Z",
      allowExpiredStartedTakeover: false
    }).allowed, true);
  }
});
