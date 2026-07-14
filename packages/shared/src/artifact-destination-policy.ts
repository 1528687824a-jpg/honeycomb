import path from "node:path";

export type ArtifactDestinationPathFlavor = "windows" | "posix";

export type ArtifactDestinationResolution = {
  rootPath: string;
  rootPathKey: string;
  relativeDirectory: string;
  directoryPath: string;
  flavor: ArtifactDestinationPathFlavor;
};

export type ArtifactDeliveryPathValidation =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "delivery_destination_missing"
        | "delivery_path_invalid"
        | "delivery_path_outside_destination"
        | "delivery_file_name_mismatch";
    };

export class ArtifactDestinationPathError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ArtifactDestinationPathError";
  }
}

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DEVICE_OR_NETWORK = /^(?:[\\/]{2}|\\\\[?.]\\)/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function pathApi(flavor: ArtifactDestinationPathFlavor) {
  return flavor === "windows" ? path.win32 : path.posix;
}

function normalizeSeparators(value: string, flavor: ArtifactDestinationPathFlavor) {
  return flavor === "windows" ? value.replace(/\//g, "\\") : value.replace(/\\/g, "/");
}

function trimTrailingSeparators(value: string, flavor: ArtifactDestinationPathFlavor) {
  const api = pathApi(flavor);
  const root = api.parse(value).root;
  let output = value;
  while (output.length > root.length && /[\\/]$/.test(output)) {
    output = output.slice(0, -1);
  }
  return output;
}

function windowsPathComponents(value: string) {
  return value.slice(path.win32.parse(value).root.length).split(/[\\/]+/).filter(Boolean);
}

function assertSafeWindowsComponents(value: string) {
  for (const component of windowsPathComponents(value)) {
    if (
      component === "." ||
      component === ".." ||
      component.endsWith(".") ||
      component.endsWith(" ") ||
      /[<>:"|?*\u0000-\u001f]/.test(component) ||
      WINDOWS_RESERVED_NAME.test(component)
    ) {
      throw new ArtifactDestinationPathError("artifact_destination_windows_component_invalid");
    }
  }
}

function assertTextPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) {
    throw new ArtifactDestinationPathError("artifact_destination_path_invalid");
  }
  return trimmed;
}

export function artifactDestinationPathFlavor(value: string): ArtifactDestinationPathFlavor {
  const trimmed = value.trim();
  if (WINDOWS_DRIVE_ABSOLUTE.test(trimmed) || WINDOWS_DEVICE_OR_NETWORK.test(trimmed)) {
    return "windows";
  }
  return "posix";
}

export function normalizeArtifactDestinationRootPath(rootPath: string) {
  const trimmed = assertTextPath(rootPath);
  const flavor = artifactDestinationPathFlavor(trimmed);
  const api = pathApi(flavor);

  if (flavor === "windows") {
    if (WINDOWS_DEVICE_OR_NETWORK.test(trimmed)) {
      throw new ArtifactDestinationPathError("artifact_destination_network_or_device_path_blocked");
    }
    if (!WINDOWS_DRIVE_ABSOLUTE.test(trimmed)) {
      throw new ArtifactDestinationPathError("artifact_destination_root_not_absolute");
    }
    assertSafeWindowsComponents(trimmed);
  } else if (!api.isAbsolute(trimmed)) {
    throw new ArtifactDestinationPathError("artifact_destination_root_not_absolute");
  }

  const normalized = trimTrailingSeparators(api.normalize(normalizeSeparators(trimmed, flavor)), flavor);
  if (flavor === "windows") {
    assertSafeWindowsComponents(normalized);
  }
  return normalized;
}

export function artifactDestinationRootKey(rootPath: string) {
  const normalized = normalizeArtifactDestinationRootPath(rootPath);
  return artifactDestinationPathFlavor(normalized) === "windows"
    ? normalized.toLowerCase()
    : normalized;
}

export function artifactDestinationApprovalTarget(rootPathKey: string) {
  return `artifact-destination://${rootPathKey}`;
}

export function normalizeArtifactDestinationApprovalTarget(target: string | null) {
  const trimmed = target?.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.startsWith("artifact-destination://")
    ? trimmed.slice("artifact-destination://".length)
    : trimmed.startsWith("artifact-destination:")
      ? trimmed.slice("artifact-destination:".length)
      : trimmed;
  return artifactDestinationRootKey(withoutScheme);
}

function normalizedRelativeDirectory(value: string, flavor: ArtifactDestinationPathFlavor) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === ".") return "";
  if (/^[\\/]/.test(trimmed) || WINDOWS_DRIVE_ABSOLUTE.test(trimmed) || WINDOWS_DEVICE_OR_NETWORK.test(trimmed)) {
    throw new ArtifactDestinationPathError("artifact_destination_relative_path_required");
  }
  const components = trimmed.split(/[\\/]+/);
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new ArtifactDestinationPathError("artifact_destination_path_traversal");
  }
  if (flavor === "windows") {
    assertSafeWindowsComponents(`C:\\${components.join("\\")}`);
  } else if (components.some((component) => /[\u0000-\u001f]/.test(component))) {
    throw new ArtifactDestinationPathError("artifact_destination_path_invalid");
  }
  return components.join("/");
}

