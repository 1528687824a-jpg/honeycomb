export const DISCUSSION_CONTEXT_ARTIFACT_LIMIT = 24;

export function normalizeDiscussionContextArtifactIds(
  artifactIds: readonly string[] | null | undefined
) {
  const normalized: string[] = [];
  for (const artifactId of artifactIds ?? []) {
    const value = artifactId.trim();
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized.slice(-DISCUSSION_CONTEXT_ARTIFACT_LIMIT);
}
