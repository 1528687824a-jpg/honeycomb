import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverOpenClawRuntime } from "./openclaw-runtime";

const execFileAsync = promisify(execFile);

export type OpenClawRuntimeAction = "status" | "start" | "restart" | "stop";

export type OpenClawRuntimeCommandResult = {
  configured: boolean;
  ok: boolean;
  action: OpenClawRuntimeAction;
  command: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  message: string;
};

const commandEnv: Record<OpenClawRuntimeAction, string> = {
  status: "HONEYCOMB_OPENCLAW_STATUS_COMMAND",
  start: "HONEYCOMB_OPENCLAW_START_COMMAND",
  restart: "HONEYCOMB_OPENCLAW_RESTART_COMMAND",
  stop: "HONEYCOMB_OPENCLAW_STOP_COMMAND"
};

function commandPreview(command: string[]) {
  return command
    .map((part) => (/\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(" ");
}

function parseCommandSpec(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed.filter((item) => item.trim());
    }
  } catch {
    // Fall through to single executable mode.
  }

  return [trimmed];
}

function clipOutput(value: string) {
  return value.slice(0, 8000);
}

export async function getOpenClawRuntimeControlStatus(input: {
  rootPath?: string;
} = {}) {
  const discovery = await discoverOpenClawRuntime(input.rootPath);
  const commands = Object.fromEntries(
    (Object.keys(commandEnv) as OpenClawRuntimeAction[]).map((action) => [
      action,
      Boolean(parseCommandSpec(process.env[commandEnv[action]]))
    ])
  ) as Record<OpenClawRuntimeAction, boolean>;

  return {
    checkedAt: new Date().toISOString(),
    runtime: discovery.selected,
    manageable: Object.values(commands).some(Boolean),
    commands,
    commandEnv,
    nextActions: discovery.nextActions
  };
}

export async function runOpenClawRuntimeCommand(
  action: OpenClawRuntimeAction,
  input: {
    timeoutMs?: number;
  } = {}
): Promise<OpenClawRuntimeCommandResult> {
  const spec = parseCommandSpec(process.env[commandEnv[action]]);
  if (!spec || spec.length === 0) {
    return {
      configured: false,
      ok: false,
      action,
      command: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      message: `${commandEnv[action]} is not configured`
    };
  }

  const [filePath, ...args] = spec;
  try {
    const result = await execFileAsync(filePath, args, {
      timeout: input.timeoutMs ?? 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return {
      configured: true,
      ok: true,
      action,
      command: commandPreview(spec),
      exitCode: 0,
      stdout: clipOutput(result.stdout),
      stderr: clipOutput(result.stderr),
      message: "command_completed"
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    return {
      configured: true,
      ok: false,
      action,
      command: commandPreview(spec),
      exitCode: typeof failure.code === "number" ? failure.code : null,
      stdout: clipOutput(failure.stdout ?? ""),
      stderr: clipOutput(failure.stderr ?? failure.message ?? ""),
      message: "command_failed"
    };
  }
}
