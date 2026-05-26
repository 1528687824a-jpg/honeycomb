import { DBOS } from "@dbos-inc/dbos-sdk";
import type { JobWorkflowInput } from "../../../packages/shared/src/types";
import { WORKFLOW_NAME } from "../../../packages/shared/src/constants";
import * as activities from "./activities";
import { maybeCrashOnce } from "./test-crash";

const retryingStepConfig = {
  retriesAllowed: true,
  intervalSeconds: 1,
  maxAttempts: 3
};

const finalizeJob = DBOS.registerStep(activities.finalizeJob, {
  name: "finalizeJob",
  ...retryingStepConfig
});
const createPipelinePlan = DBOS.registerStep(activities.createPipelinePlan, {
  name: "createPipelinePlan",
  ...retryingStepConfig
});
const markJobRunning = DBOS.registerStep(activities.markJobRunning, {
  name: "markJobRunning",
  ...retryingStepConfig
});
const markJobWaitingForHuman = DBOS.registerStep(activities.markJobWaitingForHuman, {
  name: "markJobWaitingForHuman",
  ...retryingStepConfig
});
const passStageAndHandoff = DBOS.registerStep(activities.passStageAndHandoff, {
  name: "passStageAndHandoff",
  ...retryingStepConfig
});
const prepareJobWorkspace = DBOS.registerStep(activities.prepareJobWorkspace, {
  name: "prepareJobWorkspace",
  ...retryingStepConfig
});
const requestStageFix = DBOS.registerStep(activities.requestStageFix, {
  name: "requestStageFix",
  ...retryingStepConfig
});
const runStageAgent = DBOS.registerStep(activities.runStageAgent, {
  name: "runStageAgent",
  ...retryingStepConfig
});
const runTestAgent = DBOS.registerStep(activities.runTestAgent, {
  name: "runTestAgent",
  ...retryingStepConfig
});
const stopAfterConsecutiveFailures = DBOS.registerStep(activities.stopAfterConsecutiveFailures, {
  name: "stopAfterConsecutiveFailures",
  ...retryingStepConfig
});

async function jobPipelineWorkflow(input: JobWorkflowInput) {
  await markJobRunning(input.jobId);
  const prepared = await prepareJobWorkspace(input.jobId);
  const stages = await createPipelinePlan({
    jobId: input.jobId,
    userRequestArtifactId: prepared.userRequestArtifactId
  });

  for (const stage of stages) {
    let passed = false;

    for (let attemptNo = 1; attemptNo <= stage.maxRetries; attemptNo++) {
      const run = await runStageAgent({
        jobId: input.jobId,
        stageId: stage.id,
        attemptNo
      });
      maybeCrashOnce(
        `after-runStageAgent-stage-${stage.stageIndex.toString().padStart(3, "0")}-attempt-${attemptNo
          .toString()
          .padStart(2, "0")}`,
        input.jobId
      );

      const review = await runTestAgent({
        jobId: input.jobId,
        stageId: stage.id,
        attemptId: run.attemptId,
        attemptNo,
        outputArtifactId: run.outputArtifactId
      });

      if (review.verdict === "PASS") {
        await passStageAndHandoff({
          jobId: input.jobId,
          stageId: stage.id,
          outputArtifactId: run.outputArtifactId,
          reportArtifactId: review.reportArtifactId
        });
        passed = true;
        break;
      }

      if (review.verdict === "NEEDS_HUMAN") {
        await markJobWaitingForHuman(input.jobId, `Stage ${stage.id} needs human review`);
        return {
          jobId: input.jobId,
          status: "waiting_for_human"
        };
      }

      if (attemptNo < stage.maxRetries) {
        await requestStageFix({
          jobId: input.jobId,
          stageId: stage.id,
          attemptNo,
          reportArtifactId: review.reportArtifactId
        });
      } else {
        await stopAfterConsecutiveFailures({
          jobId: input.jobId,
          stageId: stage.id,
          attemptNo,
          reportArtifactId: review.reportArtifactId
        });
      }
    }

    if (!passed) {
      return {
        jobId: input.jobId,
        status: "waiting_for_human"
      };
    }
  }

  await finalizeJob(input.jobId);

  return {
    jobId: input.jobId,
    status: "succeeded"
  };
}

export const JobPipelineWorkflow = DBOS.registerWorkflow(jobPipelineWorkflow, {
  name: WORKFLOW_NAME
});
