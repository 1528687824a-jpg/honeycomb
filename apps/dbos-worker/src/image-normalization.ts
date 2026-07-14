import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import sharp, { type Sharp } from "sharp";

export const NORMALIZED_IMAGE_FORMATS = ["png", "jpeg", "webp", "gif"] as const;
export type NormalizedImageFormat = (typeof NORMALIZED_IMAGE_FORMATS)[number];

const SOURCE_IMAGE_FORMATS = new Set([
  ...NORMALIZED_IMAGE_FORMATS,
  "avif",
  "tiff"
]);

export type RasterImageInspection = {
  format: string;
  width: number;
  height: number;
  orientation: number | null;
  pages: number;
  hasAlpha: boolean;
  sizeBytes: number;
};

export type ImageNormalizationResult = {
  filePath: string;
  fileName: string;
  mimeType: string;
  format: NormalizedImageFormat;
  width: number;
  height: number;
  sizeBytes: number;
  checksumSha256: string;
  sourceChecksumSha256: string;
  transformed: boolean;
  reused: boolean;
  fit: "none" | "scale" | "cover_attention";
  cropFraction: number;
};

export type ImageNormalizationErrorCode =
  | "image_source_outside_job_workdir"
  | "image_source_not_regular_file"
  | "image_source_empty"
  | "image_source_too_large"
  | "image_source_format_unsupported"
  | "image_source_dimensions_invalid"
  | "image_requested_format_unsupported"
  | "image_requested_dimensions_invalid"
  | "image_requested_output_too_large"
  | "image_aspect_ratio_crop_too_large"
  | "image_normalized_output_too_large"
  | "image_normalized_output_invalid";

export class ImageNormalizationError extends Error {
  readonly code: ImageNormalizationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ImageNormalizationErrorCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ImageNormalizationError";
    this.code = code;
    this.details = details;
  }
}

type ImageNormalizationLimits = {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxInputPixels: number;
  maxOutputPixels: number;
  maxDimension: number;
  maxCropFraction: number;
  timeoutSeconds: number;
};

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function ratioEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value < 1 ? value : fallback;
}

export function resolveImageNormalizationLimits(
  overrides: Partial<ImageNormalizationLimits> = {}
): ImageNormalizationLimits {
  return {
    maxInputBytes: overrides.maxInputBytes ?? positiveIntegerEnv(
      "HONEYCOMB_IMAGE_NORMALIZE_MAX_INPUT_BYTES",
      50 * 1024 * 1024
    ),
    maxOutputBytes: overrides.maxOutputBytes ?? positiveIntegerEnv(
      "HONEYCOMB_IMAGE_NORMALIZE_MAX_OUTPUT_BYTES",
      100 * 1024 * 1024
    ),
    maxInputPixels: overrides.maxInputPixels ?? positiveIntegerEnv(
      "HONEYCOMB_IMAGE_NORMALIZE_MAX_INPUT_PIXELS",
      100_000_000
    ),
    maxOutputPixels: overrides.maxOutputPixels ?? positiveIntegerEnv(
      "HONEYCOMB_IMAGE_NORMALIZE_MAX_OUTPUT_PIXELS",
      100_000_000
    ),
    maxDimension: overrides.maxDimension ?? positiveIntegerEnv(
      "HONEYCOMB_IMAGE_NORMALIZE_MAX_DIMENSION",
      32_768
    ),
    maxCropFraction: overrides.maxCropFraction ?? ratioEnv(
      "HONEYCOMB_IMAGE_NORMALIZE_MAX_CROP_FRACTION",
      0.15
    ),
    timeoutSeconds: overrides.timeoutSeconds ?? positiveIntegerEnv(
      "HONEYCOMB_IMAGE_NORMALIZE_TIMEOUT_SECONDS",
      60
    )
  };
}

function isInsideDirectory(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizedFormat(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/^\./, "") ?? "";
  return normalized === "jpg" ? "jpeg" : normalized;
}

export function resolveNormalizedImageFormat(
  requestedFormat: string | null | undefined,
  sourceFormat: string
): NormalizedImageFormat {
  const requested = normalizedFormat(requestedFormat);
  if (requested) {
    if ((NORMALIZED_IMAGE_FORMATS as readonly string[]).includes(requested)) {
      return requested as NormalizedImageFormat;
    }
    throw new ImageNormalizationError("image_requested_format_unsupported", {
      requestedFormat
    });
  }

  const normalizedSource = normalizedFormat(sourceFormat);
  return (NORMALIZED_IMAGE_FORMATS as readonly string[]).includes(normalizedSource)
    ? normalizedSource as NormalizedImageFormat
    : "png";
}

