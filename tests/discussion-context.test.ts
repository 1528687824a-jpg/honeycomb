import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISCUSSION_CONTEXT_ARTIFACT_LIMIT,
  normalizeDiscussionContextArtifactIds
} from "../apps/dbos-worker/src/discussion-context";

test("discussion context preserves order, removes duplicates, and stays bounded", () => {
  const artifactIds = Array.from(
    { length: DISCUSSION_CONTEXT_ARTIFACT_LIMIT + 3 },
    (_, index) => `artifact-${index + 1}`
  );
  const normalized = normalizeDiscussionContextArtifactIds([
    " ",
    artifactIds[0]!,
    artifactIds[0]!,
    ...artifactIds.slice(1),
    "artifact-9"
  ]);

  assert.equal(normalized.length, DISCUSSION_CONTEXT_ARTIFACT_LIMIT);
  assert.equal(normalized[0], "artifact-4");
  assert.equal(normalized.at(-1), `artifact-${DISCUSSION_CONTEXT_ARTIFACT_LIMIT + 3}`);
});
