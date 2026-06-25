import path from "node:path";
import type { ArtifactRecord } from "../../../packages/shared/src/types";

export type ArtifactFileRef = {
  index: number;
  label: string;
  kind: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  source: string | null;
  filePath: string;
  fileName: string;
  externalUrl: string | null;
  note: string | null;
};

type ExtractArtifactFileRefsOptions = {
  jobDataDir?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function defaultJobDataDir() {
  return process.env.JOB_DATA_DIR ?? "data/jobs";
}

function isInsideRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveArtifactFilePath(filePath: string, jobDataDir = defaultJobDataDir()) {
  const root = path.resolve(jobDataDir);
  const resolved = path.resolve(filePath);
  return isInsideRoot(root, resolved) ? resolved : null;
}

function fileNameForPath(filePath: string) {
  return path.basename(filePath) || "artifact";
}

function buildFileRef(input: {
  index: number;
  label: string;
  filePath: string;
  jobDataDir: string;
  kind?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  source?: string | null;
  externalUrl?: string | null;
  note?: string | null;
}): ArtifactFileRef | null {
  const safePath = resolveArtifactFilePath(input.filePath, input.jobDataDir);
  if (!safePath) {
    return null;
  }

  return {
    index: input.index,
    label: input.label,
    kind: input.kind ?? null,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    source: input.source ?? null,
    filePath: safePath,
    fileName: fileNameForPath(safePath),
    externalUrl: input.externalUrl ?? null,
    note: input.note ?? null
  };
}

function collectGeneratedArtifactRecords(record: Record<string, unknown> | null) {
  if (!record) {
    return [];
  }

  const openclaw = asRecord(record.openclaw);
  const candidates = [
    openclaw?.artifacts,
    record.generatedArtifacts
  ];
  const items: Record<string, unknown>[] = [];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const item of candidate) {
      const generated = asRecord(item);
      if (generated) {
        items.push(generated);
      }
    }
  }

  return items;
}

export function extractArtifactFileRefs(
  artifact: ArtifactRecord,
  options: ExtractArtifactFileRefsOptions = {}
) {
  const jobDataDir = options.jobDataDir ?? defaultJobDataDir();
  const parsedContent = parseJsonRecord(artifact.content);
  const seen = new Set<string>();
  const refs: ArtifactFileRef[] = [];

  const addPath = (input: {
    label: string;
    filePath: string | null;
    kind?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    source?: string | null;
    externalUrl?: string | null;
    note?: string | null;
  }) => {
    if (!input.filePath) {
      return;
    }

    const ref = buildFileRef({
      index: refs.length,
      label: input.label,
      filePath: input.filePath,
      jobDataDir,
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      source: input.source,
      externalUrl: input.externalUrl,
      note: input.note
    });
    if (!ref) {
      return;
    }

    const key = ref.filePath.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    refs.push({ ...ref, index: refs.length });
  };

  addPath({ label: "artifact-uri", filePath: artifact.uri });
  addPath({ label: "artifact-path", filePath: asString(parsedContent?.artifact_path) });

  const metadata = artifact.metadata ?? {};
  for (const key of ["markdownPath", "workLogPath", "stateJsonPath", "finalPath"] as const) {
    addPath({
      label: key,
      filePath: asString(metadata[key])
    });
  }

  for (const [index, generated] of collectGeneratedArtifactRecords(parsedContent).entries()) {
    addPath({
      label: `generated-${index + 1}`,
      filePath: asString(generated.filePath),
      kind: asString(generated.kind),
      mimeType: asString(generated.mimeType),
      sizeBytes: asNumber(generated.sizeBytes),
      source: asString(generated.source),
      externalUrl: asString(generated.url),
      note: asString(generated.note) ?? asString(generated.downloadError)
    });
  }

  for (const [index, generated] of collectGeneratedArtifactRecords(asRecord(metadata)).entries()) {
    addPath({
      label: `metadata-generated-${index + 1}`,
      filePath: asString(generated.filePath),
      kind: asString(generated.kind),
      mimeType: asString(generated.mimeType),
      sizeBytes: asNumber(generated.sizeBytes),
      source: asString(generated.source),
      externalUrl: asString(generated.url),
      note: asString(generated.note) ?? asString(generated.downloadError)
    });
  }

  return refs;
}
