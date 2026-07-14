import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { parse as parseCsv } from "csv-parse/sync";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import { create as createFont } from "fontkit";
import { marked } from "marked";
import { PDFDocument as PdfReader } from "pdf-lib";
import PDFDocument from "pdfkit";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import {
  DOCUMENT_FORMATS,
  type DocumentFormat,
  type NormalizableDocumentFormat
} from "../../../packages/shared/src/document-delivery-policy";

const DOCUMENT_EXTENSIONS = new Set([
  ...DOCUMENT_FORMATS,
  "markdown"
]);

export type DocumentFileInspection = {
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  pageCount: number | null;
  entryCount: number | null;
  textCharacters: number | null;
};

export type DocumentNormalizationResult = DocumentFileInspection & {
  filePath: string;
  fileName: string;
  sourceChecksumSha256: string;
  transformed: boolean;
  reused: boolean;
};

export type DocumentNormalizationErrorCode =
  | "document_source_outside_job_workdir"
  | "document_source_not_regular_file"
  | "document_source_empty"
  | "document_source_too_large"
  | "document_source_not_utf8"
  | "document_source_contains_binary_controls"
  | "document_format_unsupported"
  | "document_json_invalid"
  | "document_csv_invalid"
  | "document_pdf_invalid"
  | "document_ooxml_invalid"
  | "document_archive_unsafe"
  | "document_output_too_large"
  | "document_output_invalid"
  | "document_pdf_unicode_font_unavailable";

export class DocumentNormalizationError extends Error {
  readonly code: DocumentNormalizationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DocumentNormalizationErrorCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "DocumentNormalizationError";
    this.code = code;
    this.details = details;
  }
}

type DocumentLimits = {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxTextCharacters: number;
  maxZipEntries: number;
  maxZipUncompressedBytes: number;
  maxZipEntryBytes: number;
  maxDiscoveredFiles: number;
  maxDiscoveryDepth: number;
};

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function resolveDocumentLimits(overrides: Partial<DocumentLimits> = {}): DocumentLimits {
  return {
    maxInputBytes: overrides.maxInputBytes ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_INPUT_BYTES",
      50 * 1024 * 1024
    ),
    maxOutputBytes: overrides.maxOutputBytes ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_OUTPUT_BYTES",
      100 * 1024 * 1024
    ),
    maxTextCharacters: overrides.maxTextCharacters ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_TEXT_CHARACTERS",
      2_000_000
    ),
    maxZipEntries: overrides.maxZipEntries ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_ZIP_ENTRIES",
      5_000
    ),
    maxZipUncompressedBytes: overrides.maxZipUncompressedBytes ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_ZIP_UNCOMPRESSED_BYTES",
      200 * 1024 * 1024
    ),
    maxZipEntryBytes: overrides.maxZipEntryBytes ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_ZIP_ENTRY_BYTES",
      20 * 1024 * 1024
    ),
    maxDiscoveredFiles: overrides.maxDiscoveredFiles ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_DISCOVERED_FILES",
      200
    ),
    maxDiscoveryDepth: overrides.maxDiscoveryDepth ?? positiveIntegerEnv(
      "HONEYCOMB_DOCUMENT_MAX_DISCOVERY_DEPTH",
      3
    )
  };
}

function isInsideDirectory(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mimeTypeForFormat(format: DocumentFormat) {
  switch (format) {
    case "md":
      return "text/markdown; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
}

function normalizedExtension(filePath: string) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extension === "markdown" ? "md" : extension;
}

function decodeUtf8Text(bytes: Buffer, limits: DocumentLimits) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentNormalizationError("document_source_not_utf8");
  }
  if (text.includes("\0")) {
    throw new DocumentNormalizationError("document_source_contains_binary_controls");
  }
  if (text.length > limits.maxTextCharacters) {
    throw new DocumentNormalizationError("document_source_too_large", {
      textCharacters: text.length,
      maxTextCharacters: limits.maxTextCharacters
    });
  }
  if (!text.trim()) {
    throw new DocumentNormalizationError("document_source_empty");
  }
  return text.replace(/^\uFEFF/, "");
}

