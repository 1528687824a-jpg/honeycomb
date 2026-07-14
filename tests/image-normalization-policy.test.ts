import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeneratedMediaDeliveryCandidate } from "../packages/shared/src/artifact-delivery-policy";
import { planRequiredImageNormalizations } from "../packages/shared/src/image-normalization-policy";
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

function candidate(overrides: Partial<GeneratedMediaDeliveryCandidate> = {}): GeneratedMediaDeliveryCandidate {
  return {
    kind: "image",
    filePath: "/jobs/source.jpg",
    mimeType: "image/jpeg",
    detectedFormat: "jpeg",
    sizeBytes: 100,
    width: 1024,
    height: 1792,
    localAvailable: true,
    checksumSha256: "abc",
    ...overrides
  };
}

test("exact image candidates are reserved before transformable candidates are assigned", () => {
  const plan = planRequiredImageNormalizations({
    deliverables: [
      deliverable(),
      deliverable({ format: "jpeg", width: 1024, height: 1792 })
    ],
    candidates: [
      candidate(),
      candidate({ filePath: "/jobs/exact.png", detectedFormat: "png", mimeType: "image/png", width: 1080, height: 1920 })
    ]
  });
  assert.deepEqual(plan, {
    assignments: [
      { deliverableIndex: 0, candidateIndex: 1, needsNormalization: false },
      { deliverableIndex: 1, candidateIndex: 0, needsNormalization: false }
    ],
    missingDeliverableIndexes: []
  });
});

test("a non-matching local source is assigned once for deterministic normalization", () => {
  const plan = planRequiredImageNormalizations({
    deliverables: [deliverable(), deliverable({ description: "Second poster" })],
    candidates: [candidate()]
  });
  assert.deepEqual(plan.assignments, [
    { deliverableIndex: 0, candidateIndex: 0, needsNormalization: true }
  ]);
  assert.deepEqual(plan.missingDeliverableIndexes, [1]);
});

test("remote-only and unreadable images are not normalization sources", () => {
  const plan = planRequiredImageNormalizations({
    deliverables: [deliverable()],
    candidates: [
      candidate({ filePath: null, localAvailable: false }),
      candidate({ detectedFormat: null, width: null, height: null })
    ]
  });
  assert.deepEqual(plan.assignments, []);
  assert.deepEqual(plan.missingDeliverableIndexes, [0]);
});

test("exact matching preserves a constrained deliverable instead of consuming its only source", () => {
  const plan = planRequiredImageNormalizations({
    deliverables: [
      deliverable({ format: null, width: null, height: null }),
      deliverable({ format: "png", width: 1080, height: 1920 })
    ],
    candidates: [
      candidate({ filePath: "/jobs/only-png.png", detectedFormat: "png", mimeType: "image/png", width: 1080, height: 1920 }),
      candidate({ filePath: "/jobs/other.jpg", detectedFormat: "jpeg", mimeType: "image/jpeg" })
    ]
  });
  assert.deepEqual(plan, {
    assignments: [
      { deliverableIndex: 0, candidateIndex: 1, needsNormalization: false },
      { deliverableIndex: 1, candidateIndex: 0, needsNormalization: false }
    ],
    missingDeliverableIndexes: []
  });
});
