import type { GeneratedMediaDeliveryCandidate } from "./artifact-delivery-policy";
import type { TaskDeliverable } from "./types";

export type ImageNormalizationAssignment = {
  deliverableIndex: number;
  candidateIndex: number;
  needsNormalization: boolean;
};

export type ImageNormalizationPlan = {
  assignments: ImageNormalizationAssignment[];
  missingDeliverableIndexes: number[];
};

function normalizedFormat(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/^\./, "") ?? "";
  return normalized === "jpg" ? "jpeg" : normalized || null;
}

function actualFormat(candidate: GeneratedMediaDeliveryCandidate) {
  if (candidate.detectedFormat !== undefined) {
    return normalizedFormat(candidate.detectedFormat);
  }
  const mime = candidate.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("image/") ? normalizedFormat(mime.slice("image/".length)) : null;
}

function canNormalize(candidate: GeneratedMediaDeliveryCandidate) {
  return candidate.kind === "image" &&
    candidate.localAvailable &&
    Boolean(candidate.filePath) &&
    actualFormat(candidate) !== null &&
    candidate.width !== null &&
    candidate.height !== null &&
    candidate.width > 0 &&
    candidate.height > 0;
}

function isExact(
  deliverable: TaskDeliverable,
  candidate: GeneratedMediaDeliveryCandidate
) {
  const requestedFormat = normalizedFormat(deliverable.format);
  return (requestedFormat === null || actualFormat(candidate) === requestedFormat) &&
    (deliverable.width === null || candidate.width === deliverable.width) &&
    (deliverable.height === null || candidate.height === deliverable.height);
}

export function planRequiredImageNormalizations(input: {
  deliverables: TaskDeliverable[];
  candidates: GeneratedMediaDeliveryCandidate[];
}): ImageNormalizationPlan {
  const deliverables = input.deliverables
    .map((deliverable, deliverableIndex) => ({ deliverable, deliverableIndex }))
    .filter(({ deliverable }) => deliverable.required && deliverable.kind === "image");
  const candidates = input.candidates
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => canNormalize(candidate));
  const assignments: ImageNormalizationAssignment[] = [];
  const assignedDeliverables = new Set<number>();
  const assignedCandidates = new Set<number>();
  const deliverableOrder = new Map(
    deliverables.map((entry, index) => [entry.deliverableIndex, index])
  );
  const candidateOrder = new Map(
    candidates.map((entry, index) => [entry.candidateIndex, index])
  );
  const exactOptions = new Map(
    deliverables.map((requested) => [
      requested.deliverableIndex,
      candidates
        .filter(({ candidate }) => isExact(requested.deliverable, candidate))
        .sort((left, right) => {
          const requestedOrder = deliverableOrder.get(requested.deliverableIndex) ?? 0;
          return Math.abs(requestedOrder - (candidateOrder.get(left.candidateIndex) ?? 0)) -
            Math.abs(requestedOrder - (candidateOrder.get(right.candidateIndex) ?? 0)) ||
            left.candidateIndex - right.candidateIndex;
        })
    ])
  );
  const exactCandidateOwner = new Map<number, number>();
  const exactCandidateByDeliverable = new Map<number, number>();
  const tryAssignExact = (
    deliverableIndex: number,
    visitedCandidates: Set<number>,
    visitedDeliverables: Set<number>
  ): boolean => {
    if (visitedDeliverables.has(deliverableIndex)) {
      return false;
    }
    visitedDeliverables.add(deliverableIndex);
    for (const option of exactOptions.get(deliverableIndex) ?? []) {
      if (visitedCandidates.has(option.candidateIndex)) {
        continue;
      }
      visitedCandidates.add(option.candidateIndex);
      const previousOwner = exactCandidateOwner.get(option.candidateIndex);
      if (previousOwner === undefined || tryAssignExact(
        previousOwner,
        visitedCandidates,
        visitedDeliverables
      )) {
        if (previousOwner !== undefined) {
          exactCandidateByDeliverable.delete(previousOwner);
        }
        exactCandidateOwner.set(option.candidateIndex, deliverableIndex);
        exactCandidateByDeliverable.set(deliverableIndex, option.candidateIndex);
        return true;
      }
    }
    return false;
  };

  for (const requested of [...deliverables].sort((left, right) =>
    (exactOptions.get(left.deliverableIndex)?.length ?? 0) -
      (exactOptions.get(right.deliverableIndex)?.length ?? 0) ||
    left.deliverableIndex - right.deliverableIndex
  )) {
    if ((exactOptions.get(requested.deliverableIndex)?.length ?? 0) > 0) {
      tryAssignExact(requested.deliverableIndex, new Set(), new Set());
    }
  }
  for (const [deliverableIndex, candidateIndex] of exactCandidateByDeliverable) {
    assignedDeliverables.add(deliverableIndex);
    assignedCandidates.add(candidateIndex);
    assignments.push({ deliverableIndex, candidateIndex, needsNormalization: false });
  }

  for (const [deliverableOrder, requested] of deliverables.entries()) {
    if (assignedDeliverables.has(requested.deliverableIndex)) {
      continue;
    }
    const source = candidates
      .filter(({ candidateIndex }) => !assignedCandidates.has(candidateIndex))
      .sort((left, right) => {
        const leftOrder = candidateOrder.get(left.candidateIndex) ?? 0;
        const rightOrder = candidateOrder.get(right.candidateIndex) ?? 0;
        return Math.abs(deliverableOrder - leftOrder) - Math.abs(deliverableOrder - rightOrder) ||
          left.candidateIndex - right.candidateIndex;
      })[0];
    if (!source) {
      continue;
    }
    assignedDeliverables.add(requested.deliverableIndex);
    assignedCandidates.add(source.candidateIndex);
    assignments.push({
      deliverableIndex: requested.deliverableIndex,
      candidateIndex: source.candidateIndex,
      needsNormalization: true
    });
  }

  return {
    assignments: assignments.sort((left, right) => left.deliverableIndex - right.deliverableIndex),
    missingDeliverableIndexes: deliverables
      .map(({ deliverableIndex }) => deliverableIndex)
      .filter((deliverableIndex) => !assignedDeliverables.has(deliverableIndex))
  };
}
