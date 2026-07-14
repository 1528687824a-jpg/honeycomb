export function buildModelCallIdempotencyKey(input: {
  jobId: string;
  stageId?: string | null;
  attemptNo: number;
  actionType: string;
}) {
  return [
    input.jobId,
    input.stageId ?? "job",
    input.attemptNo,
    input.actionType
  ].join(":");
}

export function normalizeModelCallKeys(keys: readonly string[] | null | undefined) {
  const normalized: string[] = [];
  for (const key of keys ?? []) {
    const value = key.trim();
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

export function missingModelCallKeys(
  requestedKeys: readonly string[],
  existingKeys: ReadonlySet<string>
) {
  return normalizeModelCallKeys(requestedKeys).filter((key) => !existingKeys.has(key));
}
