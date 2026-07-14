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
  const requirements = input.deliverables.flatMap((deliverable, deliverableIndex) => {
    if (!deliverable.required || (deliverable.kind !== "image" && deliverable.kind !== "video")) {
      return [];
    }
    const requiredFormat = normalizedFormat(deliverable.format);
    const availableOfKind = input.candidates
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) =>
        candidate.kind === deliverable.kind &&
        candidate.localAvailable
      );
    const formatMatches = availableOfKind.filter(({ candidate }) => {
      const actualFormat = candidateFormat(candidate);
      return actualFormat !== null && (requiredFormat === null || actualFormat === requiredFormat);
    });
    const dimensionsRequired = deliverable.width !== null || deliverable.height !== null;
    const measurable = formatMatches.filter(({ candidate }) =>
      !dimensionsRequired || (candidate.width !== null && candidate.height !== null)
    );
    const exactMatches = measurable.filter(({ candidate }) =>
      (deliverable.width === null || candidate.width === deliverable.width) &&
      (deliverable.height === null || candidate.height === deliverable.height)
    );
    return [{
      deliverable,
      deliverableIndex,
      requiredFormat,
      availableOfKind,
      formatMatches,
      measurable,
      exactMatches: exactMatches.sort((left, right) =>
        Math.abs(deliverableIndex - left.candidateIndex) -
          Math.abs(deliverableIndex - right.candidateIndex) ||
        left.candidateIndex - right.candidateIndex
      )
    }];
  });

  const requirementByIndex = new Map(
    requirements.map((requirement) => [requirement.deliverableIndex, requirement])
  );
  const candidateOwner = new Map<number, number>();
  const candidateByDeliverable = new Map<number, number>();

  const tryAssign = (
    deliverableIndex: number,
    visitedCandidates: Set<number>,
    visitedDeliverables: Set<number>
  ): boolean => {
    if (visitedDeliverables.has(deliverableIndex)) {
      return false;
    }
    visitedDeliverables.add(deliverableIndex);
    const requirement = requirementByIndex.get(deliverableIndex);
    if (!requirement) {
      return false;
    }
    for (const option of requirement.exactMatches) {
      if (visitedCandidates.has(option.candidateIndex)) {
        continue;
      }
      visitedCandidates.add(option.candidateIndex);
      const previousOwner = candidateOwner.get(option.candidateIndex);
      if (previousOwner === undefined || tryAssign(
        previousOwner,
        visitedCandidates,
        visitedDeliverables
      )) {
        if (previousOwner !== undefined) {
          candidateByDeliverable.delete(previousOwner);
        }
        candidateOwner.set(option.candidateIndex, deliverableIndex);
        candidateByDeliverable.set(deliverableIndex, option.candidateIndex);
        return true;
      }
    }
    return false;
  };

  for (const requirement of [...requirements].sort((left, right) =>
    left.exactMatches.length - right.exactMatches.length ||
    left.deliverableIndex - right.deliverableIndex
  )) {
    if (requirement.exactMatches.length > 0) {
      tryAssign(requirement.deliverableIndex, new Set(), new Set());
    }
  }

  const matches = [...candidateByDeliverable.entries()]
    .map(([deliverableIndex, candidateIndex]) => ({ deliverableIndex, candidateIndex }))
    .sort((left, right) => left.deliverableIndex - right.deliverableIndex);
  const issues = requirements.flatMap((requirement): RequiredMediaDeliveryIssue[] => {
    if (candidateByDeliverable.has(requirement.deliverableIndex)) {
      return [];
    }
    const reason: RequiredMediaDeliveryIssue["reason"] = requirement.availableOfKind.length === 0 ||
        requirement.exactMatches.length > 0
      ? "local_file_missing"
      : requirement.formatMatches.length === 0
        ? "format_mismatch"
        : requirement.measurable.length === 0
          ? "dimensions_missing"
          : "dimension_mismatch";
    return [{
      deliverableIndex: requirement.deliverableIndex,
      kind: requirement.deliverable.kind as "image" | "video",
      format: requirement.requiredFormat,
      reason
    }];
  });

  return {
    ok: issues.length === 0,
    matches,
    issues
  };
}
