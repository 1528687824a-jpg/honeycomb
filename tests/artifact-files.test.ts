import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
  const documentContent = path.join(jobRoot, "stages", "001-image", "content-attempt-1.md");
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
        documentContentPath: documentContent,
        stateJsonPath: stateJson,
        markdownPath: outputMd
      }
    }),
    { jobDataDir: root }
  );

  assert.equal(refs.length, 4);
  assert.deepEqual(
    refs.map((ref) => ref.label),
    ["artifact-uri", "artifact-path", "documentContentPath", "generated-1"]
  );
  assert.equal(refs[3].kind, "image");
  assert.equal(refs[3].mimeType, "image/jpeg");
  assert.equal(refs[3].sizeBytes, 1234);
  assert.equal(refs[3].externalUrl, "https://example.test/poster.jpg");
});

test("extractArtifactFileRefs keeps generated media URLs when local download failed", () => {
  const refs = extractArtifactFileRefs(
    artifact({
      content: JSON.stringify({
        openclaw: {
          artifacts: [
            {
              kind: "image",
              filePath: null,
              url: "https://example.test/poster.jpg",
              note: "Media download failed: fetch failed",
              source: "url"
            }
          ]
        }
      })
    }),
    { jobDataDir: path.join(os.tmpdir(), "honeycomb-job-data") }
  );

  assert.equal(refs.length, 1);
  assert.equal(refs[0].label, "generated-1");
  assert.equal(refs[0].filePath, null);
  assert.equal(refs[0].fileName, "poster.jpg");
  assert.equal(refs[0].kind, "image");
  assert.equal(refs[0].externalUrl, "https://example.test/poster.jpg");
  assert.equal(refs[0].note, "Media download failed: fetch failed");
});

test("extractArtifactFileRefs reads generated media from referenced json files", () => {
  const root = path.join(os.tmpdir(), "honeycomb-job-data");
  const jobRoot = path.join(root, "JOB-JSON-REF");
  const outputJson = path.join(jobRoot, "state", "stage-002-image-output.json");
  mkdirSync(path.dirname(outputJson), { recursive: true });
  writeFileSync(
    outputJson,
    JSON.stringify({
      openclaw: {
        artifacts: [
          {
            kind: "image",
            filePath: null,
            url: "https://example.test/referenced-poster.jpg",
            source: "url"
          }
        ]
      }
    }),
    "utf8"
  );

  const refs = extractArtifactFileRefs(
    artifact({
      uri: outputJson,
      content: null
    }),
    { jobDataDir: root }
  );

  const generated = refs.find((ref) => ref.label === "referenced-generated-1");
  assert.equal(generated?.filePath, null);
  assert.equal(generated?.kind, "image");
  assert.equal(generated?.externalUrl, "https://example.test/referenced-poster.jpg");
});

test("resolveArtifactFilePath rejects files outside JOB_DATA_DIR", () => {
  const root = path.join(os.tmpdir(), "honeycomb-job-data");
  assert.equal(
    resolveArtifactFilePath(path.join(root, "JOB-1", "final", "final-answer.md"), root),
    path.resolve(root, "JOB-1", "final", "final-answer.md")
  );
  assert.equal(resolveArtifactFilePath(path.join(root, "..", "secret.txt"), root), null);
});
