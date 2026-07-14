import type {
  GroupMessageType,
  RoutingMode,
  StageRecord,
  StageRunResult,
  TestReviewResult
} from "../../../packages/shared/src/types";
import { buildModelCallIdempotencyKey } from "../../../packages/shared/src/model-call-key";
import { normalizeDiscussionContextArtifactIds } from "./discussion-context";

export type ModelCallActionType =
  | "stage-agent"
  | "test-agent"
  | "main-agent-synthesis"
  | "final-test-agent";

export type RunStageAgentInput = {
  jobId: string;
  executionWorkflowId?: string;
  stageId: string;
  attemptNo: number;
  routingMode?: RoutingMode;
  handoffTargetAgentId?: string | null;
  outputMessageType?: GroupMessageType;
  contextArtifactIds?: string[];
};

export type RoutingExecutionStatus = "succeeded" | "cancelled" | "waiting_for_human";

export type RoutingExecutionActions = {
  isJobCancelled(jobId: string): Promise<boolean>;
  hasModelCallBudget(
    jobId: string,
    nextActionType: ModelCallActionType,
    nextAgentId: string,
    requiredCalls?: number,
    modelCallKeys?: string[]
  ): Promise<boolean>;
  runStageAgent(input: RunStageAgentInput): Promise<StageRunResult>;
  afterStageAgent(jobId: string, stage: StageRecord, attemptNo: number): void;
  runTestAgent(input: {
    jobId: string;
    executionWorkflowId?: string;
    stageId: string;
    attemptId: string;
    attemptNo: number;
    outputArtifactId: string;
  }): Promise<TestReviewResult>;
  passStageAndHandoff(input: {
    jobId: string;
    stageId: string;
    outputArtifactId: string;
    reportArtifactId: string;
  }): Promise<unknown>;
  markJobWaitingForHuman(jobId: string, reason: string): Promise<unknown>;
  requestStageFix(input: {
    jobId: string;
    stageId: string;
    attemptNo: number;
    reportArtifactId: string;
  }): Promise<unknown>;
  stopAfterConsecutiveFailures(input: {
    jobId: string;
    stageId: string;
    attemptNo: number;
    reportArtifactId: string;
  }): Promise<unknown>;
  completeStageWithoutReview(input: {
    jobId: string;
    stageId: string;
    outputArtifactId: string;
    routingMode: RoutingMode;
    linkNextStage?: boolean;
    roundNo?: number;
  }): Promise<unknown>;
  recordDiscussionRound(input: {
    jobId: string;
    roundNo: number;
    stageIds: string[];
  }): Promise<unknown>;
};

