import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRequiredDocumentDeliverable,
  normalizeDocumentFormat,
  resolveDocumentDeliverableFormat
} from "../packages/shared/src/document-delivery-policy";
import type { TaskDeliverable } from "../packages/shared/src/types";

function deliverable(overrides: Partial<TaskDeliverable> = {}): TaskDeliverable {
  return {
    kind: "text",
    description: "Report",
    required: true,
    format: null,
    width: null,
    height: null,
    target: "conversation",
    targetPath: null,
    ...overrides
  };
}

test("ordinary conversation text does not require a document file", () => {
  const chat = deliverable();
  assert.equal(resolveDocumentDeliverableFormat(chat), null);
  assert.equal(isRequiredDocumentDeliverable(chat), false);
});

test("explicit formats and local text targets require real document files", () => {
  assert.equal(resolveDocumentDeliverableFormat(deliverable({ format: "word" })), "docx");
  assert.equal(resolveDocumentDeliverableFormat(deliverable({ format: "markdown" })), "md");
  assert.equal(resolveDocumentDeliverableFormat(deliverable({ target: "desktop" })), "md");
  assert.equal(isRequiredDocumentDeliverable(deliverable({ format: "pdf" })), true);
  assert.equal(isRequiredDocumentDeliverable(deliverable({ target: "workspace" })), true);
});

test("media and optional outputs are not reclassified as required documents", () => {
  assert.equal(isRequiredDocumentDeliverable(deliverable({ kind: "image", format: "png" })), false);
  assert.equal(isRequiredDocumentDeliverable(deliverable({ required: false, format: "docx" })), false);
  assert.equal(normalizeDocumentFormat(".PowerPoint"), "pptx");
  assert.equal(normalizeDocumentFormat("exe"), null);
});
