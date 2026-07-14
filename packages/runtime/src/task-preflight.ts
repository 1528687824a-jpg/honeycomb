import {
  isLikelyImageGenerationModel,
  isLikelyMediaGenerationModel,
  isLikelyVideoGenerationModel
} from "../../shared/src/model-capabilities";
import {
  normalizeOpenClawAgentRunner,
  resolveOpenClawAgentRunner
} from "../../shared/src/openclaw-runner";
import type {
  TaskExecutionPreflight,
  TaskOrchestrationPlan,
  TaskPreflightAgent,
  TaskPreflightIssue,
  TaskPreflightRoute
} from "../../shared/src/types";
import {
  redactAgentRuntime,
  resolveAgentRuntimeCandidates,
  type AgentRuntimeRoute
} from "./agent-runtime";

export type AgentRequirement = {
  agentId: string;
  purpose: TaskPreflightAgent["purpose"];
  stageTypes: string[];
};

function unique(values: string[]) {
  return [...new Set(values)];
}

export function taskAgentRequirements(plan: TaskOrchestrationPlan): AgentRequirement[] {
  const requirements = new Map<string, AgentRequirement>();
  for (const stage of plan.stages) {
    const existing = requirements.get(stage.agentId);
    requirements.set(stage.agentId, {
      agentId: stage.agentId,
      purpose: existing?.purpose ?? "production",
      stageTypes: unique([...(existing?.stageTypes ?? []), stage.stageType])
    });
  }

  const qualityAgentId = plan.qualityGate.agentId ?? "test-agent";
  if (!requirements.has(qualityAgentId)) {
    requirements.set(qualityAgentId, {
      agentId: qualityAgentId,
      purpose: "quality_gate",
      stageTypes: ["review"]
    });
  }

  if (plan.routingMode === "master_slave_discussion" && !requirements.has("main-agent")) {
    requirements.set("main-agent", {
      agentId: "main-agent",
      purpose: "synthesis",
      stageTypes: ["synthesis"]
    });
  }

  return [...requirements.values()];
}

function issue(input: {
  code: string;
  severity: TaskPreflightIssue["severity"];
  agentId: string;
  route: AgentRuntimeRoute;
  message: string;
}): TaskPreflightIssue {
  return {
    code: input.code,
    severity: input.severity,
    agentId: input.agentId,
    providerId: input.route.providerId,
    model: input.route.model,
    message: input.message
  };
}

function routeWarningMessage(code: string) {
  switch (code) {
    case "agent_config_not_found":
      return "The selected agent is not registered.";
    case "agent_disabled":
      return "The selected agent is disabled.";
    case "provider_not_bound":
      return "The agent is not bound to a model provider.";
    case "provider_not_found":
      return "The configured model provider no longer exists.";
    case "provider_api_key_missing":
      return "The configured provider API key is missing from local secret storage.";
    case "model_not_configured":
      return "The agent does not have a model configured.";
    default:
      return code;
  }
}

