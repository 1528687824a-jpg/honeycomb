import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  formatPanelPromptSnapshot,
  loadPanelPromptSnapshot
} from "../apps/orchestrator-api/src/panel-prompt-context";
import type { AgentConfigRecord } from "../packages/shared/src/types";

function panelAgent(overrides: Partial<AgentConfigRecord> = {}): AgentConfigRecord {
  return {
    id: "panel-agent",
    displayName: "Panel Agent",
    agentRole: "panel_supervisor",
    required: true,
    enabled: true,
    providerId: "provider-panel",
    model: "chat-model",
    apiKeyConfigured: true,
    apiKeyFingerprint: "fingerprint",
    workspacePath: null,
    promptTemplatePath: null,
    tools: [],
    openclawSyncStatus: "synced",
    openclawAgentPath: null,
    lastSyncedAt: null,
    lastError: null,
    metadata: {},
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

test("panel chat loads its current AGENTS.md before planning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honeycomb-panel-prompt-"));
  try {
    const promptPath = path.join(root, "AGENTS.md");
    await writeFile(promptPath, "Choose agents dynamically for every task.\n", "utf8");
    const snapshot = await loadPanelPromptSnapshot(panelAgent({ openclawAgentPath: promptPath }));

    assert.equal(snapshot.path, promptPath);
    assert.match(snapshot.contents ?? "", /Choose agents dynamically/);
    assert.match(formatPanelPromptSnapshot(snapshot), /AGENTS\.md prompt snapshot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("panel prompt snapshot reports a missing configuration without throwing", async () => {
  const snapshot = await loadPanelPromptSnapshot(panelAgent());
  assert.equal(snapshot.contents, null);
  assert.equal(snapshot.error, "panel_agent_prompt_path_not_configured");
});
