import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadClusterConfig } from "../apps/dbos-worker/src/config/cluster";
import {
  describeStageSelection,
  executablePipelineStages,
  inferStagesFromPrompt,
  mergePromptStagesWithClusterStages
} from "../apps/dbos-worker/src/activities";

test("cluster config loader tolerates old desktop configs with empty description", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-cluster-"));
  const configPath = path.join(tempDir, "cluster.config.json");
  const previous = process.env.AGENT_CLUSTER_CONFIG_PATH;
  try {
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: "agent-openclaw.cluster.v1",
          clusterId: "owner-profile",
          name: "Owner Agent Cluster",
          description: "",
          defaultRoutingMode: "classic_master_slave",
          agents: [
            {
              id: "research-agent",
              role: "research",
              displayName: "Research agent",
              promptPath: "agents/research-agent/AGENTS.md",
              capabilities: ["research"]
            }
          ],
          stages: [
            {
              stageType: "research",
              agentId: "research-agent",
              name: "Research",
              acceptanceCriteria: ["Collect context"],
              maxRetries: 3
            }
          ],
          generatedAt: "2026-06-13T00:00:00.000Z",
          source: { planner: "openai-compatible", model: "deepseek-chat" }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    process.env.AGENT_CLUSTER_CONFIG_PATH = configPath;
    const config = await loadClusterConfig();
    assert.equal(config?.description, "Owner Agent Cluster");
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_CLUSTER_CONFIG_PATH;
    } else {
      process.env.AGENT_CLUSTER_CONFIG_PATH = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Chinese poster prompts select task-specific stages from fixed profile stages", () => {
  const promptStages = inferStagesFromPrompt(
    "\u5e2e\u6211\u8bbe\u8ba1\u4e00\u4e2a\u4e52\u4e53\u7403\u8bad\u7ec3\u8425\u62db\u751f\u6d77\u62a5\u5ba3\u4f20\u56fe\uff0c\u5305\u542b\u6807\u9898\u548c\u4e24\u53e5\u5ba3\u4f20\u6587\u6848\uff0c\u5e76\u751f\u6210\u56fe\u7247"
  );
  assert.deepEqual(
    promptStages.map((stage) => stage.agentId),
    ["writer-agent", "image-agent"]
  );

  const clusterStages = [
    {
      stageType: "image",
      agentId: "image-agent",
      name: "Image",
      acceptanceCriteria: ["Generate image"],
      maxRetries: 1
    },
    {
      stageType: "research",
      agentId: "research-agent",
      name: "Research",
      acceptanceCriteria: ["Collect context"],
      maxRetries: 3
    },
    {
      stageType: "video",
      agentId: "video-agent",
      name: "Video",
      acceptanceCriteria: ["Generate video"],
      maxRetries: 1
    },
    {
      stageType: "writing",
      agentId: "writer-agent",
      name: "Writer",
      acceptanceCriteria: ["Draft copy"],
      maxRetries: 2
    }
  ];

  const merged = mergePromptStagesWithClusterStages(clusterStages, promptStages);

  assert.deepEqual(
    merged.map((stage) => [stage.agentId, stage.name, stage.maxRetries]),
    [
      ["writer-agent", "Writer", 2],
      ["image-agent", "Image", 1]
    ]
  );

  const decision = describeStageSelection({
    promptStages,
    selectedStages: merged,
    clusterStages
  });

  assert.deepEqual(
    decision.selectedStages.map((stage) => stage.agentId),
    ["writer-agent", "image-agent"]
  );
  assert.equal(decision.skippedClusterStages.some((stage) => stage.agentId === "video-agent"), true);
  assert.match(
    decision.skippedClusterStages.find((stage) => stage.agentId === "video-agent")?.reason ?? "",
    /did not request video/
  );
});

test("executable pipeline stages exclude review stages and clamp retry counts", () => {
  const stages = executablePipelineStages([
    {
      stageType: "research",
      agentId: "research-agent",
      name: "Research",
      acceptanceCriteria: ["Collect context"],
      maxRetries: 0
    },
    {
      stageType: "review",
      agentId: "test-agent",
      name: "Test Agent",
      acceptanceCriteria: ["Review output"],
      maxRetries: 0
    },
    {
      stageType: "write",
      agentId: "writer-agent",
      name: "Writer",
      acceptanceCriteria: ["Draft copy"]
    }
  ]);

  assert.deepEqual(
    stages.map((stage) => [stage.agentId, stage.maxRetries]),
    [
      ["research-agent", 1],
      ["writer-agent", 3]
    ]
  );
});
