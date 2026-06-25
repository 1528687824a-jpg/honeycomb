import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveJobResumeEligibility } from "../packages/db/src/jobs";
import type { JobHeartbeatStatus, JobRecord, JobStatus } from "../packages/shared/src/types";

function jobState(
  status: JobStatus,
  heartbeatStatus: JobHeartbeatStatus,
  archivedAt: string | null = null
): Pick<JobRecord, "status" | "heartbeatStatus" | "archivedAt"> {
  return {
    status,
    heartbeatStatus,
    archivedAt
  };
}

test("waiting_for_human jobs can be resumed", () => {
  assert.deepEqual(resolveJobResumeEligibility(jobState("waiting_for_human", "paused")), {
    resumable: true,
    reason: "waiting_for_human"
  });
});

test("stalled non-terminal jobs can be resumed", () => {
  assert.deepEqual(resolveJobResumeEligibility(jobState("planning", "stalled")), {
    resumable: true,
    reason: "stalled"
  });
});

test("healthy active jobs are not resumable", () => {
  assert.deepEqual(resolveJobResumeEligibility(jobState("running", "healthy")), {
    resumable: false,
    reason: "job_not_waiting_or_stalled"
  });
});

test("terminal jobs are not resumable", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as JobStatus[]) {
    assert.deepEqual(resolveJobResumeEligibility(jobState(status, "terminal")), {
      resumable: false,
      reason: "job_terminal"
    });
  }
});

test("archived jobs are not resumable even when paused", () => {
  assert.deepEqual(resolveJobResumeEligibility(jobState("waiting_for_human", "paused", "2026-06-24T00:00:00.000Z")), {
    resumable: false,
    reason: "job_archived"
  });
});
