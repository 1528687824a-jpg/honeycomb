import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import {
  projectJobExecutionUpdateNotice,
  registerJobExecutionUpdateStream,
  resolveJobExecutionUpdateStreamCursor
} from "../apps/orchestrator-api/src/job-execution-update-stream";
import { consumeServerSentEvents } from "../apps/desktop-app/src/sse";
import {
  JOB_EXECUTION_UPDATE_CURSOR_MAX,
  isJobExecutionUpdateCursor
} from "../packages/shared/src/job-execution-updates";

test("job update stream starts at a snapshot boundary and resumes durable cursors", () => {
  assert.equal(isJobExecutionUpdateCursor("0"), true);
  assert.equal(isJobExecutionUpdateCursor(JOB_EXECUTION_UPDATE_CURSOR_MAX), true);
  assert.equal(isJobExecutionUpdateCursor("9223372036854775808"), false);
  assert.equal(isJobExecutionUpdateCursor("not-a-cursor"), false);
  assert.deepEqual(resolveJobExecutionUpdateStreamCursor("100", null), {
    cursor: "100",
    resyncRequired: true,
    reason: "initial_snapshot_required"
  });
  assert.deepEqual(resolveJobExecutionUpdateStreamCursor("100", "42"), {
    cursor: "42",
    resyncRequired: false,
    reason: null
  });
  assert.deepEqual(resolveJobExecutionUpdateStreamCursor("100", "101"), {
    cursor: "100",
    resyncRequired: true,
    reason: "cursor_ahead"
  });
});

test("desktop SSE parser cancels the response when a consumer rejects an event", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
    },
    cancel() {
      cancelled = true;
    }
  }));

  await assert.rejects(
    consumeServerSentEvents(response, () => {
      throw new Error("consumer_failed");
    }),
    /consumer_failed/
  );
  assert.equal(cancelled, true);
});

test("job update notices preserve cursor order and coalesce duplicate job ids", () => {
  const notice = projectJobExecutionUpdateNotice({
    afterEventId: "40",
    cursor: "43",
    hasMore: true,
    events: [
      { eventId: "41", jobId: "JOB-2", createdAt: "2026-07-14T12:00:01.000Z" },
      { eventId: "42", jobId: "JOB-1", createdAt: "2026-07-14T12:00:02.000Z" },
      { eventId: "43", jobId: "JOB-2", createdAt: "2026-07-14T12:00:03.000Z" }
    ]
  });

  assert.equal(notice?.cursor, "43");
  assert.deepEqual(notice?.jobIds, ["JOB-2", "JOB-1"]);
  assert.equal(notice?.eventCount, 3);
  assert.equal(notice?.occurredAt, "2026-07-14T12:00:03.000Z");
  assert.equal(notice?.hasMore, true);
});

test("desktop SSE parser handles split chunks, comments, and multiline data", async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 1000\n: keepalive\nid: 4"));
      controller.enqueue(encoder.encode("2\nevent: jobs_changed\ndata: {\"first\":true,"));
      controller.enqueue(encoder.encode("\ndata: \"second\":true}\n\n"));
      controller.close();
    }
  }));
  const events: unknown[] = [];

  const result = await consumeServerSentEvents(response, (event) => events.push(event));

  assert.deepEqual(events, [{
    event: "jobs_changed",
    data: "{\"first\":true,\n\"second\":true}",
    id: "42",
    retryMs: 1000
  }]);
  assert.equal(result.lastEventId, "42");
});

test("HTTP job update stream emits ready and resumable invalidation events", async () => {
  const app = express();
  registerJobExecutionUpdateStream(app, {
    maxConnections: 1,
    getLatestCursor: async () => "10",
    getUpdateWindow: async ({ afterEventId }) => afterEventId === "10" ? {
      afterEventId,
      cursor: "11",
      events: [{
        eventId: "11",
        jobId: "JOB-HTTP-1",
        createdAt: "2026-07-14T12:00:01.000Z"
      }],
      hasMore: false
    } : {
      afterEventId,
      cursor: afterEventId,
      events: [],
      hasMore: false
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/jobs/execution-updates/stream?pollMs=10000&heartbeatMs=60000`,
      {
        headers: { "last-event-id": "10" },
        signal: controller.signal
      }
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: jobs_changed")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }

    assert.match(text, /event: ready/);
    assert.match(text, /"resyncRequired":false/);
    assert.match(text, /id: 11/);
    assert.match(text, /"jobIds":\["JOB-HTTP-1"\]/);
    assert.equal(text.includes("payload"), false);
  } finally {
    await reader?.cancel().catch(() => undefined);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