async function runSupervisorPipeline(
  jobId: string,
  executionWorkflowId: string | undefined,
  stages: StageRecord[],
  actions: RoutingExecutionActions
): Promise<RoutingExecutionStatus> {
  for (const stage of stages) {
    if (await actions.isJobCancelled(jobId)) {
      return "cancelled";
    }

    let passed = false;

    for (let attemptNo = 1; attemptNo <= stage.maxRetries; attemptNo++) {
      if (await actions.isJobCancelled(jobId)) {
        return "cancelled";
      }

      if (!(await actions.hasModelCallBudget(
        jobId,
        "stage-agent",
        stage.agentId,
        1,
        [buildModelCallIdempotencyKey({
          jobId,
          stageId: stage.id,
          attemptNo,
          actionType: "stage-agent"
        })]
      ))) {
        return "waiting_for_human";
      }

      const run = await actions.runStageAgent({
        jobId,
        executionWorkflowId,
        stageId: stage.id,
        attemptNo,
        routingMode: "supervisor_pipeline",
        handoffTargetAgentId: "test-agent",
        outputMessageType: "stage_output_to_test"
      });
      actions.afterStageAgent(jobId, stage, attemptNo);

      if (await actions.isJobCancelled(jobId)) {
        return "cancelled";
      }

      if (!(await actions.hasModelCallBudget(
        jobId,
        "test-agent",
        "test-agent",
        1,
        [buildModelCallIdempotencyKey({
          jobId,
          stageId: stage.id,
          attemptNo,
          actionType: "test-agent"
        })]
      ))) {
        return "waiting_for_human";
      }

      const review = await actions.runTestAgent({
        jobId,
        executionWorkflowId,
        stageId: stage.id,
        attemptId: run.attemptId,
        attemptNo,
        outputArtifactId: run.outputArtifactId
      });

      if (review.verdict === "PASS") {
        await actions.passStageAndHandoff({
          jobId,
          stageId: stage.id,
          outputArtifactId: run.outputArtifactId,
          reportArtifactId: review.reportArtifactId
        });
        passed = true;
        break;
      }

      if (review.verdict === "NEEDS_HUMAN") {
        await actions.markJobWaitingForHuman(jobId, `Stage ${stage.id} needs human review`);
        return "waiting_for_human";
      }

      if (attemptNo < stage.maxRetries) {
        await actions.requestStageFix({
          jobId,
          stageId: stage.id,
          attemptNo,
          reportArtifactId: review.reportArtifactId
        });
      } else {
        await actions.stopAfterConsecutiveFailures({
          jobId,
          stageId: stage.id,
          attemptNo,
          reportArtifactId: review.reportArtifactId
        });
      }
    }

    if (!passed) {
      return "waiting_for_human";
    }
  }

  return "succeeded";
}

async function runSequentialPipeline(
  jobId: string,
  executionWorkflowId: string | undefined,
  stages: StageRecord[],
  actions: RoutingExecutionActions
): Promise<RoutingExecutionStatus> {
  for (const [index, stage] of stages.entries()) {
    if (await actions.isJobCancelled(jobId)) {
      return "cancelled";
    }

    const nextStage = stages[index + 1] ?? null;
    if (!(await actions.hasModelCallBudget(
      jobId,
      "stage-agent",
      stage.agentId,
      1,
      [buildModelCallIdempotencyKey({
        jobId,
        stageId: stage.id,
        attemptNo: 1,
        actionType: "stage-agent"
      })]
    ))) {
      return "waiting_for_human";
    }

    const run = await actions.runStageAgent({
      jobId,
      executionWorkflowId,
      stageId: stage.id,
      attemptNo: 1,
      routingMode: "pipeline",
      handoffTargetAgentId: nextStage?.agentId ?? "main-agent",
      outputMessageType: nextStage ? "pipeline_handoff" : "final_output"
    });
    actions.afterStageAgent(jobId, stage, 1);

    await actions.completeStageWithoutReview({
      jobId,
      stageId: stage.id,
      outputArtifactId: run.outputArtifactId,
      routingMode: "pipeline",
      linkNextStage: true
    });
  }

  return "succeeded";
}

