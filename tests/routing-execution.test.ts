import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  executeRoutingMode,
  type RoutingExecutionActions,
  type RunStageAgentInput
} from "../apps/dbos-worker/src/routing-execution";
import type {
  StageRecord,
  StageRunResult,
  TestReviewResult,
  TestVerdict
} from "../packages/shared/src/types";

function stage(stageIndex: number, maxRetries = 3): StageRecord {
  return {
    id: `stage-${stageIndex}`,
    jobId: "job-routing",
    stageIndex,
    stageType: `type-${stageIndex}`,
    agentId: `agent-${stageIndex}`,
    name: `Stage ${stageIndex}`,
    status: "pending",
    inputArtifactId: null,
    outputArtifactId: null,
    acceptanceCriteria: [],
    retryCount: 0,
    maxRetries,
    originalAgentSessionId: null,
    originalTestSessionId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function stageRun(input: RunStageAgentInput): StageRunResult {
  return {
    attemptId: `${input.stageId}-attempt-${input.attemptNo}`,
    agentSessionId: `${input.stageId}-session`,
    outputArtifactId: `${input.stageId}-artifact-${input.attemptNo}`,
    outputPath: `${input.stageId}-output-${input.attemptNo}.json`,
    groupMessageId: `${input.stageId}-message-${input.attemptNo}`,
    summary: `${input.stageId} completed attempt ${input.attemptNo}`
  };
}

function testReview(stageId: string, attemptNo: number, verdict: TestVerdict): TestReviewResult {
  return {
    reviewId: `${stageId}-review-${attemptNo}`,
    testAgentSessionId: "test-agent-session",
    verdict,
    issueCount: verdict === "PASS" ? 0 : 1,
    reportArtifactId: `${stageId}-report-${attemptNo}`,
    reportPath: `${stageId}-report-${attemptNo}.md`,
    groupMessageId: `${stageId}-review-message-${attemptNo}`
  };
}

function actions(overrides: Partial<RoutingExecutionActions> = {}): RoutingExecutionActions {
  return {
    isJobCancelled: async () => false,
    hasModelCallBudget: async () => true,
    runStageAgent: async (input) => stageRun(input),
    afterStageAgent: () => undefined,
    runTestAgent: async (input) => testReview(input.stageId, input.attemptNo, "PASS"),
    passStageAndHandoff: async () => undefined,
    markJobWaitingForHuman: async () => undefined,
    requestStageFix: async () => undefined,
    stopAfterConsecutiveFailures: async () => undefined,
    completeStageWithoutReview: async () => undefined,
    recordDiscussionRound: async () => undefined,
    ...overrides
  };
}

test("pipeline runs one dependent stage at a time and links every handoff", async () => {
  const starts: string[] = [];
  const completions: Array<{ stageId: string; linkNextStage?: boolean }> = [];
  let active = 0;
  let maxActive = 0;
  const result = await executeRoutingMode({
    jobId: "job-routing",
    routingMode: "pipeline",
    stages: [stage(1), stage(2), stage(3)],
    discussionRounds: 1,
    actions: actions({
      runStageAgent: async (input) => {
        starts.push(input.stageId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active -= 1;
        return stageRun(input);
      },
      completeStageWithoutReview: async (input) => {
        completions.push(input);
      }
    })
  });

  assert.equal(result, "succeeded");
  assert.equal(maxActive, 1);
  assert.deepEqual(starts, ["stage-1", "stage-2", "stage-3"]);
  assert.deepEqual(
    completions.map(({ stageId, linkNextStage }) => ({ stageId, linkNextStage })),
    [
      { stageId: "stage-1", linkNextStage: true },
      { stageId: "stage-2", linkNextStage: true },
      { stageId: "stage-3", linkNextStage: true }
    ]
  );
});

test("routing forwards the durable workflow owner to model-calling steps", async () => {
  const stageOwners: Array<string | undefined> = [];
  const testOwners: Array<string | undefined> = [];
  const result = await executeRoutingMode({
    jobId: "job-routing",
    executionWorkflowId: "workflow-owner",
    routingMode: "supervisor_pipeline",
    stages: [stage(1)],
    discussionRounds: 1,
    actions: actions({
      runStageAgent: async (input) => {
        stageOwners.push(input.executionWorkflowId);
        return stageRun(input);
      },
      runTestAgent: async (input) => {
        testOwners.push(input.executionWorkflowId);
        return testReview(input.stageId, input.attemptNo, "PASS");
      }
    })
  });

  assert.equal(result, "succeeded");
  assert.deepEqual(stageOwners, ["workflow-owner"]);
  assert.deepEqual(testOwners, ["workflow-owner"]);
});

test("supervisor retries a rejected stage before handing off to the next stage", async () => {
  const trace: string[] = [];
  const result = await executeRoutingMode({
    jobId: "job-routing",
    routingMode: "supervisor_pipeline",
    stages: [stage(1), stage(2)],
    discussionRounds: 1,
    actions: actions({
      runStageAgent: async (input) => {
        trace.push(`run:${input.stageId}:${input.attemptNo}`);
        return stageRun(input);
      },
      runTestAgent: async (input) => {
        const verdict = input.stageId === "stage-1" && input.attemptNo === 1
          ? "FAIL_RETRYABLE"
          : "PASS";
        trace.push(`test:${input.stageId}:${input.attemptNo}:${verdict}`);
        return testReview(input.stageId, input.attemptNo, verdict);
      },
      requestStageFix: async (input) => {
        trace.push(`fix:${input.stageId}:${input.attemptNo}`);
      },
      passStageAndHandoff: async (input) => {
        trace.push(`pass:${input.stageId}`);
      }
    })
  });

  assert.equal(result, "succeeded");
  assert.deepEqual(trace, [
    "run:stage-1:1",
    "test:stage-1:1:FAIL_RETRYABLE",
    "fix:stage-1:1",
    "run:stage-1:2",
    "test:stage-1:2:PASS",
    "pass:stage-1",
    "run:stage-2:1",
    "test:stage-2:1:PASS",
    "pass:stage-2"
  ]);
});

test("classic master-slave reserves one fan-out budget and runs workers concurrently", async () => {
  const budgetChecks: Array<{
    nextAgentId: string;
    requiredCalls?: number;
    modelCallKeys?: string[];
  }> = [];
  const completed: string[] = [];
  let active = 0;
  let maxActive = 0;
  const result = await executeRoutingMode({
    jobId: "job-routing",
    routingMode: "classic_master_slave",
    stages: [stage(1), stage(2), stage(3)],
    discussionRounds: 1,
    actions: actions({
      hasModelCallBudget: async (
        _jobId,
        _actionType,
        nextAgentId,
        requiredCalls,
        modelCallKeys
      ) => {
        budgetChecks.push({ nextAgentId, requiredCalls, modelCallKeys });
        return true;
      },
      runStageAgent: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
        return stageRun(input);
      },
      completeStageWithoutReview: async (input) => {
        completed.push(input.stageId);
      }
    })
  });

  assert.equal(result, "succeeded");
  assert.equal(maxActive, 3);
  assert.deepEqual(budgetChecks, [
    {
      nextAgentId: "classic-worker-fanout",
      requiredCalls: 3,
      modelCallKeys: [
        "job-routing:stage-1:1:stage-agent",
        "job-routing:stage-2:1:stage-agent",
        "job-routing:stage-3:1:stage-agent"
      ]
    }
  ]);
  assert.deepEqual(completed, ["stage-1", "stage-2", "stage-3"]);
});

test("classic master-slave waits for every worker before reporting a failure", async () => {
  let slowWorkerFinished = false;
  const completed: string[] = [];
  await assert.rejects(
    executeRoutingMode({
      jobId: "job-routing",
      routingMode: "classic_master_slave",
      stages: [stage(1), stage(2), stage(3)],
      discussionRounds: 1,
      actions: actions({
        runStageAgent: async (input) => {
          if (input.stageId === "stage-2") {
            await delay(5);
            throw new Error("worker failed");
          }
          if (input.stageId === "stage-3") {
            await delay(25);
            slowWorkerFinished = true;
          }
          return stageRun(input);
        },
        completeStageWithoutReview: async (input) => {
          completed.push(input.stageId);
        }
      })
    }),
    /stage-2.*worker failed/
  );

  assert.equal(slowWorkerFinished, true);
  assert.deepEqual(completed, ["stage-1", "stage-3"]);
});

test("discussion passes the ordered transcript to every next participant", async () => {
  const contexts: Array<{ stageId: string; roundNo: number; artifactIds: string[] }> = [];
  const rounds: number[] = [];
  const result = await executeRoutingMode({
    jobId: "job-routing",
    routingMode: "master_slave_discussion",
    stages: [stage(1), stage(2)],
    discussionRounds: 2,
    actions: actions({
      runStageAgent: async (input) => {
        contexts.push({
          stageId: input.stageId,
          roundNo: input.attemptNo,
          artifactIds: [...(input.contextArtifactIds ?? [])]
        });
        return stageRun(input);
      },
      recordDiscussionRound: async (input) => {
        rounds.push(input.roundNo);
      }
    })
  });

  assert.equal(result, "succeeded");
  assert.deepEqual(rounds, [1, 2]);
  assert.deepEqual(contexts, [
    { stageId: "stage-1", roundNo: 1, artifactIds: [] },
    { stageId: "stage-2", roundNo: 1, artifactIds: ["stage-1-artifact-1"] },
    {
      stageId: "stage-1",
      roundNo: 2,
      artifactIds: ["stage-1-artifact-1", "stage-2-artifact-1"]
    },
    {
      stageId: "stage-2",
      roundNo: 2,
      artifactIds: [
        "stage-1-artifact-1",
        "stage-2-artifact-1",
        "stage-1-artifact-2"
      ]
    }
  ]);
});

test("routing stops before model work when cancelled or out of budget", async () => {
  let runs = 0;
  const cancelled = await executeRoutingMode({
    jobId: "job-routing",
    routingMode: "pipeline",
    stages: [stage(1)],
    discussionRounds: 1,
    actions: actions({
      isJobCancelled: async () => true,
      runStageAgent: async (input) => {
        runs += 1;
        return stageRun(input);
      }
    })
  });
  const outOfBudget = await executeRoutingMode({
    jobId: "job-routing",
    routingMode: "pipeline",
    stages: [stage(1)],
    discussionRounds: 1,
    actions: actions({
      hasModelCallBudget: async () => false,
      runStageAgent: async (input) => {
        runs += 1;
        return stageRun(input);
      }
    })
  });

  assert.equal(cancelled, "cancelled");
  assert.equal(outOfBudget, "waiting_for_human");
  assert.equal(runs, 0);
});
