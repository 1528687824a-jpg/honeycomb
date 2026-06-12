import path from "node:path";

export function normalizeWorkspaceRootPath(rootPath: string) {
  return path.resolve(rootPath);
}

export function workspaceRootKey(rootPath: string) {
  const resolved = normalizeWorkspaceRootPath(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
