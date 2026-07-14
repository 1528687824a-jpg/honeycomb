import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  __apiAuthTokenTestInternals,
  completeArtifactDelivery,
  listJobs,
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
