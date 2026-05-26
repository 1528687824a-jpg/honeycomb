import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OpenClawRunResult = {
  mode: "mock" | "real";
  sessionId: string;
  text: string;
  raw: unknown;
};

function openClawRealMode() {
  return process.env.OPENCLAW_AGENT_MODE === "real";
}

function getOpenClawCommand() {
  return process.env.OPENCLAW_CLI ?? "/home/administrator/.npm-global/bin/openclaw";
}

function getWslDistro() {
  return process.env.OPENCLAW_WSL_DISTRO ?? "Ubuntu-24.04";
}

function extractText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["text", "reply", "message", "content", "output"]) {
      if (typeof value[key] === "string") {
        return value[key] as string;
      }
    }
  }

  return JSON.stringify(raw);
}

export async function runOpenClawAgent(input: {
  agentId: string;
  sessionId: string;
  message: string;
  timeoutSeconds?: number;
}): Promise<OpenClawRunResult | null> {
  if (!openClawRealMode()) {
    return null;
  }

  const args = [
    "-d",
    getWslDistro(),
    "--",
    getOpenClawCommand(),
    "agent",
    "--agent",
    input.agentId,
    "--session-id",
    input.sessionId,
    "--message",
    input.message,
    "--json",
    "--timeout",
    String(input.timeoutSeconds ?? 600)
  ];

  const { stdout } = await execFileAsync("wsl", args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: (input.timeoutSeconds ?? 600) * 1000 + 30_000,
    windowsHide: true
  });

  const trimmed = stdout.trim();
  let raw: unknown = trimmed;

  try {
    raw = JSON.parse(trimmed);
  } catch {
    raw = trimmed;
  }

  return {
    mode: "real",
    sessionId: input.sessionId,
    text: extractText(raw),
    raw
  };
}

