import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntimeSecrets } from "../packages/runtime/src/agent-runtime";
import {
  preflightTaskExecution,
  taskAgentRequirements
} from "../packages/runtime/src/task-preflight";
import { selectAgentModelVerificationKind } from "../packages/shared/src/agent-model-kind";
import { buildDeterministicTaskPlan } from "../packages/shared/src/orchestration-contract";

function route(
  agentId: string,
  overrides: Partial<AgentRuntimeSecrets> = {}
): AgentRuntimeSecrets {
  return {
    requestedAgentId: agentId,
    honeycombAgentId: agentId === "main-agent" ? "panel-agent" : agentId,
    openclawAgentId: agentId,
    routeSource: "primary",
    routePriority: 0,
    displayName: agentId,
    agentRole: agentId === "image-agent"
      ? "image"
      : agentId === "video-agent"
        ? "video"
        : agentId === "test-agent"
          ? "review"
          : "panel_supervisor",
    providerId: `provider-${agentId}`,
    providerDisplayName: "Test provider",
    providerBaseUrl: "https://provider.example/v1",
    providerVerificationStatus: "succeeded",
    verificationKind: agentId === "image-agent"
      ? "image_generation"
      : agentId === "video-agent"
        ? "video_generation"
        : "chat",
    providerConcurrencyLimit: null,
    agentConcurrencyLimit: null,
    model: agentId === "image-agent" ? "gpt-image-1" : "chat-model",
    apiKeyConfigured: true,
    apiKeyFingerprint: "test-fingerprint",
    apiKey: "configured-test-value",
    warnings: [],
    ...overrides
  };
}

test("task preflight derives production and quality-gate requirements", () => {
  const posterPlan = buildDeterministicTaskPlan({
    rawPrompt: "生成一张茶道宣传海报，PNG，放到桌面"
  });
  assert.deepEqual(taskAgentRequirements(posterPlan), [
    {
      agentId: "image-agent",
      purpose: "production",
      stageTypes: ["image"]
    },
    {
      agentId: "test-agent",
      purpose: "quality_gate",
      stageTypes: ["review"]
    }
  ]);

  const discussionPlan = buildDeterministicTaskPlan({
    rawPrompt: "比较两个方案，组织多方讨论后给出结论"
  });
  assert.equal(
    taskAgentRequirements(discussionPlan).some(
      (requirement) => requirement.agentId === "main-agent" && requirement.purpose === "synthesis"
    ),
    true
  );
});

test("real preflight accepts configured image and test agents", async () => {
  const plan = buildDeterministicTaskPlan({ rawPrompt: "生成一张茶道海报" });
  const result = await preflightTaskExecution({
    plan,
    mode: "real",
    runner: "provider-direct",
    resolveCandidates: async ({ requestedAgentId }) => [route(requestedAgentId)]
  });

  assert.equal(result.status, "ready");
  assert.equal(result.blockingIssues.length, 0);
  assert.deepEqual(result.agents.map((agent) => agent.agentId), ["image-agent", "test-agent"]);
});

test("real preflight blocks an image task configured with a chat model", async () => {
  const plan = buildDeterministicTaskPlan({ rawPrompt: "生成一张茶道海报" });
  const result = await preflightTaskExecution({
    plan,
    mode: "real",
    runner: "provider-direct",
    resolveCandidates: async ({ requestedAgentId }) => [
      route(requestedAgentId, requestedAgentId === "image-agent"
        ? { model: "chat-model", verificationKind: "chat" }
        : {})
    ]
  });

  assert.equal(result.status, "blocked");
  assert.equal(
    result.blockingIssues.some(
      (entry) => entry.agentId === "image-agent" && entry.code === "image_generation_model_required"
    ),
    true
  );
});

test("verified media kind accepts opaque provider endpoint model names", async () => {
  const selection = selectAgentModelVerificationKind(
    { agentRole: "image" },
    "ep-20260714-opaque-endpoint"
  );
  assert.deepEqual(selection, {
    kind: "image_generation",
    mismatch: null
  });

  const plan = buildDeterministicTaskPlan({ rawPrompt: "Generate a tea ceremony poster" });
  const result = await preflightTaskExecution({
    plan,
    mode: "real",
    runner: "provider-direct",
    resolveCandidates: async ({ requestedAgentId }) => [
      route(requestedAgentId, requestedAgentId === "image-agent"
        ? {
            model: "ep-20260714-opaque-endpoint",
            verificationKind: "image_generation"
          }
        : {})
    ]
  });

  assert.equal(result.status, "ready");
});

test("real preflight selects a viable fallback route", async () => {
  const plan = buildDeterministicTaskPlan({ rawPrompt: "生成一张茶道海报" });
  const result = await preflightTaskExecution({
    plan,
    mode: "real",
    runner: "provider-direct",
    resolveCandidates: async ({ requestedAgentId }) => requestedAgentId === "image-agent"
      ? [
          route(requestedAgentId, {
            apiKey: null,
            apiKeyConfigured: false,
            warnings: ["provider_api_key_missing"]
          }),
          route(requestedAgentId, {
            routeSource: "agent_metadata",
            routePriority: 1,
            providerId: "provider-image-fallback"
          })
        ]
      : [route(requestedAgentId)]
  });

  assert.equal(result.status, "ready");
  assert.equal(result.agents[0].selectedRouteIndex, 1);
  assert.equal(result.warnings.some((entry) => entry.code === "fallback_route_selected"), true);
});

test("mock preflight skips provider requirements but still blocks unknown agents", async () => {
  const plan = buildDeterministicTaskPlan({ rawPrompt: "生成一张茶道海报" });
  const result = await preflightTaskExecution({
    plan,
    mode: "mock",
    resolveCandidates: async ({ requestedAgentId }) => [
      route(requestedAgentId, requestedAgentId === "image-agent"
        ? {
            providerId: null,
            providerBaseUrl: null,
            model: null,
            apiKey: null,
            apiKeyConfigured: false,
            warnings: ["provider_not_bound", "model_not_configured"]
          }
        : {
            warnings: ["agent_config_not_found", "provider_not_bound", "model_not_configured"]
          })
    ]
  });

  assert.equal(result.status, "blocked");
  assert.equal(
    result.blockingIssues.some(
      (entry) => entry.agentId === "test-agent" && entry.code === "agent_config_not_found"
    ),
    true
  );
  assert.equal(
    result.blockingIssues.some((entry) => entry.code === "provider_not_bound"),
    false
  );
});
