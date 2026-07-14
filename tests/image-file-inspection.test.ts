import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectImageFile } from "../packages/shared/src/image-file-inspection";

test("PNG dimensions are read from the IHDR header", () => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x04, 0x38], 16);
  bytes.set([0x00, 0x00, 0x07, 0x80], 20);
  assert.deepEqual(inspectImageFile(bytes), { format: "png", width: 1080, height: 1920 });
});

test("JPEG dimensions are read from a start-of-frame segment", () => {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80, 0x04, 0x38,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00
  ]);
  assert.deepEqual(inspectImageFile(bytes), { format: "jpeg", width: 1080, height: 1920 });
  assert.equal(inspectImageFile(new Uint8Array([1, 2, 3, 4])), null);
});
