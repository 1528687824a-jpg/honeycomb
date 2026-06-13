import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadClusterConfig } from "../apps/dbos-worker/src/config/cluster";
import {
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

test("Chinese poster prompts add image-agent even when profile stages are fixed", () => {
  const promptStages = inferStagesFromPrompt("帮我去设计一个乒乓球的海报宣传图");
  assert.equal(promptStages.some((stage) => stage.agentId === "image-agent"), true);

  const merged = mergePromptStagesWithClusterStages(
    [
      {
        stageType: "research",
        agentId: "research-agent",
        name: "Research",
        acceptanceCriteria: ["Collect context"],
        maxRetries: 3
      },
      {
        stageType: "writer",
        agentId: "writer-agent",
        name: "Writer",
        acceptanceCriteria: ["Draft copy"],
        maxRetries: 3
      }
    ],
    promptStages
  );

  assert.deepEqual(
    merged.map((stage) => stage.agentId),
    ["research-agent", "writer-agent", "image-agent"]
  );
});
