import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractArtifactFileRefs,
  resolveArtifactFilePath
} from "../apps/orchestrator-api/src/artifact-files";
import type { ArtifactRecord } from "../packages/shared/src/types";

function artifact(overrides: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    id: "ART-1",
    jobId: "JOB-1",
    stageId: "STAGE-1",
    type: "stage_output",
    title: "Stage output",
    content: null,
    uri: null,
    metadata: {},
    createdAt: "2026-06-25T00:00:00.000Z",
    ...overrides
  };
}

test("extractArtifactFileRefs returns safe task files and generated media files", () => {
  const root = path.join(os.tmpdir(), "honeycomb-job-data");
  const jobRoot = path.join(root, "JOB-1");
  const outputMd = path.join(jobRoot, "stages", "001-image", "output-attempt-1.md");
  const stateJson = path.join(jobRoot, "stages", "001-image", "stage-output.json");
  const imagePath = path.join(jobRoot, "stages", "001-image", "poster.jpg");

  const refs = extractArtifactFileRefs(
    artifact({
      uri: stateJson,
      content: JSON.stringify({
        artifact_path: outputMd,
        openclaw: {
          artifacts: [
            {
              kind: "image",
              filePath: imagePath,
              url: "https://example.test/poster.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 1234,
              source: "url"
            }
          ]
        }
      }),
      metadata: {
        stateJsonPath: stateJson,
        markdownPath: outputMd
      }
    }),
    { jobDataDir: root }
  );

  assert.equal(refs.length, 3);
  assert.deepEqual(
    refs.map((ref) => ref.label),
    ["artifact-uri", "artifact-path", "generated-1"]
  );
  assert.equal(refs[2].kind, "image");
  assert.equal(refs[2].mimeType, "image/jpeg");
  assert.equal(refs[2].sizeBytes, 1234);
  assert.equal(refs[2].externalUrl, "https://example.test/poster.jpg");
});

test("resolveArtifactFilePath rejects files outside JOB_DATA_DIR", () => {
  const root = path.join(os.tmpdir(), "honeycomb-job-data");
  assert.equal(
    resolveArtifactFilePath(path.join(root, "JOB-1", "final", "final-answer.md"), root),
    path.resolve(root, "JOB-1", "final", "final-answer.md")
  );
  assert.equal(resolveArtifactFilePath(path.join(root, "..", "secret.txt"), root), null);
});
