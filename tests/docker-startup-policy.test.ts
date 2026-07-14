import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const launchers = [
  "scripts/launch-desktop-app.ps1",
  "scripts/start-dev.ps1",
  "scripts/start-desktop-tryout.ps1",
  "scripts/start-owner-tryout.ps1",
];

test("Honeycomb launchers never start Docker Desktop automatically", () => {
  for (const launcher of launchers) {
    const source = readFileSync(resolve(process.cwd(), launcher), "utf8");

    assert.doesNotMatch(source, /Start-Service\s+com\.docker\.service/i, launcher);
    assert.doesNotMatch(
      source,
      /Start-Process[^\r\n]*(?:Docker Desktop|\$dockerDesktop)/i,
      launcher,
    );
    assert.match(
      source,
      /does not start Docker Desktop automatically/i,
      launcher,
    );
  }
});
