import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentConfigRecord } from "../../../packages/shared/src/types";

export type PanelPromptSnapshot = {
  path: string | null;
  contents: string | null;
  error: string | null;
};

function truncate(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}

export async function loadPanelPromptSnapshot(
  agent: AgentConfigRecord,
  cwd = process.cwd()
): Promise<PanelPromptSnapshot> {
  const candidates = [
    agent.openclawAgentPath,
    agent.promptTemplatePath,
    agent.workspacePath ? path.join(agent.workspacePath, "AGENTS.md") : null
  ]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .map((candidate) => path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) {
    return {
      path: null,
      contents: null,
      error: "panel_agent_prompt_path_not_configured"
    };
  }

  const errors: string[] = [];
  for (const candidate of uniqueCandidates) {
    try {
      return {
        path: candidate,
        contents: truncate(await readFile(candidate, "utf8"), 6000),
        error: null
      };
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    path: uniqueCandidates[0] ?? null,
    contents: null,
    error: truncate(errors.join("; "), 1000)
  };
}

export function formatPanelPromptSnapshot(snapshot: PanelPromptSnapshot) {
  return snapshot.contents
    ? [
        `Panel-agent AGENTS.md prompt snapshot (${snapshot.path ?? "unknown path"}):`,
        snapshot.contents
      ].join("\n")
    : [
        "Panel-agent AGENTS.md prompt snapshot:",
        `Path: ${snapshot.path ?? "not configured"}`,
        `Unavailable: ${snapshot.error ?? "not found"}`
      ].join("\n");
}
