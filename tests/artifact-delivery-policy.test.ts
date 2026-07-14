import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRequiredMediaDeliverables } from "../packages/shared/src/artifact-delivery-policy";
import type { TaskDeliverable } from "../packages/shared/src/types";

function deliverable(overrides: Partial<TaskDeliverable> = {}): TaskDeliverable {
  return {
    kind: "image",
    description: "Poster",
    required: true,
    format: "png",
    width: 1080,
    height: 1920,
    target: "desktop",
    targetPath: null,
    ...overrides
  };
}

test("a required media deliverable needs a non-empty local file in the requested format", () => {
  const passed = assessRequiredMediaDeliverables({
    deliverables: [deliverable()],
    candidates: [{
      kind: "image",
      filePath: "/jobs/poster.png",
      mimeType: "application/octet-stream",
      sizeBytes: 100,
      width: 1080,
      height: 1920,
      localAvailable: true
    }]
  });
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.matches, [{ deliverableIndex: 0, candidateIndex: 0 }]);

  const urlOnly = assessRequiredMediaDeliverables({
    deliverables: [deliverable()],
    candidates: [{
      kind: "image",
      filePath: null,
      mimeType: "image/png",
      sizeBytes: null,
      width: null,
      height: null,
      localAvailable: false
    }]
  });
  assert.deepEqual(urlOnly.issues, [{
    deliverableIndex: 0,
    kind: "image",
    format: "png",
    reason: "local_file_missing"
  }]);
});

test("media format mismatches and asynchronous task receipts cannot complete delivery", () => {
  const wrongFormat = assessRequiredMediaDeliverables({
    deliverables: [deliverable()],
    candidates: [{
      kind: "image",
      filePath: "/jobs/poster.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      width: 1080,
      height: 1920,
      localAvailable: true
    }]
  });
  assert.equal(wrongFormat.issues[0]?.reason, "format_mismatch");

  const misleadingMimeType = assessRequiredMediaDeliverables({
    deliverables: [deliverable()],
    candidates: [{
      kind: "image",
      filePath: "/jobs/poster.png",
      mimeType: "image/png",
      detectedFormat: "jpeg",
      sizeBytes: 100,
      width: 1080,
      height: 1920,
      localAvailable: true
    }]
  });
  assert.equal(misleadingMimeType.issues[0]?.reason, "format_mismatch");

  const pendingVideo = assessRequiredMediaDeliverables({
    deliverables: [deliverable({ kind: "video", format: "mp4" })],
    candidates: []
  });
  assert.equal(pendingVideo.ok, false);
  assert.equal(pendingVideo.issues[0]?.reason, "local_file_missing");
});

test("required image dimensions must be readable and exact", () => {
  const missingDimensions = assessRequiredMediaDeliverables({
    deliverables: [deliverable()],
    candidates: [{
      kind: "image",
      filePath: "/jobs/poster.png",
      mimeType: "image/png",
      sizeBytes: 100,
      width: null,
      height: null,
      localAvailable: true
    }]
  });
  assert.equal(missingDimensions.issues[0]?.reason, "dimensions_missing");

  const wrongDimensions = assessRequiredMediaDeliverables({
    deliverables: [deliverable()],
    candidates: [{
      kind: "image",
      filePath: "/jobs/poster.png",
      mimeType: "image/png",
      sizeBytes: 100,
      width: 1024,
      height: 1792,
      localAvailable: true
    }]
  });
  assert.equal(wrongDimensions.issues[0]?.reason, "dimension_mismatch");
});

test("required video format and dimensions come from inspected file metadata", () => {
  const passed = assessRequiredMediaDeliverables({
    deliverables: [deliverable({ kind: "video", format: "mp4" })],
    candidates: [{
      kind: "video",
      filePath: "/jobs/video.mp4",
      mimeType: "application/octet-stream",
      detectedFormat: "mp4",
      sizeBytes: 100,
      width: 1080,
      height: 1920,
      localAvailable: true
    }]
  });
  assert.equal(passed.ok, true);

  const misleadingExtension = assessRequiredMediaDeliverables({
    deliverables: [deliverable({ kind: "video", format: "mp4" })],
    candidates: [{
      kind: "video",
      filePath: "/jobs/video.mp4",
      mimeType: "video/mp4",
      detectedFormat: "mov",
      sizeBytes: 100,
      width: 1080,
      height: 1920,
      localAvailable: true
    }]
  });
  assert.equal(misleadingExtension.issues[0]?.reason, "format_mismatch");

  const unrecognizedFile = assessRequiredMediaDeliverables({
    deliverables: [deliverable({
      kind: "video",
      format: null,
      width: null,
      height: null
    })],
    candidates: [{
      kind: "video",
      filePath: "/jobs/video.mp4",
      mimeType: "video/mp4",
      detectedFormat: null,
      sizeBytes: 100,
      width: null,
      height: null,
      localAvailable: true
    }]
  });
  assert.equal(unrecognizedFile.issues[0]?.reason, "format_mismatch");
});

test("optional and non-media deliverables do not create a media completion gate", () => {
  const assessment = assessRequiredMediaDeliverables({
    deliverables: [
      deliverable({ required: false }),
      deliverable({ kind: "text", format: "md", target: "conversation" })
    ],
    candidates: []
  });
  assert.equal(assessment.ok, true);
  assert.deepEqual(assessment.issues, []);
});
