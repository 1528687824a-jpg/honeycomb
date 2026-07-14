import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type VideoFileInspection = {
  format: "mp4" | "mov";
  width: number;
  height: number;
};

type IsoBox = {
  type: string;
  dataStart: number;
  end: number;
};

async function readBytes(handle: FileHandle, position: number, length: number) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : null;
}

async function readBox(handle: FileHandle, offset: number, parentEnd: number): Promise<IsoBox | null> {
  const header = await readBytes(handle, offset, 8);
  if (!header) return null;
  let size = header.readUInt32BE(0);
  const type = header.toString("ascii", 4, 8);
  let headerSize = 8;
  if (size === 1) {
    const extended = await readBytes(handle, offset + 8, 8);
    if (!extended) return null;
    const extendedSize = extended.readBigUInt64BE(0);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size === 0) {
    size = parentEnd - offset;
  }
  if (size < headerSize || offset + size > parentEnd) return null;
  return {
    type,
    dataStart: offset + headerSize,
    end: offset + size
  };
}

async function childBoxes(handle: FileHandle, start: number, end: number) {
  const boxes: IsoBox[] = [];
  let offset = start;
  for (let count = 0; offset + 8 <= end && count < 100_000; count += 1) {
    const box = await readBox(handle, offset, end);
    if (!box) break;
    boxes.push(box);
    if (box.end <= offset) break;
    offset = box.end;
  }
  return boxes;
}

async function childBox(handle: FileHandle, parent: IsoBox, type: string) {
  return (await childBoxes(handle, parent.dataStart, parent.end)).find((box) => box.type === type) ?? null;
}

async function trackIsVideo(handle: FileHandle, track: IsoBox) {
  const media = await childBox(handle, track, "mdia");
  if (!media) return false;
  const handler = await childBox(handle, media, "hdlr");
  if (!handler) return false;
  const payload = await readBytes(handle, handler.dataStart, 12);
  return payload?.toString("ascii", 8, 12) === "vide";
}

async function trackDimensions(handle: FileHandle, track: IsoBox) {
  const header = await childBox(handle, track, "tkhd");
  if (!header) return null;
  const versionByte = await readBytes(handle, header.dataStart, 1);
  if (!versionByte) return null;
  const version = versionByte[0];
  const matrixOffset = version === 1 ? 52 : version === 0 ? 40 : null;
  const widthOffset = version === 1 ? 88 : version === 0 ? 76 : null;
  if (matrixOffset === null || widthOffset === null) return null;
  const payload = await readBytes(handle, header.dataStart, widthOffset + 8);
  if (!payload) return null;
  let width = Math.round(payload.readUInt32BE(widthOffset) / 65_536);
  let height = Math.round(payload.readUInt32BE(widthOffset + 4) / 65_536);
  const b = payload.readInt32BE(matrixOffset + 4) / 65_536;
  const c = payload.readInt32BE(matrixOffset + 12) / 65_536;
  if (Math.abs(b) > 0.5 && Math.abs(c) > 0.5) {
    [width, height] = [height, width];
  }
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000
    ? { width, height }
    : null;
}

export async function inspectVideoFile(filePath: string): Promise<VideoFileInspection | null> {
  const handle = await open(filePath, "r");
  try {
    const fileSize = (await handle.stat()).size;
    if (fileSize < 16) return null;
    const topLevel = await childBoxes(handle, 0, fileSize);
    const fileType = topLevel.find((box) => box.type === "ftyp");
    const movie = topLevel.find((box) => box.type === "moov");
    if (!fileType || !movie) return null;
    const brand = await readBytes(handle, fileType.dataStart, 4);
    if (!brand) return null;
    const format = brand.toString("ascii") === "qt  " ? "mov" : "mp4";
    for (const track of (await childBoxes(handle, movie.dataStart, movie.end)).filter(
      (box) => box.type === "trak"
    )) {
      if (!await trackIsVideo(handle, track)) continue;
      const dimensions = await trackDimensions(handle, track);
      if (dimensions) return { format, ...dimensions };
    }
    return null;
  } finally {
    await handle.close();
  }
}
