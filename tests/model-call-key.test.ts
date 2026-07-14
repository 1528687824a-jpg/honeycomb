import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildModelCallIdempotencyKey,
  missingModelCallKeys,
  normalizeModelCallKeys
} from "../packages/shared/src/model-call-key";

test("model-call keys stay compatible with persisted worker calls", () => {
  assert.equal(
    buildModelCallIdempotencyKey({
      jobId: "JOB-1",
      stageId: "STAGE-2",
      attemptNo: 3,
      actionType: "test-agent"
    }),
    "JOB-1:STAGE-2:3:test-agent"
  );
  assert.equal(
    buildModelCallIdempotencyKey({
      jobId: "JOB-1",
      stageId: null,
      attemptNo: 1,
      actionType: "main-agent-synthesis"
    }),
    "JOB-1:job:1:main-agent-synthesis"
  );
});

test("resume budgets count only model-call keys that do not exist yet", () => {
  const requested = normalizeModelCallKeys(["call-a", " call-b ", "call-b", "call-c"]);
  assert.deepEqual(requested, ["call-a", "call-b", "call-c"]);
  assert.deepEqual(
    missingModelCallKeys(requested, new Set(["call-a", "call-c"])),
    ["call-b"]
  );
  assert.deepEqual(
    missingModelCallKeys(requested, new Set(requested)),
    []
  );
});
