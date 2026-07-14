import path from "node:path";
import type { TaskDeliverable } from "./types";

export type GeneratedMediaDeliveryCandidate = {
  kind: "image" | "video";
  filePath: string | null;
  mimeType: string | null;
  detectedFormat?: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  localAvailable: boolean;
  checksumSha256?: string | null;
};

export type RequiredMediaDeliveryIssue = {
  deliverableIndex: number;
  kind: "image" | "video";
  format: string | null;
  reason:
    | "local_file_missing"
    | "format_mismatch"
    | "dimensions_missing"
    | "dimension_mismatch";
};

export type RequiredMediaDeliveryAssessment = {
  ok: boolean;
  matches: Array<{
    deliverableIndex: number;
    candidateIndex: number;
  }>;
  issues: RequiredMediaDeliveryIssue[];
};

function normalizedFormat(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/^\./, "") ?? "";
  return normalized === "jpg" ? "jpeg" : normalized || null;
}

function candidateFormat(candidate: GeneratedMediaDeliveryCandidate) {
  if (candidate.detectedFormat !== undefined) {
    return normalizedFormat(candidate.detectedFormat);
  }
  const normalizedMimeType = candidate.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const mimeFormat = normalizedMimeType.startsWith("image/") || normalizedMimeType.startsWith("video/")
    ? normalizedMimeType.split("/")[1]
    : null;
  if (mimeFormat) {
    return normalizedFormat(mimeFormat);
  }
  return normalizedFormat(candidate.filePath ? path.extname(candidate.filePath) : null);
}

export function assessRequiredMediaDeliverables(input: {
  deliverables: TaskDeliverable[];
  candidates: GeneratedMediaDeliveryCandidate[];
}): RequiredMediaDeliveryAssessment {
  const usedCandidates = new Set<number>();
  const matches: RequiredMediaDeliveryAssessment["matches"] = [];
  const issues: RequiredMediaDeliveryIssue[] = [];

  input.deliverables.forEach((deliverable, deliverableIndex) => {
    if (!deliverable.required || (deliverable.kind !== "image" && deliverable.kind !== "video")) {
      return;
    }
    const requiredFormat = normalizedFormat(deliverable.format);
    const availableOfKind = input.candidates
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) =>
        candidate.kind === deliverable.kind &&
        candidate.localAvailable &&
        !usedCandidates.has(candidateIndex)
      );
    const formatMatches = availableOfKind.filter(({ candidate }) => {
      const actualFormat = candidateFormat(candidate);
      return actualFormat !== null && (requiredFormat === null || actualFormat === requiredFormat);
    });
    const dimensionsRequired = deliverable.width !== null || deliverable.height !== null;
    const measurable = formatMatches.filter(({ candidate }) =>
      !dimensionsRequired || (candidate.width !== null && candidate.height !== null)
    );
    const match = measurable.find(({ candidate }) =>
      (deliverable.width === null || candidate.width === deliverable.width) &&
      (deliverable.height === null || candidate.height === deliverable.height)
    );
    if (match) {
      usedCandidates.add(match.candidateIndex);
      matches.push({ deliverableIndex, candidateIndex: match.candidateIndex });
      return;
    }
    const reason: RequiredMediaDeliveryIssue["reason"] = availableOfKind.length === 0
      ? "local_file_missing"
      : formatMatches.length === 0
        ? "format_mismatch"
        : measurable.length === 0
          ? "dimensions_missing"
          : "dimension_mismatch";
    issues.push({
      deliverableIndex,
      kind: deliverable.kind,
      format: requiredFormat,
      reason
    });
  });

  return {
    ok: issues.length === 0,
    matches,
    issues
  };
}
