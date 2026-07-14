import {
  artifactDestinationRootKey,
  normalizeArtifactDestinationRootPath
} from "../../../packages/shared/src/artifact-destination-policy";

export function normalizeWorkspaceRootPath(rootPath: string) {
  return normalizeArtifactDestinationRootPath(rootPath);
}

export function workspaceRootKey(rootPath: string) {
  return artifactDestinationRootKey(rootPath);
}

export function workspaceApprovalTarget(rootPathKey: string) {
  return `workspace://${rootPathKey}`;
}

export function normalizeWorkspaceRegistrationTarget(target: string | null) {
  const trimmed = target?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutScheme = trimmed.startsWith("workspace://")
    ? trimmed.slice("workspace://".length)
    : trimmed.startsWith("workspace:")
      ? trimmed.slice("workspace:".length)
      : trimmed;
  return workspaceRootKey(withoutScheme);
}
