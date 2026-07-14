import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import {
  ImageNormalizationError,
  inspectRasterImageFile,
  normalizeImageArtifact
} from "../apps/dbos-worker/src/image-normalization";

async function withTempWorkdir(run: (workdir: string) => Promise<void>) {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-image-normalization-"));
  try {
    await run(workdir);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

test("JPEG artwork is converted to an exact PNG canvas and reused after recovery", async () => {
  await withTempWorkdir(async (workdir) => {
    const sourcePath = path.join(workdir, "seedream-output.jpg");
    await sharp({
      create: {
        width: 1024,
        height: 1792,
        channels: 3,
        background: { r: 72, g: 116, b: 91 }
      }
    }).jpeg({ quality: 90 }).toFile(sourcePath);

    const first = await normalizeImageArtifact({
      sourcePath,
      workdir,
      deliverableIndex: 0,
      requestedFormat: "png",
      requestedWidth: 1080,
      requestedHeight: 1920
    });
    assert.equal(first.transformed, true);
    assert.equal(first.reused, false);
    assert.equal(first.format, "png");
    assert.equal(first.width, 1080);
    assert.equal(first.height, 1920);
    assert.equal(first.fit, "cover_attention");
    assert.ok(first.cropFraction > 0 && first.cropFraction < 0.02);
    assert.notEqual(first.filePath, sourcePath);
    assert.deepEqual(
      await inspectRasterImageFile(first.filePath),
      {
        format: "png",
        width: 1080,
        height: 1920,
        orientation: null,
        pages: 1,
        hasAlpha: false,
        sizeBytes: first.sizeBytes
      }
    );
    assert.deepEqual(
      { format: (await inspectRasterImageFile(sourcePath)).format, width: (await inspectRasterImageFile(sourcePath)).width },
      { format: "jpeg", width: 1024 }
    );

    const recovered = await normalizeImageArtifact({
      sourcePath,
      workdir,
      deliverableIndex: 0,
      requestedFormat: "png",
      requestedWidth: 1080,
      requestedHeight: 1920
    });
    assert.equal(recovered.filePath, first.filePath);
    assert.equal(recovered.checksumSha256, first.checksumSha256);
    assert.equal(recovered.reused, true);

    await writeFile(first.filePath, "interrupted-output");
    const repaired = await normalizeImageArtifact({
      sourcePath,
      workdir,
      deliverableIndex: 0,
      requestedFormat: "png",
      requestedWidth: 1080,
      requestedHeight: 1920
    });
    assert.equal(repaired.filePath, first.filePath);
    assert.equal(repaired.reused, false);
    assert.deepEqual(
      { format: (await inspectRasterImageFile(repaired.filePath)).format, width: repaired.width, height: repaired.height },
      { format: "png", width: 1080, height: 1920 }
    );
  });
});

test("transparent pixels are flattened to white for JPEG and preserved for WebP", async () => {
  await withTempWorkdir(async (workdir) => {
    const sourcePath = path.join(workdir, "transparent.png");
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0 }
      }
    }).png().toFile(sourcePath);

    const jpeg = await normalizeImageArtifact({
      sourcePath,
      workdir,
      deliverableIndex: 0,
      requestedFormat: "jpeg"
    });
    const jpegPixel = await sharp(jpeg.filePath).raw().toBuffer();
    assert.ok(jpegPixel[0] >= 250 && jpegPixel[1] >= 250 && jpegPixel[2] >= 250);
    assert.equal((await inspectRasterImageFile(jpeg.filePath)).hasAlpha, false);

    const webp = await normalizeImageArtifact({
      sourcePath,
      workdir,
      deliverableIndex: 1,
      requestedFormat: "webp"
    });
    assert.equal((await inspectRasterImageFile(webp.filePath)).hasAlpha, true);
  });
});

test("EXIF orientation is applied before the exact output is validated", async () => {
  await withTempWorkdir(async (workdir) => {
    const sourcePath = path.join(workdir, "rotated.jpg");
    await sharp({
      create: {
        width: 20,
        height: 10,
        channels: 3,
        background: { r: 180, g: 80, b: 60 }
      }
    }).jpeg().withMetadata({ orientation: 6 }).toFile(sourcePath);
    const source = await inspectRasterImageFile(sourcePath);
    assert.deepEqual(
      { width: source.width, height: source.height, orientation: source.orientation },
      { width: 10, height: 20, orientation: 6 }
    );

    const normalized = await normalizeImageArtifact({
      sourcePath,
      workdir,
      deliverableIndex: 0,
      requestedFormat: "jpeg",
      requestedWidth: 10,
      requestedHeight: 20
    });
    assert.equal(normalized.transformed, true);
    assert.deepEqual(
      { width: normalized.width, height: normalized.height },
      { width: 10, height: 20 }
    );
    assert.equal((await inspectRasterImageFile(normalized.filePath)).orientation, null);
  });
});

test("large destructive crops and oversized output requests are rejected", async () => {
  await withTempWorkdir(async (workdir) => {
    const sourcePath = path.join(workdir, "square.png");
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 40, g: 50, b: 60 }
      }
    }).png().toFile(sourcePath);

    await assert.rejects(
      normalizeImageArtifact({
        sourcePath,
        workdir,
        deliverableIndex: 0,
        requestedFormat: "png",
        requestedWidth: 100,
        requestedHeight: 300,
        limits: { maxCropFraction: 0.15 }
      }),
      (error: unknown) => error instanceof ImageNormalizationError &&
        error.code === "image_aspect_ratio_crop_too_large"
    );
    await assert.rejects(
      normalizeImageArtifact({
        sourcePath,
        workdir,
        deliverableIndex: 0,
        requestedFormat: "png",
        requestedWidth: 1000,
        requestedHeight: 1000,
        limits: { maxOutputPixels: 999_999 }
      }),
      (error: unknown) => error instanceof ImageNormalizationError &&
        error.code === "image_requested_output_too_large"
    );
  });
});

test("an image outside the job workdir cannot be normalized", async () => {
  await withTempWorkdir(async (workdir) => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-image-outside-"));
    try {
      const sourcePath = path.join(outsideDir, "outside.png");
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 1, g: 2, b: 3 }
        }
      }).png().toFile(sourcePath);
      await assert.rejects(
        normalizeImageArtifact({
          sourcePath,
          workdir,
          deliverableIndex: 0,
          requestedFormat: "png"
        }),
        (error: unknown) => error instanceof ImageNormalizationError &&
          error.code === "image_source_outside_job_workdir"
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
