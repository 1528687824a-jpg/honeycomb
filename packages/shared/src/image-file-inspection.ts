export type ImageFileInspection = {
  format: "png" | "jpeg";
  width: number;
  height: number;
};

function uint16be(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 256 + bytes[offset + 1];
}

function uint32be(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3];
}

function inspectPng(bytes: Uint8Array): ImageFileInspection | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    return null;
  }
  const width = uint32be(bytes, 16);
  const height = uint32be(bytes, 20);
  return width > 0 && height > 0 ? { format: "png", width, height } : null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf
]);

function inspectJpeg(bytes: Uint8Array): ImageFileInspection | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = uint16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (JPEG_SOF_MARKERS.has(marker) && segmentLength >= 7) {
      const height = uint16be(bytes, offset + 3);
      const width = uint16be(bytes, offset + 5);
      return width > 0 && height > 0 ? { format: "jpeg", width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

export function inspectImageFile(bytes: Uint8Array): ImageFileInspection | null {
  return inspectPng(bytes) ?? inspectJpeg(bytes);
}