export function isArtifactPathInsideRoot(rootPath: string, candidatePath: string) {
  try {
    const normalizedRoot = normalizeArtifactDestinationRootPath(rootPath);
    const normalizedCandidate = normalizeArtifactDestinationRootPath(candidatePath);
    const rootFlavor = artifactDestinationPathFlavor(normalizedRoot);
    if (artifactDestinationPathFlavor(normalizedCandidate) !== rootFlavor) return false;
    const api = pathApi(rootFlavor);
    const relative = api.relative(normalizedRoot, normalizedCandidate);
    return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function resolveArtifactWorkspaceDestination(
  rootPath: string,
  relativeDirectory: string | null | undefined
): ArtifactDestinationResolution {
  const normalizedRoot = normalizeArtifactDestinationRootPath(rootPath);
  const flavor = artifactDestinationPathFlavor(normalizedRoot);
  const api = pathApi(flavor);
  const relative = normalizedRelativeDirectory(relativeDirectory ?? "", flavor);
  const directoryPath = relative
    ? api.resolve(normalizedRoot, normalizeSeparators(relative, flavor))
    : normalizedRoot;
  if (!isArtifactPathInsideRoot(normalizedRoot, directoryPath)) {
    throw new ArtifactDestinationPathError("artifact_destination_path_outside_root");
  }
  return {
    rootPath: normalizedRoot,
    rootPathKey: artifactDestinationRootKey(normalizedRoot),
    relativeDirectory: relative,
    directoryPath,
    flavor
  };
}

export function resolveArtifactCustomDestination(
  grantedRootPath: string,
  requestedDirectoryPath: string
): ArtifactDestinationResolution {
  const normalizedRoot = normalizeArtifactDestinationRootPath(grantedRootPath);
  const normalizedRequested = normalizeArtifactDestinationRootPath(requestedDirectoryPath);
  const flavor = artifactDestinationPathFlavor(normalizedRoot);
  if (
    artifactDestinationPathFlavor(normalizedRequested) !== flavor ||
    !isArtifactPathInsideRoot(normalizedRoot, normalizedRequested)
  ) {
    throw new ArtifactDestinationPathError("artifact_destination_path_outside_root");
  }
  const api = pathApi(flavor);
  const relative = api.relative(normalizedRoot, normalizedRequested);
  return {
    rootPath: normalizedRoot,
    rootPathKey: artifactDestinationRootKey(normalizedRoot),
    relativeDirectory: relative ? relative.split(api.sep).join("/") : "",
    directoryPath: normalizedRequested,
    flavor
  };
}

export function sanitizeArtifactDeliveryFileName(input: string) {
  const source = path.win32.basename(path.posix.basename(input.trim()));
  let output = "";
  for (const value of source) {
    output += /[\\/:*?"<>|\u0000-\u001f]/.test(value) ? "_" : value;
  }
  output = output.trim().replace(/[. ]+$/g, "");
  if (!output) output = "honeycomb-artifact";
  const parsed = path.win32.parse(output);
  if (WINDOWS_RESERVED_NAME.test(parsed.base)) output = `_${output}`;
  if (output.length <= 180) return output;
  const extension = parsed.ext.slice(0, 20);
  return `${parsed.name.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesRequestedFileName(actual: string, requested: string) {
  const normalizedActual = sanitizeArtifactDeliveryFileName(actual);
  if (normalizedActual !== actual || actual === requested) return actual === requested;
  const parsed = path.win32.parse(requested);
  const collisionName = new RegExp(
    `^${escapedRegExp(parsed.name)}-(?:[2-9]|[1-9][0-9]{1,2}|[0-9]{10,})${escapedRegExp(parsed.ext)}$`,
    "i"
  );
  return collisionName.test(actual);
}

export function validateArtifactDeliveryPath(input: {
  destinationPath: string | null;
  requestedFileName: string;
  deliveredPath: string;
}): ArtifactDeliveryPathValidation {
  if (!input.destinationPath) return { valid: false, reason: "delivery_destination_missing" };
  try {
    const destination = normalizeArtifactDestinationRootPath(input.destinationPath);
    const delivered = normalizeArtifactDestinationRootPath(input.deliveredPath);
    const flavor = artifactDestinationPathFlavor(destination);
    if (artifactDestinationPathFlavor(delivered) !== flavor) {
      return { valid: false, reason: "delivery_path_outside_destination" };
    }
    const api = pathApi(flavor);
    const parent = trimTrailingSeparators(api.dirname(delivered), flavor);
    const parentKey = flavor === "windows" ? parent.toLowerCase() : parent;
    const destinationKey = flavor === "windows" ? destination.toLowerCase() : destination;
    if (parentKey !== destinationKey) {
      return { valid: false, reason: "delivery_path_outside_destination" };
    }
    const requested = sanitizeArtifactDeliveryFileName(input.requestedFileName);
    if (!matchesRequestedFileName(api.basename(delivered), requested)) {
      return { valid: false, reason: "delivery_file_name_mismatch" };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: "delivery_path_invalid" };
  }
}