function validateRequestedDimension(
  value: number | null | undefined,
  limits: ImageNormalizationLimits,
  axis: "width" | "height"
) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > limits.maxDimension) {
    throw new ImageNormalizationError("image_requested_dimensions_invalid", {
      axis,
      value,
      maxDimension: limits.maxDimension
    });
  }
  return value;
}

function requestedOutputDimensions(input: {
  sourceWidth: number;
  sourceHeight: number;
  requestedWidth: number | null;
  requestedHeight: number | null;
}) {
  if (input.requestedWidth !== null && input.requestedHeight !== null) {
    return { width: input.requestedWidth, height: input.requestedHeight };
  }
  if (input.requestedWidth !== null) {
    return {
      width: input.requestedWidth,
      height: Math.max(1, Math.round(input.sourceHeight * input.requestedWidth / input.sourceWidth))
    };
  }
  if (input.requestedHeight !== null) {
    return {
      width: Math.max(1, Math.round(input.sourceWidth * input.requestedHeight / input.sourceHeight)),
      height: input.requestedHeight
    };
  }
  return { width: input.sourceWidth, height: input.sourceHeight };
}

export function imageCoverCropFraction(input: {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}) {
  const sourceRatio = input.sourceWidth / input.sourceHeight;
  const targetRatio = input.targetWidth / input.targetHeight;
  return 1 - Math.min(sourceRatio, targetRatio) / Math.max(sourceRatio, targetRatio);
}

function mimeTypeForFormat(format: NormalizedImageFormat) {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function extensionForFormat(format: NormalizedImageFormat) {
  return format === "jpeg" ? "jpg" : format;
}

async function readBoundedSource(input: {
  sourcePath: string;
  workdir: string;
  limits: ImageNormalizationLimits;
}) {
  const canonicalRoot = await realpath(path.resolve(input.workdir));
  const canonicalSource = await realpath(path.resolve(input.sourcePath));
  if (!isInsideDirectory(canonicalRoot, canonicalSource)) {
    throw new ImageNormalizationError("image_source_outside_job_workdir");
  }

  const handle = await open(canonicalSource, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new ImageNormalizationError("image_source_not_regular_file");
    }
    if (fileStat.size <= 0) {
      throw new ImageNormalizationError("image_source_empty");
    }
    if (fileStat.size > input.limits.maxInputBytes) {
      throw new ImageNormalizationError("image_source_too_large", {
        sizeBytes: fileStat.size,
        maxInputBytes: input.limits.maxInputBytes
      });
    }
    const bytes = await handle.readFile();
    return {
      bytes,
      canonicalRoot,
      canonicalSource,
      sizeBytes: fileStat.size,
      checksumSha256: createHash("sha256").update(bytes).digest("hex")
    };
  } finally {
    await handle.close();
  }
}

async function inspectRasterBytes(
  bytes: Buffer,
  sizeBytes: number,
  limits: ImageNormalizationLimits
): Promise<RasterImageInspection> {
  let metadata;
  try {
    metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: limits.maxInputPixels,
      sequentialRead: true
    }).metadata();
  } catch (error) {
    throw new ImageNormalizationError("image_normalized_output_invalid", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  const format = normalizedFormat(metadata.format);
  if (!SOURCE_IMAGE_FORMATS.has(format)) {
    throw new ImageNormalizationError("image_source_format_unsupported", { format });
  }
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > limits.maxDimension || height > limits.maxDimension) {
    throw new ImageNormalizationError("image_source_dimensions_invalid", {
      width,
      height,
      maxDimension: limits.maxDimension
    });
  }
  return {
    format,
    width,
    height,
    orientation: metadata.orientation ?? null,
    pages: metadata.pages ?? 1,
    hasAlpha: metadata.hasAlpha,
    sizeBytes
  };
}

export async function inspectRasterImageFile(
  filePath: string,
  overrides: Partial<ImageNormalizationLimits> = {}
) {
  const limits = resolveImageNormalizationLimits(overrides);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new ImageNormalizationError("image_source_not_regular_file");
  }
  if (fileStat.size <= 0) {
    throw new ImageNormalizationError("image_source_empty");
  }
  if (fileStat.size > limits.maxOutputBytes) {
    throw new ImageNormalizationError("image_normalized_output_too_large", {
      sizeBytes: fileStat.size,
      maxOutputBytes: limits.maxOutputBytes
    });
  }
  const handle = await open(filePath, "r");
  try {
    return inspectRasterBytes(await handle.readFile(), fileStat.size, limits);
  } finally {
    await handle.close();
  }
}

