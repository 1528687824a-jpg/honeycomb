import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { stageStatePaths } from "../apps/dbos-worker/src/artifact-state-paths";

test("stage retry state uses immutable attempt paths plus one stable latest path", () => {
  const first = stageStatePaths({
    stateDir: "state",
    stageIndex: 2,
    stageType: "writing",
    kind: "output",
    attemptNo: 1
  });
  const second = stageStatePaths({
    stateDir: "state",
    stageIndex: 2,
    stageType: "writing",
    kind: "output",
    attemptNo: 2
  });

  assert.equal(path.basename(first.attemptPath), "stage-002-writing-output-attempt-01.json");
  assert.equal(path.basename(second.attemptPath), "stage-002-writing-output-attempt-02.json");
  assert.notEqual(first.attemptPath, second.attemptPath);
  assert.equal(first.latestPath, second.latestPath);
  assert.equal(path.basename(first.latestPath), "stage-002-writing-output.json");
});
