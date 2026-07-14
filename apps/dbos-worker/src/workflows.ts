import { DBOS } from "@dbos-inc/dbos-sdk";
import type {
  JobWorkflowInput,
  RoutingMode,
  StageRecord
} from "../../../packages/shared/src/types";
import { WORKFLOW_NAME } from "../../../packages/shared/src/constants";
import { buildModelCallIdempotencyKey } from "../../../packages/shared/src/model-call-key";
import * as activities from "./activities";
import { shouldRetryModelCallStep } from "./model-call-retry";
import {
  executeRoutingMode,
  type ModelCallActionType,
  type RoutingExecutionActions
} from "./routing-execution";
import { maybeCrashOnce } from "./test-crash";

const retryingStepConfig = {
  retriesAllowed: true,
  intervalSeconds: 1,
  maxAttempts: 3
};

const modelCallingStepConfig = {
  ...retryingStepConfig,
  shouldRetry: shouldRetryModelCallStep
};

const completeStageWithoutReview = DBOS.registerStep(activities.completeStageWithoutReview, {
  name: "completeStageWithoutReview",
  ...retryingStepConfig
});
const enforceModelCallBudget = DBOS.registerStep(activities.enforceModelCallBudget, {
  name: "enforceModelCallBudget",
  ...retryingStepConfig
});
const finalizeJob = DBOS.registerStep(activities.finalizeJob, {
  name: "finalizeJob",
  ...retryingStepConfig
});
const getLatestStageOutputArtifactId = DBOS.registerStep(activities.getLatestStageOutputArtifactId, {
  name: "getLatestStageOutputArtifactId",
  ...retryingStepConfig
});
const createPipelinePlan = DBOS.registerStep(activities.createPipelinePlan, {
  name: "createPipelinePlan",
  ...retryingStepConfig
});
const getJobRoutingMode = DBOS.registerStep(activities.getJobRoutingMode, {
  name: "getJobRoutingMode",
  ...retryingStepConfig
});
const getJobDiscussionRounds = DBOS.registerStep(activities.getJobDiscussionRounds, {
  name: "getJobDiscussionRounds",
  ...retryingStepConfig
});
const markJobRunning = DBOS.registerStep(activities.markJobRunning, {
  name: "markJobRunning",
  ...retryingStepConfig
});
const assertJobExecutionClaim = DBOS.registerStep(activities.assertJobExecutionClaim, {
  name: "assertJobExecutionClaim",
  ...retryingStepConfig
});
const getJobExecutionWorkflowId = DBOS.registerStep(activities.getJobExecutionWorkflowId, {
  name: "getJobExecutionWorkflowId",
  ...retryingStepConfig
});
const isJobCancelled = DBOS.registerStep(activities.isJobCancelled, {
  name: "isJobCancelled",
  ...retryingStepConfig
});
const isArtifactDeliveryReadyForFinalization = DBOS.registerStep(
  activities.isArtifactDeliveryReadyForFinalization,
  {
    name: "isArtifactDeliveryReadyForFinalization",
    ...retryingStepConfig
  }
);
const markJobWaitingForHuman = DBOS.registerStep(activities.markJobWaitingForHuman, {
  name: "markJobWaitingForHuman",
  ...retryingStepConfig
});
const ensureJobExecutionReady = DBOS.registerStep(activities.ensureJobExecutionReady, {
  name: "ensureJobExecutionReady",
  ...retryingStepConfig
});
const ensureJobWaitingForHuman = DBOS.registerStep(activities.ensureJobWaitingForHuman, {
  name: "ensureJobWaitingForHuman",
  ...retryingStepConfig
});
const markJobFailed = DBOS.registerStep(activities.markJobFailed, {
  name: "markJobFailed",
  ...retryingStepConfig
});
const mainAgentSynthesizeDiscussion = DBOS.registerStep(activities.mainAgentSynthesizeDiscussion, {
  name: "mainAgentSynthesizeDiscussion",
  ...modelCallingStepConfig
});
const mainAgentSynthesizeClassic = DBOS.registerStep(activities.mainAgentSynthesizeClassic, {
  name: "mainAgentSynthesizeClassic",
  ...modelCallingStepConfig
});
const passStageAndHandoff = DBOS.registerStep(activities.passStageAndHandoff, {
  name: "passStageAndHandoff",
  ...retryingStepConfig
});
const prepareJobWorkspace = DBOS.registerStep(activities.prepareJobWorkspace, {
  name: "prepareJobWorkspace",
  ...retryingStepConfig
});
const recordDiscussionRound = DBOS.registerStep(activities.recordDiscussionRound, {
  name: "recordDiscussionRound",
  ...retryingStepConfig
});
const requestStageFix = DBOS.registerStep(activities.requestStageFix, {
  name: "requestStageFix",
  ...retryingStepConfig
});
const runStageAgent = DBOS.registerStep(activities.runStageAgent, {
  name: "runStageAgent",
  ...modelCallingStepConfig
});
const runTestAgent = DBOS.registerStep(activities.runTestAgent, {
  name: "runTestAgent",
  ...modelCallingStepConfig
});
const runFinalTestAgent = DBOS.registerStep(activities.runFinalTestAgent, {
  name: "runFinalTestAgent",
  ...modelCallingStepConfig
});
const shouldRunFinalQualityGate = DBOS.registerStep(activities.shouldRunFinalQualityGate, {
  name: "shouldRunFinalQualityGate",
  ...retryingStepConfig
});
const stopAfterConsecutiveFailures = DBOS.registerStep(activities.stopAfterConsecutiveFailures, {
  name: "stopAfterConsecutiveFailures",
  ...retryingStepConfig
});