async function readBoundedFile(filePath: string, maxBytes: number) {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new DocumentNormalizationError("document_source_not_regular_file");
    }
    if (fileStat.size <= 0) {
      throw new DocumentNormalizationError("document_source_empty");
    }
    if (fileStat.size > maxBytes) {
      throw new DocumentNormalizationError("document_source_too_large", {
        sizeBytes: fileStat.size,
        maxBytes
      });
    }
    const bytes = await handle.readFile();
    return {
      bytes,
      sizeBytes: fileStat.size,
      checksumSha256: createHash("sha256").update(bytes).digest("hex")
    };
  } finally {
    await handle.close();
  }
}

function openZip(bytes: Buffer) {
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(bytes, {
      autoClose: false,
      lazyEntries: true,
      validateEntrySizes: true,
      decodeStrings: true
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new DocumentNormalizationError("document_ooxml_invalid", {
          cause: error?.message ?? "zip_open_failed"
        }));
        return;
      }
      resolve(zipFile);
    });
  });
}

function safeZipEntryName(fileName: string) {
  const normalized = fileName.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/.test(normalized) &&
    !parts.some((part) => part === "..");
}

function readZipEntry(zipFile: ZipFile, entry: Entry, maxBytes: number) {
  return new Promise<Buffer>((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new DocumentNormalizationError("document_ooxml_invalid", {
          cause: error?.message ?? "zip_entry_open_failed"
        }));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy(new DocumentNormalizationError("document_archive_unsafe", {
            entry: entry.fileName,
            maxBytes
          }));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks, total)));
    });
  });
}

async function inspectOoxml(bytes: Buffer, limits: DocumentLimits) {
  const zipFile = await openZip(bytes);
  try {
    const entries = new Map<string, Entry>();
    let entryCount = 0;
    let totalUncompressed = 0;
    await new Promise<void>((resolve, reject) => {
      zipFile.once("error", reject);
      zipFile.once("end", resolve);
      zipFile.on("entry", (entry: Entry) => {
        entryCount += 1;
        totalUncompressed += entry.uncompressedSize;
        const compressionRatio = entry.compressedSize > 0
          ? entry.uncompressedSize / entry.compressedSize
          : entry.uncompressedSize > 0
            ? Number.POSITIVE_INFINITY
            : 1;
        if (!safeZipEntryName(entry.fileName) || (entry.generalPurposeBitFlag & 0x1) !== 0 ||
            entryCount > limits.maxZipEntries ||
            totalUncompressed > limits.maxZipUncompressedBytes ||
            entry.uncompressedSize > limits.maxZipEntryBytes ||
            (entry.uncompressedSize > 1024 * 1024 && compressionRatio > 1_000)) {
          reject(new DocumentNormalizationError("document_archive_unsafe", {
            entry: entry.fileName,
            entryCount,
            totalUncompressed,
            compressionRatio
          }));
          zipFile.close();
          return;
        }
        entries.set(entry.fileName.replace(/\\/g, "/"), entry);
        zipFile.readEntry();
      });
      zipFile.readEntry();
    });

    if (!entries.has("[Content_Types].xml") || !entries.has("_rels/.rels")) {
      throw new DocumentNormalizationError("document_ooxml_invalid", {
        reason: "package_roots_missing"
      });
    }
    const candidates: Array<{
      format: Extract<DocumentFormat, "docx" | "pptx" | "xlsx">;
      entryName: string;
      rootPattern: RegExp;
    }> = [
      { format: "docx", entryName: "word/document.xml", rootPattern: /<(?:\w+:)?document\b/i },
      { format: "pptx", entryName: "ppt/presentation.xml", rootPattern: /<(?:\w+:)?presentation\b/i },
      { format: "xlsx", entryName: "xl/workbook.xml", rootPattern: /<(?:\w+:)?workbook\b/i }
    ];
    const match = candidates.find((candidate) => entries.has(candidate.entryName));
    if (!match) {
      throw new DocumentNormalizationError("document_ooxml_invalid", {
        reason: "office_root_missing"
      });
    }
    const rootEntry = entries.get(match.entryName)!;
    const rootXml = decodeUtf8Text(
      await readZipEntry(zipFile, rootEntry, limits.maxZipEntryBytes),
      limits
    );
    if (!match.rootPattern.test(rootXml)) {
      throw new DocumentNormalizationError("document_ooxml_invalid", {
        reason: "office_root_invalid",
        entry: match.entryName
      });
    }
    return { format: match.format, entryCount };
  } finally {
    zipFile.close();
  }
}

