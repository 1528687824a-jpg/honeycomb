import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectVideoFile } from "../packages/shared/src/video-file-inspection";

function box(type: string, ...payloads: Buffer[]) {
  const payload = Buffer.concat(payloads);
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, "ascii");
  payload.copy(result, 8);
  return result;
}

function videoTrack(width: number, height: number, rotated = false) {
  const trackHeader = Buffer.alloc(84);
  trackHeader.writeInt32BE(rotated ? 0 : 65_536, 40);
  trackHeader.writeInt32BE(rotated ? 65_536 : 0, 44);
  trackHeader.writeInt32BE(rotated ? -65_536 : 0, 52);
  trackHeader.writeInt32BE(rotated ? 0 : 65_536, 56);
  trackHeader.writeUInt32BE(width * 65_536, 76);
  trackHeader.writeUInt32BE(height * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  return box("trak", box("tkhd", trackHeader), box("mdia", box("hdlr", handler)));
}

test("inspectVideoFile reads MP4 display dimensions without loading media payloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "honeycomb-mp4-inspection-"));
  try {
    const filePath = path.join(directory, "portrait.mp4");
    const fileType = Buffer.alloc(8);
    fileType.write("isom", 0, 4, "ascii");
    await writeFile(filePath, Buffer.concat([
      box("ftyp", fileType),
      box("mdat", Buffer.from("video-payload")),
      box("moov", videoTrack(1080, 1920))
    ]));
    assert.deepEqual(await inspectVideoFile(filePath), {
      format: "mp4",
      width: 1080,
      height: 1920
    });

    const rotatedPath = path.join(directory, "rotated.mov");
    const quickTimeType = Buffer.alloc(8);
    quickTimeType.write("qt  ", 0, 4, "ascii");
    await writeFile(rotatedPath, Buffer.concat([
      box("ftyp", quickTimeType),
      box("moov", videoTrack(1920, 1080, true))
    ]));
    assert.deepEqual(await inspectVideoFile(rotatedPath), {
      format: "mov",
      width: 1080,
      height: 1920
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspectVideoFile rejects arbitrary bytes and malformed boxes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "honeycomb-invalid-video-"));
  try {
    const filePath = path.join(directory, "not-video.mp4");
    await writeFile(filePath, Buffer.from("not an ISO media file"));
    assert.equal(await inspectVideoFile(filePath), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
