import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
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

type OpenClawRuntimeCommandInput = {
  rootPath?: string;
  timeoutMs?: number;
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

function defaultRuntimeRoot(inputRootPath?: string) {
  return path.resolve(
    inputRootPath?.trim() ||
    process.env.HONEYCOMB_OPENCLAW_RUNTIME_DIR?.trim() ||
    path.resolve(".runtime", "openclaw")
  );
}

async function writeDefaultRuntimeState(input: {
  action: OpenClawRuntimeAction;
  rootPath: string;
}) {
  await fs.mkdir(path.join(input.rootPath, "agents"), { recursive: true });
  await fs.mkdir(path.join(input.rootPath, "workspace"), { recursive: true });
  await fs.mkdir(path.join(input.rootPath, "config"), { recursive: true });
  const statePath = path.join(input.rootPath, "runtime-control-state.json");
  const state = {
    schemaVersion: "honeycomb.openclaw.runtime-control.v1",
    managedBy: "honeycomb-default-control",
    action: input.action,
    updatedAt: new Date().toISOString(),
    rootPath: input.rootPath
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return statePath;
}

async function runDefaultRuntimeCommand(
  action: OpenClawRuntimeAction,
  input: OpenClawRuntimeCommandInput = {}
): Promise<OpenClawRuntimeCommandResult> {
  if (action === "status") {
    const discovery = await discoverOpenClawRuntime(input.rootPath);
    return {
      configured: true,
      ok: Boolean(discovery.selected && discovery.selected.status !== "missing"),
      action,
      command: "builtin:openclaw-runtime-status",
      exitCode: discovery.selected ? 0 : 1,
      stdout: clipOutput(JSON.stringify({
        checkedAt: discovery.checkedAt,
        selected: discovery.selected,
        defaultControl: true
      })),
      stderr: "",
      message: discovery.selected ? "runtime_detected" : "runtime_not_found"
    };
  }

  const rootPath = defaultRuntimeRoot(input.rootPath);
  if (action === "start" || action === "restart") {
    const statePath = await writeDefaultRuntimeState({ action, rootPath });
    return {
      configured: true,
      ok: true,
      action,
      command: `builtin:openclaw-runtime-${action}`,
      exitCode: 0,
      stdout: clipOutput(JSON.stringify({
        rootPath,
        statePath,
        preparedDirectories: ["agents", "workspace", "config"]
      })),
      stderr: "",
      message: "runtime_prepared"
    };
  }

  const statePath = await writeDefaultRuntimeState({ action, rootPath });
  return {
    configured: true,
    ok: true,
    action,
    command: "builtin:openclaw-runtime-stop",
    exitCode: 0,
    stdout: clipOutput(JSON.stringify({ rootPath, statePath })),
    stderr: "",
    message: "runtime_marked_stopped"
  };
}

export async function getOpenClawRuntimeControlStatus(input: {
  rootPath?: string;
} = {}) {
  const discovery = await discoverOpenClawRuntime(input.rootPath);
  const envCommands = Object.fromEntries(
    (Object.keys(commandEnv) as OpenClawRuntimeAction[]).map((action) => [
      action,
      Boolean(parseCommandSpec(process.env[commandEnv[action]]))
    ])
  ) as Record<OpenClawRuntimeAction, boolean>;
  const commands = Object.fromEntries(
    (Object.keys(commandEnv) as OpenClawRuntimeAction[]).map((action) => [action, true])
  ) as Record<OpenClawRuntimeAction, boolean>;

  return {
    checkedAt: new Date().toISOString(),
    runtime: discovery.selected,
    manageable: true,
    commandMode: Object.values(envCommands).some(Boolean) ? "env-or-builtin" : "builtin",
    commands,
    envCommands,
    commandEnv,
    nextActions: discovery.nextActions
  };
}

export async function runOpenClawRuntimeCommand(
  action: OpenClawRuntimeAction,
  input: OpenClawRuntimeCommandInput = {}
): Promise<OpenClawRuntimeCommandResult> {
  const spec = parseCommandSpec(process.env[commandEnv[action]]);
  if (!spec || spec.length === 0) {
    return runDefaultRuntimeCommand(action, input);
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