async function inspectDocumentBytes(input: {
  bytes: Buffer;
  filePath: string;
  sizeBytes: number;
  checksumSha256: string;
  limits: DocumentLimits;
}): Promise<DocumentFileInspection> {
  const extension = normalizedExtension(input.filePath);
  let format: DocumentFormat | null = null;
  let pageCount: number | null = null;
  let entryCount: number | null = null;
  let textCharacters: number | null = null;

  if (input.bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    try {
      const pdf = await PdfReader.load(input.bytes, {
        ignoreEncryption: false,
        updateMetadata: false
      });
      pageCount = pdf.getPageCount();
      if (pageCount <= 0) {
        throw new Error("pdf_has_no_pages");
      }
      format = "pdf";
    } catch (error) {
      throw new DocumentNormalizationError("document_pdf_invalid", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  } else if (
    input.bytes.length >= 4 &&
    input.bytes[0] === 0x50 &&
    input.bytes[1] === 0x4b &&
    (input.bytes[2] === 0x03 || input.bytes[2] === 0x05 || input.bytes[2] === 0x07) &&
    (input.bytes[3] === 0x04 || input.bytes[3] === 0x06 || input.bytes[3] === 0x08)
  ) {
    const ooxml = await inspectOoxml(input.bytes, input.limits);
    format = ooxml.format;
    entryCount = ooxml.entryCount;
  } else if (extension === "json") {
    const text = decodeUtf8Text(input.bytes, input.limits);
    try {
      JSON.parse(text);
    } catch (error) {
      throw new DocumentNormalizationError("document_json_invalid", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    format = "json";
    textCharacters = text.length;
  } else if (extension === "csv") {
    const text = decodeUtf8Text(input.bytes, input.limits);
    try {
      const records = parseCsv(text, {
        bom: true,
        relax_column_count: false,
        skip_empty_lines: false,
        max_record_size: 1024 * 1024
      }) as unknown[][];
      if (records.length === 0) {
        throw new Error("csv_has_no_records");
      }
    } catch (error) {
      throw new DocumentNormalizationError("document_csv_invalid", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    format = "csv";
    textCharacters = text.length;
  } else if (extension === "md" || extension === "txt") {
    const text = decodeUtf8Text(input.bytes, input.limits);
    format = extension;
    textCharacters = text.length;
  }

  if (!format) {
    throw new DocumentNormalizationError("document_format_unsupported", {
      extension
    });
  }
  return {
    format,
    mimeType: mimeTypeForFormat(format),
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
    pageCount,
    entryCount,
    textCharacters
  };
}

export async function inspectDocumentFile(
  filePath: string,
  overrides: Partial<DocumentLimits> = {}
) {
  const limits = resolveDocumentLimits(overrides);
  const file = await readBoundedFile(filePath, limits.maxOutputBytes);
  return inspectDocumentBytes({ ...file, filePath, limits });
}

type LooseToken = {
  type: string;
  text?: string;
  raw?: string;
  depth?: number;
  ordered?: boolean;
  tokens?: LooseToken[];
  items?: LooseToken[];
  header?: LooseToken[];
  rows?: LooseToken[][];
};

type DocumentBlock = {
  type: "heading" | "paragraph" | "list" | "code" | "quote" | "table" | "rule";
  text: string;
  level: number;
};

function inlineTokenText(token: LooseToken): string {
  if (token.type === "br") {
    return "\n";
  }
  if (token.tokens?.length) {
    return token.tokens.map(inlineTokenText).join("");
  }
  return token.text ?? (token.type === "text" ? token.raw ?? "" : "");
}

function markdownBlocks(markdown: string) {
  const tokens = marked.lexer(markdown, { gfm: true }) as unknown as LooseToken[];
  const blocks: DocumentBlock[] = [];
  const visit = (token: LooseToken, level = 0) => {
    if (token.type === "space") return;
    if (token.type === "heading") {
      blocks.push({ type: "heading", text: inlineTokenText(token).trim(), level: token.depth ?? 1 });
      return;
    }
    if (token.type === "paragraph" || token.type === "text") {
      const text = inlineTokenText(token).trim();
      if (text) blocks.push({ type: "paragraph", text, level });
      return;
    }
    if (token.type === "code") {
      blocks.push({ type: "code", text: token.text ?? "", level });
      return;
    }
    if (token.type === "blockquote") {
      const text = (token.tokens ?? []).map(inlineTokenText).join("\n").trim();
      if (text) blocks.push({ type: "quote", text, level });
      return;
    }
    if (token.type === "list") {
      for (const [index, item] of (token.items ?? []).entries()) {
        const text = inlineTokenText(item).trim();
        if (text) {
          blocks.push({
            type: "list",
            text: `${token.ordered ? `${index + 1}.` : "•"} ${text}`,
            level
          });
        }
      }
      return;
    }
    if (token.type === "table") {
      const rows = [token.header ?? [], ...(token.rows ?? [])];
      for (const row of rows) {
        const text = row.map(inlineTokenText).join(" | ").trim();
        if (text) blocks.push({ type: "table", text, level });
      }
      return;
    }
    if (token.type === "hr") {
      blocks.push({ type: "rule", text: "", level });
      return;
    }
    for (const child of token.tokens ?? []) {
      visit(child, level);
    }
  };
  for (const token of tokens) {
    visit(token);
  }
  return blocks.length > 0
    ? blocks
    : [{ type: "paragraph", text: markdown.trim(), level: 0 } satisfies DocumentBlock];
}

function blocksToPlainText(blocks: DocumentBlock[]) {
  return `${blocks.map((block) => block.type === "rule" ? "---" : block.text).join("\n\n").trim()}\n`;
}

function headingLevel(level: number) {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  if (level === 4) return HeadingLevel.HEADING_4;
  if (level === 5) return HeadingLevel.HEADING_5;
  return HeadingLevel.HEADING_6;
}

async function buildDocx(markdown: string, title: string) {
  const blocks = markdownBlocks(markdown);
  const children = blocks.map((block) => {
    if (block.type === "heading") {
      return new Paragraph({ text: block.text, heading: headingLevel(block.level) });
    }
    if (block.type === "rule") {
      return new Paragraph({ text: "────────────────────────" });
    }
    return new Paragraph({
      indent: block.type === "list" || block.type === "quote"
        ? { left: 360 + block.level * 180 }
        : undefined,
      children: [new TextRun({
        text: block.text,
        italics: block.type === "quote",
        font: block.type === "code" ? "Consolas" : undefined
      })]
    });
  });
  const document = new Document({
    creator: "Honeycomb",
    title,
    description: "Generated by Honeycomb",
    sections: [{ children }]
  });
  return Packer.toBuffer(document);
}

async function resolvePdfFont(text: string) {
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) {
    return null;
  }
  const configuredPath = process.env.HONEYCOMB_DOCUMENT_PDF_FONT_PATH?.trim();
  const configuredFace = process.env.HONEYCOMB_DOCUMENT_PDF_FONT_FACE?.trim() || undefined;
  const candidates: Array<{ filePath: string; face?: string }> = [
    ...(configuredPath ? [{ filePath: configuredPath, face: configuredFace }] : []),
    { filePath: "C:\\Windows\\Fonts\\simhei.ttf" },
    { filePath: "C:\\Windows\\Fonts\\Deng.ttf" },
    { filePath: "C:\\Windows\\Fonts\\simfang.ttf" },
    { filePath: "C:\\Windows\\Fonts\\simkai.ttf" },
    { filePath: "C:\\Windows\\Fonts\\msyh.ttc", face: "MicrosoftYaHei" },
    {
      filePath: "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
      face: "NotoSansCJKsc-Regular"
    },
    { filePath: "/usr/share/fonts/opentype/unifont/unifont.otf" },
    {
      filePath: "/System/Library/Fonts/PingFang.ttc",
      face: "PingFangSC-Regular"
    }
  ];
  for (const candidate of candidates) {
    try {
      const fontFile = await readBoundedFile(candidate.filePath, 128 * 1024 * 1024);
      const parsedFont = createFont(fontFile.bytes, candidate.face) as
        | ReturnType<typeof createFont>
        | null;
      if (!parsedFont || "fonts" in parsedFont) {
        continue;
      }
      return {
        bytes: fontFile.bytes,
        face: candidate.face
      };
    } catch {
      continue;
    }
  }
  throw new DocumentNormalizationError("document_pdf_unicode_font_unavailable");
}

async function buildPdf(markdown: string, title: string) {
  const blocks = markdownBlocks(markdown);
  const font = await resolvePdfFont(`${title}\n${blocks.map((block) => block.text).join("\n")}`);
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: 54, right: 54, bottom: 54, left: 54 },
      info: {
        Title: title,
        Author: "Honeycomb",
        Creator: "Honeycomb"
      },
      autoFirstPage: true
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    document.once("error", reject);
    document.once("end", () => resolve(Buffer.concat(chunks)));

    const useFont = (size: number) => {
      if (font) {
        if (font.face) document.font(font.bytes, font.face);
        else document.font(font.bytes);
      } else {
        document.font("Helvetica");
      }
      document.fontSize(size);
    };

    for (const block of blocks) {
      if (block.type === "rule") {
        document.moveDown(0.25);
        document.moveTo(document.x, document.y).lineTo(540, document.y).strokeColor("#999999").stroke();
        document.moveDown(0.5);
        continue;
      }
      const size = block.type === "heading"
        ? Math.max(13, 24 - (block.level - 1) * 2)
        : block.type === "code"
          ? 9
          : 11;
      useFont(size);
      document.fillColor(block.type === "quote" ? "#555555" : "#111111");
      document.text(block.text, {
        indent: block.type === "list" || block.type === "quote" ? 18 + block.level * 9 : 0,
        lineGap: block.type === "code" ? 2 : 4,
        paragraphGap: block.type === "heading" ? 8 : 6
      });
    }
    document.end();
  });
}

function normalizeStructuredText(sourceText: string, format: Extract<DocumentFormat, "json" | "csv">) {
  if (format === "json") {
    try {
      const parsed = JSON.parse(sourceText.trim());
      if (parsed === null || typeof parsed !== "object") {
        throw new Error("json_root_must_be_object_or_array");
      }
      return `${JSON.stringify(parsed, null, 2)}\n`;
    } catch (error) {
      throw new DocumentNormalizationError("document_json_invalid", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }
  try {
    const records = parseCsv(sourceText, {
      bom: true,
      relax_column_count: false,
      skip_empty_lines: false,
      max_record_size: 1024 * 1024
    }) as unknown[][];
    if (records.length === 0) {
      throw new Error("csv_has_no_records");
    }
    return `${sourceText.replace(/^\uFEFF/, "").trimEnd()}\n`;
  } catch (error) {
    throw new DocumentNormalizationError("document_csv_invalid", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function outputExtension(format: NormalizableDocumentFormat) {
  return format;
}

async function inspectReusableOutput(input: {
  filePath: string;
  format: NormalizableDocumentFormat;
  limits: DocumentLimits;
}) {
  try {
    const inspection = await inspectDocumentFile(input.filePath, input.limits);
    return inspection.format === input.format ? inspection : null;
  } catch {
    return null;
  }
}

export async function normalizeDocumentArtifact(input: {
  sourcePath: string;
  workdir: string;
  deliverableIndex: number;
  requestedFormat: NormalizableDocumentFormat;
  title: string;
  limits?: Partial<DocumentLimits>;
}): Promise<DocumentNormalizationResult> {
  const limits = resolveDocumentLimits(input.limits);
  const canonicalRoot = await realpath(path.resolve(input.workdir));
  const canonicalSource = await realpath(path.resolve(input.sourcePath));
  if (!isInsideDirectory(canonicalRoot, canonicalSource)) {
    throw new DocumentNormalizationError("document_source_outside_job_workdir");
  }
  const source = await readBoundedFile(canonicalSource, limits.maxInputBytes);
  const sourceText = decodeUtf8Text(source.bytes, limits);
  const sourceExtension = normalizedExtension(canonicalSource);
  if (input.requestedFormat === "md" && sourceExtension === "md") {
    const inspection = await inspectDocumentBytes({
      ...source,
      filePath: canonicalSource,
      limits
    });
    return {
      ...inspection,
      filePath: canonicalSource,
      fileName: path.basename(canonicalSource),
      sourceChecksumSha256: source.checksumSha256,
      transformed: false,
      reused: true
    };
  }

  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    sourceChecksumSha256: source.checksumSha256,
    requestedFormat: input.requestedFormat,
    title: input.title
  })).digest("hex");
  const outputDir = path.join(canonicalRoot, "normalized-documents");
  await mkdir(outputDir, { recursive: true });
  const canonicalOutputDir = await realpath(outputDir);
  if (!isInsideDirectory(canonicalRoot, canonicalOutputDir)) {
    throw new DocumentNormalizationError("document_source_outside_job_workdir");
  }
  const fileName = `deliverable-${input.deliverableIndex + 1}-${fingerprint.slice(0, 16)}.${outputExtension(input.requestedFormat)}`;
  const filePath = path.join(canonicalOutputDir, fileName);
  const reusable = await inspectReusableOutput({
    filePath,
    format: input.requestedFormat,
    limits
  });
  if (reusable) {
    return {
      ...reusable,
      filePath,
      fileName,
      sourceChecksumSha256: source.checksumSha256,
      transformed: true,
      reused: true
    };
  }
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });

  let outputBytes: Buffer;
  if (input.requestedFormat === "txt") {
    outputBytes = Buffer.from(blocksToPlainText(markdownBlocks(sourceText)), "utf8");
  } else if (input.requestedFormat === "md") {
    outputBytes = Buffer.from(`${sourceText.trimEnd()}\n`, "utf8");
  } else if (input.requestedFormat === "json" || input.requestedFormat === "csv") {
    outputBytes = Buffer.from(
      normalizeStructuredText(sourceText, input.requestedFormat),
      "utf8"
    );
  } else if (input.requestedFormat === "docx") {
    outputBytes = await buildDocx(sourceText, input.title);
  } else {
    outputBytes = await buildPdf(sourceText, input.title);
  }
  if (outputBytes.length <= 0 || outputBytes.length > limits.maxOutputBytes) {
    throw new DocumentNormalizationError("document_output_too_large", {
      sizeBytes: outputBytes.length,
      maxOutputBytes: limits.maxOutputBytes
    });
  }

  const tempPath = path.join(canonicalOutputDir, `.${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, outputBytes, { flag: "wx" });
    const tempHandle = await open(tempPath, "r+");
    try {
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    const inspection = await inspectDocumentBytes({
      bytes: outputBytes,
      filePath,
      sizeBytes: outputBytes.length,
      checksumSha256: createHash("sha256").update(outputBytes).digest("hex"),
      limits
    });
    if (inspection.format !== input.requestedFormat) {
      throw new DocumentNormalizationError("document_output_invalid", {
        expectedFormat: input.requestedFormat,
        actualFormat: inspection.format
      });
    }
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      const raced = await inspectReusableOutput({
        filePath,
        format: input.requestedFormat,
        limits
      });
      if (!raced) throw error;
      await unlink(tempPath).catch(() => undefined);
    }
    const finalized = await inspectReusableOutput({
      filePath,
      format: input.requestedFormat,
      limits
    });
    if (!finalized) {
      throw new DocumentNormalizationError("document_output_invalid");
    }
    return {
      ...finalized,
      filePath,
      fileName,
      sourceChecksumSha256: source.checksumSha256,
      transformed: true,
      reused: false
    };
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

export async function discoverDocumentFiles(input: {
  directory: string;
  workdir: string;
  limits?: Partial<DocumentLimits>;
}) {
  const limits = resolveDocumentLimits(input.limits);
  const canonicalRoot = await realpath(path.resolve(input.workdir));
  const canonicalDirectory = await realpath(path.resolve(input.directory));
  if (!isInsideDirectory(canonicalRoot, canonicalDirectory)) {
    throw new DocumentNormalizationError("document_source_outside_job_workdir");
  }
  const discovered: Array<{
    filePath: string;
    inspection: DocumentFileInspection;
  }> = [];
  const rejected: Array<{ filePath: string; code: string }> = [];
  let scannedEntries = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDiscoveryDepth || scannedEntries >= limits.maxDiscoveredFiles) {
      return;
    }
    const directoryHandle = await opendir(directory);
    for await (const entry of directoryHandle) {
      if (scannedEntries >= limits.maxDiscoveredFiles) {
        break;
      }
      scannedEntries += 1;
      if (entry.isSymbolicLink()) {
        continue;
      }
      const candidatePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidatePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !DOCUMENT_EXTENSIONS.has(path.extname(entry.name).slice(1).toLowerCase())) {
        continue;
      }
      const canonicalCandidate = await realpath(candidatePath);
      if (!isInsideDirectory(canonicalRoot, canonicalCandidate)) {
        rejected.push({
          filePath: candidatePath,
          code: "document_source_outside_job_workdir"
        });
        continue;
      }
      try {
        discovered.push({
          filePath: canonicalCandidate,
          inspection: await inspectDocumentFile(canonicalCandidate, limits)
        });
      } catch (error) {
        rejected.push({
          filePath: canonicalCandidate,
          code: error instanceof DocumentNormalizationError
            ? error.code
            : "document_output_invalid"
        });
      }
    }
  };
  await walk(canonicalDirectory, 0);
  return { files: discovered, rejected };
}
