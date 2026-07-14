import assert from "node:assert/strict";
import { test } from "node:test";
import {
  summarizeArtifactDeliveryRecords,
  validateArtifactDeliveryReceipt
} from "../packages/shared/src/artifact-delivery-state";
import type { ArtifactDeliveryRecord } from "../packages/shared/src/types";

function delivery(
  status: ArtifactDeliveryRecord["status"],
  overrides: Partial<ArtifactDeliveryRecord> = {}
): ArtifactDeliveryRecord {
  return {
    id: `delivery-${status}`,
    jobId: "JOB-1",
    artifactFileId: "FILE-1",
    deliverableIndex: 0,
    required: true,
    target: "desktop",
    targetPath: null,
    requestedFileName: "poster.png",
    authorizationStatus: "authorized",
    authorizationKind: "desktop",
    authorizationId: null,
    authorizedRootPath: null,
    destinationRelativePath: null,
    destinationPath: null,
    authorizationError: null,
    status,
    attemptCount: 0,
    claimToken: null,
    leaseExpiresAt: null,
    expectedSizeBytes: 128,
    expectedChecksumSha256: "a".repeat(64),
    deliveredPath: null,
    deliveredSizeBytes: null,
    deliveredChecksumSha256: null,
    lastError: null,
    metadata: {},
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    completedAt: null,
    ...overrides
  };
}

test("required artifact deliveries are not final until every destination confirms", () => {
  const pending = summarizeArtifactDeliveryRecords([
    delivery("succeeded"),
    delivery("pending", { id: "delivery-pending-2", deliverableIndex: 1 })
  ]);
  assert.deepEqual(pending, {
    requiredCount: 2,
    succeededCount: 1,
    failedCount: 0,
    pendingCount: 1,
    deliveringCount: 0,
    readyToFinalize: false
  });

  const complete = summarizeArtifactDeliveryRecords([
    delivery("succeeded"),
    delivery("succeeded", { id: "delivery-succeeded-2", deliverableIndex: 1 })
  ]);
  assert.equal(complete.readyToFinalize, true);
});

test("optional and cancelled deliveries do not block required delivery finalization", () => {
  const summary = summarizeArtifactDeliveryRecords([
    delivery("succeeded"),
    delivery("failed", { id: "optional", deliverableIndex: 1, required: false }),
    delivery("cancelled", { id: "cancelled", deliverableIndex: 2 })
  ]);
  assert.equal(summary.requiredCount, 1);
  assert.equal(summary.readyToFinalize, true);
});

test("delivery receipts must match the source byte count and SHA-256 checksum", () => {
  const expected = delivery("delivering");
  assert.deepEqual(
    validateArtifactDeliveryReceipt(expected, {
      deliveredSizeBytes: 128,
      deliveredChecksumSha256: "A".repeat(64)
    }),
    { valid: true }
  );
  assert.deepEqual(
    validateArtifactDeliveryReceipt(expected, {
      deliveredSizeBytes: 127,
      deliveredChecksumSha256: "a".repeat(64)
    }),
    { valid: false, reason: "size_mismatch" }
  );
  assert.deepEqual(
    validateArtifactDeliveryReceipt(expected, {
      deliveredSizeBytes: 128,
      deliveredChecksumSha256: "b".repeat(64)
    }),
    { valid: false, reason: "checksum_mismatch" }
  );
});
