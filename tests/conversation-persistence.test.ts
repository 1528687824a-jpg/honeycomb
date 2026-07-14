import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationClientTimestamp } from "../packages/db/src/conversations";

test("conversation sync keeps valid client timestamps", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");
  assert.equal(
    normalizeConversationClientTimestamp("2026-07-14T11:59:00.000Z", now),
    "2026-07-14T11:59:00.000Z"
  );
});

test("conversation sync replaces invalid timestamps with server time", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");
  assert.equal(
    normalizeConversationClientTimestamp("not-a-date", now),
    "2026-07-14T12:00:00.000Z"
  );
});

test("conversation sync clamps timestamps that are too far in the future", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");
  assert.equal(
    normalizeConversationClientTimestamp("2026-07-15T12:00:00.000Z", now),
    "2026-07-14T12:05:00.000Z"
  );
});