function crashAfterStageAgent(jobId: string, stage: StageRecord, attemptNo: number) {
  maybeCrashOnce(
    `after-runStageAgent-stage-${stage.stageIndex.toString().padStart(3, "0")}-attempt-${attemptNo
      .toString()
      .padStart(2, "0")}`,
    jobId
  );
}

async function hasModelCallBudget(
  jobId: string,
  nextActionType: ModelCallActionType,
  nextAgentId: string,
  requiredCalls?: number,
  modelCallKeys?: string[]
) {
  const budget = await enforceModelCallBudget({
    jobId,
    nextActionType,
    nextAgentId,
    requiredCalls,
    modelCallKeys
  });
  return budget.allowed;
}

const routingExecutionActions: RoutingExecutionActions = {
  isJobCancelled,
  hasModelCallBudget,
  runStageAgent,
  afterStageAgent: crashAfterStageAgent,
  runTestAgent,
  passStageAndHandoff,
  markJobWaitingForHuman,
  requestStageFix,
  stopAfterConsecutiveFailures,
  completeStageWithoutReview,
  recordDiscussionRound
};

function workflowErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runJobPipelineWorkflow(input: JobWorkflowInput) {
  if (await isJobCancelled(input.jobId)) {
    return {
      jobId: input.jobId,
      status: "cancelled"
    };
  }
  const executionWorkflowId = DBOS.workflowID ??
    input.workflowId ??
    await getJobExecutionWorkflowId(input.jobId);
  await assertJobExecutionClaim({
    jobId: input.jobId,
    workflowId: executionWorkflowId
  });

  if (await isArtifactDeliveryReadyForFinalization(input.jobId)) {
    await markJobRunning(input.jobId);
    const finalized = await finalizeJob(input.jobId);
    return {
      jobId: input.jobId,
      status: finalized.status
    };
  }

  const executionReadiness = await ensureJobExecutionReady(input.jobId);
  if (!executionReadiness.ready) {
    return {
      jobId: input.jobId,
      status: "waiting_for_human"
    };
  }

  await markJobRunning(input.jobId);
  if (await isJobCancelled(input.jobId)) {
    return {
      jobId: input.jobId,
      status: "cancelled"
    };
  }

  const prepared = await prepareJobWorkspace(input.jobId);
  if (await isJobCancelled(input.jobId)) {
    return {
      jobId: input.jobId,
      status: "cancelled"
    };
  }

  const stages = await createPipelinePlan({
    jobId: input.jobId,
    userRequestArtifactId: prepared.userRequestArtifactId
  });
  const routingMode = await getJobRoutingMode(input.jobId);
  const discussionRounds = routingMode === "master_slave_discussion"
    ? await getJobDiscussionRounds(input.jobId)
    : 1;
  const status = await executeRoutingMode({
    jobId: input.jobId,
    executionWorkflowId,
    routingMode,
    stages,
    discussionRounds,
    actions: routingExecutionActions
  });

  if (status === "waiting_for_human") {
    await ensureJobWaitingForHuman({
      jobId: input.jobId,
      reason: `Routing mode ${routingMode} is waiting for human input`
    });
    return {
      jobId: input.jobId,
      status
    };
  }

  if (status === "cancelled") {
    return {
      jobId: input.jobId,
      status
    };
  }

  let finalQualitySourceArtifactId: string | null = null;
  if (
    routingMode === "classic_master_slave" ||
    routingMode === "master_slave_discussion"
  ) {
    if (await isJobCancelled(input.jobId)) {
      return {
        jobId: input.jobId,
        status: "cancelled"
      };
    }

    if (!(await hasModelCallBudget(
      input.jobId,
      "main-agent-synthesis",
      "main-agent",
      1,
      [buildModelCallIdempotencyKey({
        jobId: input.jobId,
        stageId: null,
        attemptNo: 1,
        actionType: "main-agent-synthesis"
      })]
    ))) {
      await ensureJobWaitingForHuman({
        jobId: input.jobId,
        reason: "Model-call budget exhausted before main-agent-synthesis"
      });
      return {
        jobId: input.jobId,
        status: "waiting_for_human"
      };
    }

    const synthesis = routingMode === "master_slave_discussion"
      ? await mainAgentSynthesizeDiscussion({
          jobId: input.jobId,
          executionWorkflowId
        })
      : await mainAgentSynthesizeClassic({
          jobId: input.jobId,
          executionWorkflowId
        });
    finalQualitySourceArtifactId = synthesis.artifactId;
  }

  const finalGate = await shouldRunFinalQualityGate({
    jobId: input.jobId,
    routingMode
  });
  if (finalGate.enabled) {
    if (await isJobCancelled(input.jobId)) {
      return {
        jobId: input.jobId,
        status: "cancelled"
      };
    }

    if (!finalQualitySourceArtifactId) {
      finalQualitySourceArtifactId = await getLatestStageOutputArtifactId(input.jobId);
    }

    if (!(await hasModelCallBudget(
      input.jobId,
      "final-test-agent",
      "test-agent",
      1,
      [buildModelCallIdempotencyKey({
        jobId: input.jobId,
        stageId: null,
        attemptNo: 1,
        actionType: "final-test-agent"
      })]
    ))) {
      await ensureJobWaitingForHuman({
        jobId: input.jobId,
        reason: "Model-call budget exhausted before final-test-agent"
      });
      return {
        jobId: input.jobId,
        status: "waiting_for_human"
      };
    }

    const review = await runFinalTestAgent({
      jobId: input.jobId,
      executionWorkflowId,
      sourceArtifactId: finalQualitySourceArtifactId,
      routingMode
    });

    if (review.verdict !== "PASS") {
      await markJobWaitingForHuman(
        input.jobId,
        `Final quality gate failed for ${routingMode}: ${review.reportArtifactId}`
      );
      return {
        jobId: input.jobId,
        status: "waiting_for_human"
      };
    }
  }

  if (await isJobCancelled(input.jobId)) {
    return {
      jobId: input.jobId,
      status: "cancelled"
    };
  }

  await assertJobExecutionClaim({
    jobId: input.jobId,
    workflowId: executionWorkflowId
  });
  const finalized = await finalizeJob(input.jobId);
  if (finalized.status === "waiting_for_human") {
    return {
      jobId: input.jobId,
      status: "waiting_for_human"
    };
  }
  if (finalized.status === "cancelled") {
    return {
      jobId: input.jobId,
      status: "cancelled"
    };
  }

  return {
    jobId: input.jobId,
    status: "succeeded"
  };
}

async function jobPipelineWorkflow(input: JobWorkflowInput) {
  try {
    return await runJobPipelineWorkflow(input);
  } catch (error) {
    const reason = workflowErrorMessage(error);
    if (
      reason.includes("job_execution_claim_lost") ||
      reason.includes("model_call_in_progress")
    ) {
      return {
        jobId: input.jobId,
        status: "superseded",
        error: reason
      };
    }
    const persistedStatus = await markJobFailed(input.jobId, reason);
    return {
      jobId: input.jobId,
      status: persistedStatus,
      error: reason
    };
  }
}

export const JobPipelineWorkflow = DBOS.registerWorkflow(jobPipelineWorkflow, {
  name: WORKFLOW_NAME
});
