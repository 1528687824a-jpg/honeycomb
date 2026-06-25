import {
  DEFAULT_DISCUSSION_ROUNDS,
  DEFAULT_MAX_MODEL_CALLS,
  DEFAULT_ROUTING_MODE,
  type RoutingMode
} from "./types";

export const DEFAULT_EXECUTABLE_STAGE_COUNT = 4;
export const MIN_JOB_MODEL_CALLS = DEFAULT_MAX_MODEL_CALLS;

export function minimumModelCallsForRoutingMode(input: {
  routingMode?: RoutingMode | null;
  executableStageCount?: number | null;
  discussionRounds?: number | null;
  classicFinalGateEnabled?: boolean | null;
}) {
  const routingMode = input.routingMode ?? DEFAULT_ROUTING_MODE;
  const executableStageCount = Math.max(1, input.executableStageCount ?? DEFAULT_EXECUTABLE_STAGE_COUNT);
  const discussionRounds = Math.max(1, input.discussionRounds ?? DEFAULT_DISCUSSION_ROUNDS);

  switch (routingMode) {
    case "pipeline":
      return executableStageCount + 1;
    case "supervisor_pipeline":
      return executableStageCount * 2;
    case "classic_master_slave":
      return executableStageCount + (input.classicFinalGateEnabled ? 1 : 0);
    case "master_slave_discussion":
      return executableStageCount * discussionRounds + 2;
    default:
      return DEFAULT_MAX_MODEL_CALLS;
  }
}

export function normalizeJobModelCallBudget(input: {
  requestedMaxModelCalls?: number | null;
  routingMode?: RoutingMode | null;
  executableStageCount?: number | null;
  discussionRounds?: number | null;
  classicFinalGateEnabled?: boolean | null;
}) {
  const requested =
    typeof input.requestedMaxModelCalls === "number" && Number.isFinite(input.requestedMaxModelCalls)
      ? Math.floor(input.requestedMaxModelCalls)
      : DEFAULT_MAX_MODEL_CALLS;

  return Math.max(
    requested,
    MIN_JOB_MODEL_CALLS,
    minimumModelCallsForRoutingMode(input)
  );
}
