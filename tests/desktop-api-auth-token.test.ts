import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  __apiAuthTokenTestInternals,
  completeArtifactDelivery,
  consumeJobExecutionUpdates,
  createSessionEventsSource,
  listJobs,
  queryJobExecutionSummaries,
  resolveArtifactDownloadRequest
} from "../apps/desktop-app/src/api";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

function installWindow(storage: MemoryStorage) {
  (globalThis as { window?: unknown }).window = {
    localStorage: storage
  };
}

function listJobsResponse() {
  return {
    jobs: [],
    page: {
      limit: 1,
      hasMore: false,
      nextCursor: null,
      sort: "createdAt",
      order: "desc",
      filters: {}
    }
  };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  __apiAuthTokenTestInternals.resetRuntimeTokenLoaderForTests();
  __apiAuthTokenTestInternals.setStaticTokenForTests(null);
  __apiAuthTokenTestInternals.resetTokenCacheForTests();
});

test("desktop API auth prefers the runtime token over stale static and stored tokens", async () => {
  const storage = new MemoryStorage();
  storage.setItem("honeycomb.apiToken", "stored-old-token");
  installWindow(storage);
  __apiAuthTokenTestInternals.setStaticTokenForTests("static-old-token");
  __apiAuthTokenTestInternals.setRuntimeTokenLoaderForTests(async () => "runtime-fresh-token");

  const seenAuthHeaders: string[] = [];
  globalThis.fetch = async (_url, init) => {
    seenAuthHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify(listJobsResponse()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  await listJobs(1);

  assert.deepEqual(seenAuthHeaders, ["Bearer runtime-fresh-token"]);
  assert.equal(storage.getItem("honeycomb.apiToken"), "runtime-fresh-token");
});

test("desktop API auth refreshes the token and retries once after invalid_api_token", async () => {
  const storage = new MemoryStorage();
  installWindow(storage);
  let runtimeToken = "runtime-old-token";
  __apiAuthTokenTestInternals.setRuntimeTokenLoaderForTests(async () => runtimeToken);

  globalThis.fetch = async () =>
    new Response(JSON.stringify(listJobsResponse()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  await listJobs(1);

  runtimeToken = "runtime-fresh-token";
  const seenAuthHeaders: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    seenAuthHeaders.push(authorization);
    if (authorization === "Bearer runtime-old-token") {
      return new Response(JSON.stringify({ error: "invalid_api_token" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify(listJobsResponse()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  await listJobs(1);

  assert.deepEqual(seenAuthHeaders, ["Bearer runtime-old-token", "Bearer runtime-fresh-token"]);
  assert.equal(storage.getItem("honeycomb.apiToken"), "runtime-fresh-token");
});

test("desktop task list sends authenticated incremental summary queries", async () => {
  const storage = new MemoryStorage();
  installWindow(storage);
  __apiAuthTokenTestInternals.setRuntimeTokenLoaderForTests(async () => "runtime-summary-token");
  let seenUrl = "";
  let seenMethod = "";
  let seenAuthorization = "";
  let seenBody: unknown = null;
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenMethod = init?.method ?? "GET";
    seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      version: "honeycomb.job-execution-summary-query.v1",
      generatedAt: "2026-07-14T12:00:00.000Z",
      requested: 1,
      returned: 0,
      summaries: [],
      unchangedJobIds: ["JOB-1"],
      missingJobIds: [],
      revisions: { "JOB-1": "a".repeat(64) }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  await queryJobExecutionSummaries({
    jobIds: ["JOB-1"],
    knownRevisions: { "JOB-1": "a".repeat(64) }
  });

  assert.equal(seenUrl, "http://127.0.0.1:3000/jobs/execution-summaries/query");
  assert.equal(seenMethod, "POST");
  assert.equal(seenAuthorization, "Bearer runtime-summary-token");
  assert.deepEqual(seenBody, {
    jobIds: ["JOB-1"],
    knownRevisions: { "JOB-1": "a".repeat(64) }
  });
});

test("desktop job updates use an authenticated resumable stream without URL tokens", async () => {
  const storage = new MemoryStorage();
  installWindow(storage);
  __apiAuthTokenTestInternals.setRuntimeTokenLoaderForTests(async () => "runtime-stream-token");
  let seenUrl = "";
  let seenAuthorization = "";
  let seenLastEventId = "";
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    const headers = new Headers(init?.headers);
    seenAuthorization = headers.get("authorization") ?? "";
    seenLastEventId = headers.get("last-event-id") ?? "";
    return new Response([
      "id: 42",
      "event: ready",
      `data: ${JSON.stringify({
        version: "honeycomb.job-execution-update-stream.v1",
        cursor: "42",
        resyncRequired: false,
        reason: null,
        pollMs: 1000,
        heartbeatMs: 15000,
        batchLimit: 100
      })}`,
      "",
      "id: 43",
      "event: jobs_changed",
      `data: ${JSON.stringify({
        version: "honeycomb.job-execution-update-stream.v1",
        cursor: "43",
        jobIds: ["JOB-1"],
        eventCount: 2,
        occurredAt: "2026-07-14T12:00:01.000Z",
        hasMore: false
      })}`,
      ""
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  };
  const events: unknown[] = [];

  const result = await consumeJobExecutionUpdates(
    { afterEventId: "41" },
    (event) => events.push(event)
  );

  assert.equal(seenUrl, "http://127.0.0.1:3000/jobs/execution-updates/stream");
  assert.equal(seenUrl.includes("runtime-stream-token"), false);
  assert.equal(seenAuthorization, "Bearer runtime-stream-token");
  assert.equal(seenLastEventId, "41");
  assert.deepEqual(events.map((event: any) => event.type), ["ready", "jobs_changed"]);
  assert.equal(result.cursor, "43");
});

test("desktop session SSE uses a short ticket instead of the machine token in the URL", async () => {
  const storage = new MemoryStorage();
  installWindow(storage);
  __apiAuthTokenTestInternals.setRuntimeTokenLoaderForTests(async () => "runtime-machine-token");
  let ticketRequestAuthorization = "";
  let eventSourceUrl = "";
  globalThis.fetch = async (_url, init) => {
    ticketRequestAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      ticket: "short-lived-ticket",
      path: "/sessions/SESSION-1/events/stream",
      expiresAt: "2026-07-14T12:01:00.000Z",
      insecure: false
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  globalThis.EventSource = class {
    constructor(url: string | URL) {
      eventSourceUrl = String(url);
    }
  } as typeof EventSource;

  await createSessionEventsSource("SESSION-1", { afterSeq: 5 });

  assert.equal(ticketRequestAuthorization, "Bearer runtime-machine-token");
  assert.equal(eventSourceUrl.includes("stream_ticket=short-lived-ticket"), true);
  assert.equal(eventSourceUrl.includes("access_token"), false);
  assert.equal(eventSourceUrl.includes("runtime-machine-token"), false);
});

test("desktop artifact delivery prefers the authenticated Honeycomb file endpoint", async () => {
  const storage = new MemoryStorage();
  installWindow(storage);
  __apiAuthTokenTestInternals.setRuntimeTokenLoaderForTests(async () => "runtime-file-token");

  const request = await resolveArtifactDownloadRequest({
    index: 2,
    label: "generated-image",
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 128,
    source: "base64",
    filePath: "/app/data/jobs/poster.png",
    fileName: "poster.png",
    externalUrl: null,
    note: null,
    downloadable: true,
    downloadUrl: "/jobs/JOB-1/artifacts/ART-1/files/2"
  });

  assert.deepEqual(request, {
    url: "http://127.0.0.1:3000/jobs/JOB-1/artifacts/ART-1/files/2",
    authorization: "Bearer runtime-file-token"
  });
});

test("desktop delivery completion reports the atomic file receipt with authentication", async () => {
  const storage = new MemoryStorage();
  installWindow(storage);
  __apiAuthTokenTestInternals.setRuntimeTokenLoaderForTests(async () => "runtime-delivery-token");
  let seenUrl = "";
  let seenAuthorization = "";
  let seenBody: unknown = null;
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      ok: true,
      delivery: {},
      finalization: { status: "started", workflowId: "delivery-workflow" }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  await completeArtifactDelivery({
    jobId: "JOB-1",
    deliveryId: "DELIVERY-1",
    claimToken: "a3d790d7-8338-47c1-a5e1-f99f007fcd3e",
    deliveredPath: "C:\\Users\\Administrator\\Desktop\\poster.png",
    deliveredSizeBytes: 128,
    deliveredChecksumSha256: "a".repeat(64)
  });

  assert.equal(seenUrl, "http://127.0.0.1:3000/jobs/JOB-1/deliveries/DELIVERY-1/complete");
  assert.equal(seenAuthorization, "Bearer runtime-delivery-token");
  assert.deepEqual(seenBody, {
    claimToken: "a3d790d7-8338-47c1-a5e1-f99f007fcd3e",
    deliveredPath: "C:\\Users\\Administrator\\Desktop\\poster.png",
    deliveredSizeBytes: 128,
    deliveredChecksumSha256: "a".repeat(64)
  });
});
