import type { ArtifactDeliveryRecord } from "./types";

export function summarizeArtifactDeliveryRecords(deliveries: ArtifactDeliveryRecord[]) {
  const required = deliveries.filter((delivery) => delivery.required && delivery.status !== "cancelled");
  return {
    requiredCount: required.length,
    succeededCount: required.filter((delivery) => delivery.status === "succeeded").length,
    failedCount: required.filter((delivery) => delivery.status === "failed").length,
    pendingCount: required.filter((delivery) => delivery.status === "pending").length,
    deliveringCount: required.filter((delivery) => delivery.status === "delivering").length,
    readyToFinalize: required.length > 0 && required.every((delivery) => delivery.status === "succeeded")
  };
}

export function validateArtifactDeliveryReceipt(
  delivery: Pick<ArtifactDeliveryRecord, "expectedSizeBytes" | "expectedChecksumSha256">,
  receipt: { deliveredSizeBytes: number; deliveredChecksumSha256?: string | null }
): { valid: true } | {
  valid: false;
  reason: "size_mismatch" | "checksum_required" | "checksum_mismatch";
} {
  if (
    delivery.expectedSizeBytes !== null &&
    receipt.deliveredSizeBytes !== delivery.expectedSizeBytes
  ) {
    return { valid: false, reason: "size_mismatch" };
  }
  if (delivery.expectedChecksumSha256 !== null) {
    if (!receipt.deliveredChecksumSha256) {
      return { valid: false, reason: "checksum_required" };
    }
    if (
      receipt.deliveredChecksumSha256.toLowerCase() !==
      delivery.expectedChecksumSha256.toLowerCase()
    ) {
      return { valid: false, reason: "checksum_mismatch" };
    }
  }
  return { valid: true };
}