async function runClassicMasterSlave(
  jobId: string,
  executionWorkflowId: string | undefined,
  stages: StageRecord[],
  actions: RoutingExecutionActions
): Promise<RoutingExecutionStatus> {
  if (await actions.isJobCancelled(jobId)) {
    return "cancelled";
  }
  if (stages.length === 0) {
    return "succeeded";
  }
  if (
    !(await actions.hasModelCallBudget(
      jobId,
      "stage-agent",
      "classic-worker-fanout",
      stages.length,
      stages.map((stage) => buildModelCallIdempotencyKey({
        jobId,
        stageId: stage.id,
        attemptNo: 1,
        actionType: "stage-agent"
      }))
    ))
  ) {
    return "waiting_for_human";
  }

  // DBOS assigns step IDs when these calls are started. Keep this map ordered and
  // await all results so one rejected worker cannot leave another rejection unhandled.
  const results = await Promise.allSettled(
    stages.map((stage) =>
      actions.runStageAgent({
        jobId,
        executionWorkflowId,
        stageId: stage.id,
        attemptNo: 1,
        routingMode: "classic_master_slave",
        handoffTargetAgentId: "main-agent",
        outputMessageType: "main_dispatch"
      })
    )
  );

  if (await actions.isJobCancelled(jobId)) {
    return "cancelled";
  }

  const failures: string[] = [];
  for (const [index, result] of results.entries()) {
    const stage = stages[index];
    if (!stage) {
      throw new Error(`Classic worker result has no matching stage at index ${index}`);
    }
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${stage.id}: ${reason}`);
      continue;
    }

    actions.afterStageAgent(jobId, stage, 1);

    await actions.completeStageWithoutReview({
      jobId,
      stageId: stage.id,
      outputArtifactId: result.value.outputArtifactId,
      routingMode: "classic_master_slave"
    });
  }

  if (failures.length > 0) {
    throw new Error(`Classic worker stage(s) failed: ${failures.join("; ")}`);
  }

  return "succeeded";
}

async function runMasterSlaveDiscussion(
  jobId: string,
  executionWorkflowId: string | undefined,
  stages: StageRecord[],
  discussionRounds: number,
  actions: RoutingExecutionActions
): Promise<RoutingExecutionStatus> {
  let contextArtifactIds: string[] = [];
  for (let roundNo = 1; roundNo <= discussionRounds; roundNo++) {
    if (await actions.isJobCancelled(jobId)) {
      return "cancelled";
    }

    for (const [index, stage] of stages.entries()) {
      if (await actions.isJobCancelled(jobId)) {
        return "cancelled";
      }

      const nextStage = stages.length > 1 ? stages[(index + 1) % stages.length] : null;
      if (!(await actions.hasModelCallBudget(
        jobId,
        "stage-agent",
        stage.agentId,
        1,
        [buildModelCallIdempotencyKey({
          jobId,
          stageId: stage.id,
          attemptNo: roundNo,
          actionType: "stage-agent"
        })]
      ))) {
        return "waiting_for_human";
      }

      const run = await actions.runStageAgent({
        jobId,
        executionWorkflowId,
        stageId: stage.id,
        attemptNo: roundNo,
        routingMode: "master_slave_discussion",
        handoffTargetAgentId: nextStage?.agentId ?? "main-agent",
        outputMessageType: "discussion_handoff",
        contextArtifactIds: [...contextArtifactIds]
      });
      actions.afterStageAgent(jobId, stage, roundNo);

      contextArtifactIds = normalizeDiscussionContextArtifactIds([
        ...contextArtifactIds,
        run.outputArtifactId
      ]);

      await actions.completeStageWithoutReview({
        jobId,
        stageId: stage.id,
        outputArtifactId: run.outputArtifactId,
        routingMode: "master_slave_discussion",
        roundNo
      });
    }

    await actions.recordDiscussionRound({
      jobId,
      roundNo,
      stageIds: stages.map((stage) => stage.id)
    });
  }

  return "succeeded";
}

export async function executeRoutingMode(input: {
  jobId: string;
  executionWorkflowId?: string;
  routingMode: RoutingMode;
  stages: StageRecord[];
  discussionRounds: number;
  actions: RoutingExecutionActions;
}): Promise<RoutingExecutionStatus> {
  switch (input.routingMode) {
    case "supervisor_pipeline":
      return runSupervisorPipeline(
        input.jobId,
        input.executionWorkflowId,
        input.stages,
        input.actions
      );
    case "pipeline":
      return runSequentialPipeline(
        input.jobId,
        input.executionWorkflowId,
        input.stages,
        input.actions
      );
    case "classic_master_slave":
      return runClassicMasterSlave(
        input.jobId,
        input.executionWorkflowId,
        input.stages,
        input.actions
      );
    case "master_slave_discussion":
      return runMasterSlaveDiscussion(
        input.jobId,
        input.executionWorkflowId,
        input.stages,
        input.discussionRounds,
        input.actions
      );
    default:
      throw new Error(`Unsupported routing mode: ${input.routingMode}`);
  }
}
