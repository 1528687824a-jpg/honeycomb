import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  getOpenClawRuntimeControlStatus,
  runOpenClawRuntimeCommand
} from "../apps/orchestrator-api/src/openclaw-runtime-control";

const controlEnvKeys = [
  "HONEYCOMB_OPENCLAW_STATUS_COMMAND",
  "HONEYCOMB_OPENCLAW_START_COMMAND",
  "HONEYCOMB_OPENCLAW_RESTART_COMMAND",
  "HONEYCOMB_OPENCLAW_STOP_COMMAND"
];

test("OpenClaw runtime control has builtin packaged defaults", async () => {
  const previousEnv = Object.fromEntries(controlEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of controlEnvKeys) {
    delete process.env[key];
  }

  const rootPath = path.join(process.cwd(), ".runtime", `openclaw-control-${randomUUID()}`);
  try {
    const before = await getOpenClawRuntimeControlStatus({ rootPath });
    assert.equal(before.manageable, true);
    assert.equal(before.commandMode, "builtin");
    assert.equal(before.commands.start, true);

    const started = await runOpenClawRuntimeCommand("start", { rootPath });
    assert.equal(started.configured, true);
    assert.equal(started.ok, true);
    assert.equal(started.command, "builtin:openclaw-runtime-start");
    assert.equal(started.message, "runtime_prepared");
    assert.equal(await exists(path.join(rootPath, "agents")), true);
    assert.equal(await exists(path.join(rootPath, "workspace")), true);
    assert.equal(await exists(path.join(rootPath, "config")), true);

    const after = await getOpenClawRuntimeControlStatus({ rootPath });
    assert.equal(after.manageable, true);
    assert.equal(after.runtime?.rootPath, path.resolve(rootPath));
    assert.equal(after.runtime?.status, "ready");
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

async function exists(target: string) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