async function sha256Path(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    return createHash("sha256").update(await handle.readFile()).digest("hex");
  } finally {
    await handle.close();
  }
}

function matchesExpectedOutput(
  inspection: RasterImageInspection,
  format: NormalizedImageFormat,
  requestedWidth: number | null,
  requestedHeight: number | null
) {
  return inspection.format === format &&
    (requestedWidth === null || inspection.width === requestedWidth) &&
    (requestedHeight === null || inspection.height === requestedHeight);
}

async function inspectReusableOutput(input: {
  filePath: string;
  format: NormalizedImageFormat;
  requestedWidth: number | null;
  requestedHeight: number | null;
  limits: ImageNormalizationLimits;
}) {
  try {
    const inspection = await inspectRasterImageFile(input.filePath, input.limits);
    if (!matchesExpectedOutput(
      inspection,
      input.format,
      input.requestedWidth,
      input.requestedHeight
    )) {
      return null;
    }
    return {
      inspection,
      checksumSha256: await sha256Path(input.filePath)
    };
  } catch {
    return null;
  }
}

function applyOutputFormat(pipeline: Sharp, format: NormalizedImageFormat) {
  if (format === "jpeg") {
    return pipeline
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 94, progressive: true, chromaSubsampling: "4:4:4" });
  }
  if (format === "webp") {
    return pipeline.webp({ quality: 92, alphaQuality: 100, smartSubsample: true, effort: 5 });
  }
  if (format === "gif") {
    return pipeline.gif({ effort: 7, colours: 256, dither: 1 });
  }
  return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
}

