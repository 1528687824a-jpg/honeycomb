import type { TaskDeliverable } from "./types";

export const DOCUMENT_FORMATS = [
  "md",
  "txt",
  "json",
  "csv",
  "pdf",
  "docx",
  "pptx",
  "xlsx"
] as const;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];
export type NormalizableDocumentFormat = Extract<
  DocumentFormat,
  "md" | "txt" | "json" | "csv" | "pdf" | "docx"
>;

const FORMAT_ALIASES: Record<string, DocumentFormat> = {
  markdown: "md",
  text: "txt",
  plain: "txt",
  plaintext: "txt",
  word: "docx",
  powerpoint: "pptx",
  excel: "xlsx"
};

export function normalizeDocumentFormat(value: string | null | undefined): DocumentFormat | null {
  const normalized = value?.trim().toLowerCase().replace(/^\./, "") ?? "";
  const aliased = FORMAT_ALIASES[normalized] ?? normalized;
  return (DOCUMENT_FORMATS as readonly string[]).includes(aliased)
    ? aliased as DocumentFormat
    : null;
}

export function resolveDocumentDeliverableFormat(
  deliverable: TaskDeliverable
): DocumentFormat | null {
  const explicit = normalizeDocumentFormat(deliverable.format);
  if (explicit) {
    return explicit;
  }
  if (
    (deliverable.kind === "text" || deliverable.kind === "file") &&
    deliverable.target !== "conversation"
  ) {
    return "md";
  }
  if (deliverable.kind === "file") {
    return "md";
  }
  return null;
}

export function isRequiredDocumentDeliverable(deliverable: TaskDeliverable) {
  if (!deliverable.required) {
    return false;
  }
  if (deliverable.kind === "image" || deliverable.kind === "video") {
    return false;
  }
  return resolveDocumentDeliverableFormat(deliverable) !== null;
}

export function isTextConvertibleDocumentFormat(
  format: DocumentFormat
): format is NormalizableDocumentFormat {
  return format === "md" || format === "txt" || format === "json" ||
    format === "csv" || format === "pdf" || format === "docx";
}
