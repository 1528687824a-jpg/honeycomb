import {
  isLikelyImageGenerationModel,
  isLikelyMediaGenerationModel,
  isLikelyVideoGenerationModel
} from "./model-capabilities";

export type AgentModelVerificationKind = "chat" | "image_generation" | "video_generation";

export function selectAgentModelVerificationKind(agent: { agentRole: string }, model: string): {
  kind: AgentModelVerificationKind;
  mismatch: null;
} | {
  kind: null;
  mismatch: {
    reason: "agent_model_kind_mismatch";
    message: string;
  };
} {
  const role = agent.agentRole;
  const imageModel = isLikelyImageGenerationModel(model);
  const videoModel = isLikelyVideoGenerationModel(model);

  if (role === "image") {
    if (videoModel) {
      return {
        kind: null,
        mismatch: {
          reason: "agent_model_kind_mismatch",
          message: "Video generation models should be configured on the video agent."
        }
      };
    }
    return {
      kind: "image_generation",
      mismatch: null
    };
  }

  if (role === "video") {
    if (imageModel) {
      return {
        kind: null,
        mismatch: {
          reason: "agent_model_kind_mismatch",
          message: "Image generation models should be configured on the image agent."
        }
      };
    }
    return {
      kind: "video_generation",
      mismatch: null
    };
  }

  if (isLikelyMediaGenerationModel(model)) {
    return {
      kind: null,
      mismatch: {
        reason: "agent_model_kind_mismatch",
        message: "Media generation models can only be configured on the image or video agent."
      }
    };
  }

  return {
    kind: "chat",
    mismatch: null
  };
}