export async function normalizeImageArtifact(input: {
  sourcePath: string;
  workdir: string;
  deliverableIndex: number;
  requestedFormat?: string | null;
  requestedWidth?: number | null;
  requestedHeight?: number | null;
  limits?: Partial<ImageNormalizationLimits>;
}): Promise<ImageNormalizationResult> {
  const limits = resolveImageNormalizationLimits(input.limits);
  const source = await readBoundedSource({
    sourcePath: input.sourcePath,
    workdir: input.workdir,
    limits
  });
  const sourceInspection = await inspectRasterBytes(source.bytes, source.sizeBytes, limits);
  const requestedWidth = validateRequestedDimension(input.requestedWidth, limits, "width");
  const requestedHeight = validateRequestedDimension(input.requestedHeight, limits, "height");
  const format = resolveNormalizedImageFormat(input.requestedFormat, sourceInspection.format);
  const outputDimensions = requestedOutputDimensions({
    sourceWidth: sourceInspection.width,
    sourceHeight: sourceInspection.height,
    requestedWidth,
    requestedHeight
  });
  if (outputDimensions.width > limits.maxDimension || outputDimensions.height > limits.maxDimension ||
      outputDimensions.width * outputDimensions.height > limits.maxOutputPixels) {
    throw new ImageNormalizationError("image_requested_output_too_large", {
      width: outputDimensions.width,
      height: outputDimensions.height,
      maxDimension: limits.maxDimension,
      maxOutputPixels: limits.maxOutputPixels
    });
  }

  const bothDimensionsRequested = requestedWidth !== null && requestedHeight !== null;
  const cropFraction = bothDimensionsRequested
    ? imageCoverCropFraction({
      sourceWidth: sourceInspection.width,
      sourceHeight: sourceInspection.height,
      targetWidth: requestedWidth,
      targetHeight: requestedHeight
    })
    : 0;
  const dimensionsChanged =
    sourceInspection.width !== outputDimensions.width || sourceInspection.height !== outputDimensions.height;
  if (bothDimensionsRequested && dimensionsChanged && cropFraction > limits.maxCropFraction) {
    throw new ImageNormalizationError("image_aspect_ratio_crop_too_large", {
      sourceWidth: sourceInspection.width,
      sourceHeight: sourceInspection.height,
      targetWidth: requestedWidth,
      targetHeight: requestedHeight,
      cropFraction,
      maxCropFraction: limits.maxCropFraction
    });
  }

  const orientationChanged = sourceInspection.orientation !== null && sourceInspection.orientation !== 1;
  const formatChanged = sourceInspection.format !== format;
  const transformed = dimensionsChanged || orientationChanged || formatChanged;
  if (!transformed) {
    return {
      filePath: source.canonicalSource,
      fileName: path.basename(source.canonicalSource),
      mimeType: mimeTypeForFormat(format),
      format,
      width: sourceInspection.width,
      height: sourceInspection.height,
      sizeBytes: source.sizeBytes,
      checksumSha256: source.checksumSha256,
      sourceChecksumSha256: source.checksumSha256,
      transformed: false,
      reused: true,
      fit: "none",
      cropFraction: 0
    };
  }

  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    sourceChecksumSha256: source.checksumSha256,
    format,
    requestedWidth,
    requestedHeight,
    maxCropFraction: limits.maxCropFraction,
    jpegQuality: 94,
    webpQuality: 92
  })).digest("hex");
  const outputDir = path.join(source.canonicalRoot, "normalized-images");
  await mkdir(outputDir, { recursive: true });
  const canonicalOutputDir = await realpath(outputDir);
  if (!isInsideDirectory(source.canonicalRoot, canonicalOutputDir)) {
    throw new ImageNormalizationError("image_source_outside_job_workdir");
  }
  const fileName = `deliverable-${input.deliverableIndex + 1}-${fingerprint.slice(0, 16)}.${extensionForFormat(format)}`;
  const filePath = path.join(canonicalOutputDir, fileName);
  const reusable = await inspectReusableOutput({
    filePath,
    format,
    requestedWidth,
    requestedHeight,
    limits
  });
  const fit = bothDimensionsRequested ? "cover_attention" : "scale";
  if (reusable) {
    return {
      filePath,
      fileName,
      mimeType: mimeTypeForFormat(format),
      format,
      width: reusable.inspection.width,
      height: reusable.inspection.height,
      sizeBytes: reusable.inspection.sizeBytes,
      checksumSha256: reusable.checksumSha256,
      sourceChecksumSha256: source.checksumSha256,
      transformed: true,
      reused: true,
      fit,
      cropFraction
    };
  }
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  const tempPath = path.join(canonicalOutputDir, `.${fileName}.${randomUUID()}.tmp`);
  try {
    let pipeline = sharp(source.bytes, {
      failOn: "error",
      limitInputPixels: limits.maxInputPixels,
      sequentialRead: true
    }).autoOrient().toColourspace("srgb");
    if (bothDimensionsRequested) {
      pipeline = pipeline.resize({
        width: requestedWidth,
        height: requestedHeight,
        fit: "cover",
        position: sharp.strategy.attention,
        kernel: sharp.kernel.lanczos3
      });
    } else if (requestedWidth !== null || requestedHeight !== null) {
      pipeline = pipeline.resize({
        width: requestedWidth ?? undefined,
        height: requestedHeight ?? undefined,
        fit: "inside",
        kernel: sharp.kernel.lanczos3
      });
    }
    pipeline = applyOutputFormat(pipeline, format).timeout({ seconds: limits.timeoutSeconds });
    const outputInfo = await pipeline.toFile(tempPath);
    if (outputInfo.size > limits.maxOutputBytes) {
      throw new ImageNormalizationError("image_normalized_output_too_large", {
        sizeBytes: outputInfo.size,
        maxOutputBytes: limits.maxOutputBytes
      });
    }

    const tempHandle = await open(tempPath, "r+");
    try {
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    const outputInspection = await inspectRasterImageFile(tempPath, limits);
    if (!matchesExpectedOutput(outputInspection, format, requestedWidth, requestedHeight)) {
      throw new ImageNormalizationError("image_normalized_output_invalid", {
        expectedFormat: format,
        actualFormat: outputInspection.format,
        expectedWidth: requestedWidth,
        actualWidth: outputInspection.width,
        expectedHeight: requestedHeight,
        actualHeight: outputInspection.height
      });
    }

    try {
      await rename(tempPath, filePath);
    } catch (error) {
      const racedOutput = await inspectReusableOutput({
        filePath,
        format,
        requestedWidth,
        requestedHeight,
        limits
      });
      if (!racedOutput) {
        throw error;
      }
      await unlink(tempPath).catch(() => undefined);
    }
    const finalized = await inspectReusableOutput({
      filePath,
      format,
      requestedWidth,
      requestedHeight,
      limits
    });
    if (!finalized) {
      throw new ImageNormalizationError("image_normalized_output_invalid");
    }
    return {
      filePath,
      fileName,
      mimeType: mimeTypeForFormat(format),
      format,
      width: finalized.inspection.width,
      height: finalized.inspection.height,
      sizeBytes: finalized.inspection.sizeBytes,
      checksumSha256: finalized.checksumSha256,
      sourceChecksumSha256: source.checksumSha256,
      transformed: true,
      reused: false,
      fit,
      cropFraction
    };
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}