export function evaluateTaskPreflightRoute(input: {
  requirement: AgentRequirement;
  route: AgentRuntimeRoute;
  routeIndex: number;
  mode: "mock" | "real";
}): TaskPreflightRoute {
  const issues: TaskPreflightIssue[] = [];
  const alwaysBlockingCodes = new Set(["agent_config_not_found", "agent_disabled"]);
  const realModeBlockingCodes = new Set([
    "provider_not_bound",
    "provider_not_found",
    "provider_api_key_missing",
    "model_not_configured"
  ]);

  for (const warning of unique(input.route.warnings)) {
    if (alwaysBlockingCodes.has(warning) || (input.mode === "real" && realModeBlockingCodes.has(warning))) {
      issues.push(issue({
        code: warning,
        severity: "blocking",
        agentId: input.requirement.agentId,
        route: input.route,
        message: routeWarningMessage(warning)
      }));
    }
  }

  if (input.mode === "real") {
    if (input.route.providerId && !input.route.providerBaseUrl) {
      issues.push(issue({
        code: "provider_base_url_missing",
        severity: "blocking",
        agentId: input.requirement.agentId,
        route: input.route,
        message: "The configured provider does not have a base URL."
      }));
    }
    if (input.route.providerVerificationStatus === "failed") {
      issues.push(issue({
        code: "provider_verification_failed",
        severity: "blocking",
        agentId: input.requirement.agentId,
        route: input.route,
        message: "The provider's most recent connection verification failed."
      }));
    } else if (input.route.providerVerificationStatus !== "succeeded") {
      issues.push(issue({
        code: "provider_verification_not_confirmed",
        severity: "warning",
        agentId: input.requirement.agentId,
        route: input.route,
        message: "The provider connection has not been verified successfully yet."
      }));
    }

    const requiresImage = input.requirement.stageTypes.includes("image");
    const requiresVideo = input.requirement.stageTypes.includes("video");
    const verifiedAsImage = input.route.verificationKind === "image_generation";
    const verifiedAsVideo = input.route.verificationKind === "video_generation";
    const verifiedAsChat = input.route.verificationKind === "chat";
    if (requiresImage && !verifiedAsImage && !isLikelyImageGenerationModel(input.route.model)) {
      issues.push(issue({
        code: "image_generation_model_required",
        severity: "blocking",
        agentId: input.requirement.agentId,
        route: input.route,
        message: "This image stage requires a recognized image-generation model."
      }));
    }
    if (requiresVideo && !verifiedAsVideo && !isLikelyVideoGenerationModel(input.route.model)) {
      issues.push(issue({
        code: "video_generation_model_required",
        severity: "blocking",
        agentId: input.requirement.agentId,
        route: input.route,
        message: "This video stage requires a recognized video-generation model."
      }));
    }
    if (
      !requiresImage &&
      !requiresVideo &&
      !verifiedAsChat &&
      (verifiedAsImage || verifiedAsVideo || isLikelyMediaGenerationModel(input.route.model))
    ) {
      issues.push(issue({
        code: "chat_model_required",
        severity: "blocking",
        agentId: input.requirement.agentId,
        route: input.route,
        message: "This text, review, or synthesis stage requires a chat-capable model."
      }));
    }
  }

  return {
    routeIndex: input.routeIndex,
    source: input.route.routeSource,
    providerId: input.route.providerId,
    providerDisplayName: input.route.providerDisplayName,
    providerBaseUrl: input.route.providerBaseUrl,
    providerVerificationStatus: input.route.providerVerificationStatus,
    verificationKind: input.route.verificationKind,
    model: input.route.model,
    ready: !issues.some((entry) => entry.severity === "blocking"),
    issues
  };
}

export async function preflightTaskExecution(input: {
  plan: TaskOrchestrationPlan;
  mode?: "mock" | "real";
  runner?: "wsl" | "native" | "provider-direct";
  resolveCandidates?: typeof resolveAgentRuntimeCandidates;
}): Promise<TaskExecutionPreflight> {
  const mode = input.mode ?? (process.env.OPENCLAW_AGENT_MODE === "real" ? "real" : "mock");
  const runner = mode === "mock"
    ? "mock"
    : input.runner ?? resolveOpenClawAgentRunner({
        runner: normalizeOpenClawAgentRunner(process.env.OPENCLAW_AGENT_RUNNER)
      });
  const agents: TaskPreflightAgent[] = [];
  const resolveCandidates = input.resolveCandidates ?? resolveAgentRuntimeCandidates;

  for (const requirement of taskAgentRequirements(input.plan)) {
    const candidates = await resolveCandidates({ requestedAgentId: requirement.agentId });
    const routes = candidates.map((candidate, routeIndex) =>
      evaluateTaskPreflightRoute({
        requirement,
        route: redactAgentRuntime(candidate),
        routeIndex,
        mode
      })
    );
    const selectedRoute = routes.find((route) => route.ready) ?? null;
    agents.push({
      agentId: requirement.agentId,
      purpose: requirement.purpose,
      stageTypes: requirement.stageTypes,
      ready: Boolean(selectedRoute),
      selectedRouteIndex: selectedRoute?.routeIndex ?? null,
      routes
    });
  }

  const blockingIssues = agents.flatMap((agent) =>
    agent.ready
      ? []
      : agent.routes.flatMap((route) => route.issues.filter((entry) => entry.severity === "blocking"))
  );
  const warnings = agents.flatMap((agent) => {
    const routeWarnings = agent.routes.flatMap((route) =>
      route.issues.filter((entry) => entry.severity === "warning")
    );
    if (agent.ready && agent.selectedRouteIndex !== null && agent.selectedRouteIndex > 0) {
      const selectedRoute = agent.routes[agent.selectedRouteIndex];
      routeWarnings.push({
        code: "fallback_route_selected",
        severity: "warning",
        agentId: agent.agentId,
        providerId: selectedRoute?.providerId ?? null,
        model: selectedRoute?.model ?? null,
        message: "The primary route is unavailable; a configured fallback route will be used."
      });
    }
    return routeWarnings;
  });

  return {
    version: "honeycomb.task-preflight.v1",
    status: blockingIssues.length ? "blocked" : mode === "mock" ? "simulation" : "ready",
    mode,
    runner,
    checkedAt: new Date().toISOString(),
    agents,
    blockingIssues,
    warnings
  };
}
