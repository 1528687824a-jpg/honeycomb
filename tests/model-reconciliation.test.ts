import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  classifyProviderReconciliationPayload,
  queryProviderUnknownOutcome,
  readProviderPayloadPath,
  recoverProviderMediaArtifacts,
  resolveProviderReconciliationUrl
} from "../apps/orchestrator-api/src/model-call-reconciliation";
import {
  parseModelCallReconciliationState,
  parseModelCallRequestReference,
  parseProviderUnknownOutcomePolicy,
  providerUnknownOutcomePolicySchema,
  type ModelCallRequestReference,
  type ProviderUnknownOutcomePolicy
} from "../packages/shared/src/model-reconciliation";

const reference: ModelCallRequestReference = {
  version: "honeycomb.model-request-reference.v1",
  requestId: "local-request-1",
  providerRequestId: "provider/request-42",
  providerTaskId: null,
  providerId: "provider-1",
  model: "model-1",
  kind: "chat",
  runner: "provider-direct",
  routeIndex: 0,
  routeAttemptNo: 1,
  preparedAt: "2026-07-14T12:00:00.000Z"
};

const policy: ProviderUnknownOutcomePolicy = {
  version: "honeycomb.provider-reconciliation.v1",
  pathTemplate: "/v1/jobs/{requestId}",
  requestIdSource: "providerRequestId",
  statusPath: "data.state",
  resultTextPath: "data.result.text",
  pendingValues: ["pending", "running"],
  notAcceptedValues: ["not_found"],
  failedValues: ["failed"],
  succeededValues: ["completed"],
  timeoutSeconds: 2
};

test("model reconciliation contracts reject malformed and ambiguous configuration", () => {
  assert.deepEqual(parseModelCallRequestReference(reference), reference);
  const legacyReference = { ...reference } as Partial<ModelCallRequestReference>;
  delete legacyReference.providerTaskId;
  assert.deepEqual(parseModelCallRequestReference(legacyReference), reference);
  assert.equal(parseModelCallRequestReference({ ...reference, requestId: "" }), null);

  const state = {
    version: "honeycomb.model-reconciliation.v1" as const,
    status: "provider_pending" as const,
    source: "provider_query" as const,
    providerStatus: "running",
    providerHttpStatus: 200,
    reason: null,
    canResume: false,
    checkedAt: "2026-07-14T12:01:00.000Z",
    resolvedAt: null
  };
  assert.deepEqual(parseModelCallReconciliationState(state), state);

  const parsed = parseProviderUnknownOutcomePolicy({
    unknownOutcomeReconciliation: {
      pathTemplate: "/v1/jobs/{requestId}",
      requestIdSource: "requestId"
    }
  });
  assert.equal(parsed?.requestIdSource, "requestId");
  assert.deepEqual(parsed?.succeededValues, ["succeeded", "completed", "done"]);
  assert.equal(providerUnknownOutcomePolicySchema.safeParse({
    pathTemplate: "https://evil.example/jobs/{requestId}"
  }).success, false);
  assert.equal(providerUnknownOutcomePolicySchema.safeParse({
    pathTemplate: "//evil.example/jobs/{requestId}"
  }).success, false);
  assert.equal(providerUnknownOutcomePolicySchema.safeParse({
    pathTemplate: "/jobs/{requestId}",
    pendingValues: ["queued"],
    succeededValues: ["QUEUED"]
  }).success, false);
});

test("provider payload paths support nested objects and arrays", () => {
  const payload = { data: { outputs: [{ state: "completed", text: "ready" }] } };
  assert.equal(readProviderPayloadPath(payload, "$.data.outputs[0].state"), "completed");
  assert.equal(readProviderPayloadPath(payload, "data.outputs.0.text"), "ready");
  assert.equal(readProviderPayloadPath(payload, "data.outputs[1].text"), undefined);
  assert.equal(readProviderPayloadPath(payload, "data.__proto__.value"), undefined);
});

test("provider reconciliation classifies pending, failed, succeeded, and unknown states", () => {
  assert.equal(classifyProviderReconciliationPayload({
    data: { state: "RUNNING" }
  }, policy).status, "provider_pending");
  assert.equal(classifyProviderReconciliationPayload({
    data: { state: "not-found" }
  }, policy).status, "confirmed_not_accepted");
  assert.equal(classifyProviderReconciliationPayload({
    data: { state: "failed" }
  }, policy).status, "confirmed_failed");
  const completed = classifyProviderReconciliationPayload({
    data: { state: "completed", result: { text: "recovered output" } }
  }, policy, 200);
  assert.equal(completed.status, "confirmed_succeeded");
  assert.equal(completed.resultText, "recovered output");
  assert.equal(classifyProviderReconciliationPayload({
    data: { state: "mystery" }
  }, policy).status, "manual_review");
});

test("media reconciliation requires a downloadable provider artifact", () => {
  assert.deepEqual(recoverProviderMediaArtifacts({
    kind: "image",
    payload: {
      data: [
        { url: "https://cdn.example/poster.png", revised_prompt: "tea poster" },
        { url: "https://cdn.example/poster.png" },
        { b64_json: "base64-without-a-file" }
      ]
    },
    resultText: "completed"
  }), [{
    kind: "image",
    url: "https://cdn.example/poster.png",
    filePath: null,
    mimeType: null,
    note: "tea poster",
    source: "url",
    sizeBytes: null,
    downloadError: null
  }]);
  assert.equal(recoverProviderMediaArtifacts({
    kind: "video",
    resultText: "https://cdn.example/video.mp4"
  }).length, 1);
  assert.equal(recoverProviderMediaArtifacts({
    kind: "image",
    resultText: "provider says succeeded"
  }).length, 0);
  assert.equal(recoverProviderMediaArtifacts({
    kind: "image",
    resultText: "file:///C:/unsafe.png"
  }).length, 0);
});

test("provider reconciliation URL remains on the configured provider origin", () => {
  assert.equal(
    resolveProviderReconciliationUrl(
      "https://provider.example/v1",
      "/jobs/{requestId}",
      "request/42"
    ).toString(),
    "https://provider.example/jobs/request%2F42"
  );
  assert.throws(
    () => resolveProviderReconciliationUrl(
      "https://provider.example",
      "//evil.example/{requestId}",
      "request-1"
    ),
    { message: "provider_reconciliation_origin_mismatch" }
  );
  assert.throws(
    () => resolveProviderReconciliationUrl("file:///tmp", "/jobs/{requestId}", "request-1"),
    { message: "provider_reconciliation_protocol_not_allowed" }
  );
});

test("provider reconciliation performs an authenticated read-only status query", async (t) => {
  let receivedMethod: string | undefined;
  let receivedAuthorization: string | undefined;
  let receivedIdempotencyKey: string | undefined;
  let receivedUrl: string | undefined;
  const server = http.createServer((request, response) => {
    receivedMethod = request.method;
    receivedAuthorization = request.headers.authorization;
    receivedIdempotencyKey = request.headers["idempotency-key"] as string | undefined;
    receivedUrl = request.url;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: { state: "completed", result: { text: "provider output" } }
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await queryProviderUnknownOutcome({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "secret-key",
    reference,
    policy
  });
  assert.equal(result.status, "confirmed_succeeded");
  assert.equal(result.resultText, "provider output");
  assert.equal(receivedMethod, "GET");
  assert.equal(receivedAuthorization, "Bearer secret-key");
  assert.equal(receivedIdempotencyKey, "local-request-1");
  assert.equal(receivedUrl, "/v1/jobs/provider%2Frequest-42");
});

test("provider reconciliation does not guess after missing IDs or unclassified HTTP errors", async () => {
  const missingId = await queryProviderUnknownOutcome({
    baseUrl: "https://provider.example",
    apiKey: null,
    reference: { ...reference, providerRequestId: null },
    policy,
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });
  assert.equal(missingId.status, "query_failed");
  assert.equal(missingId.reason, "provider_reconciliation_request_id_missing");

  const httpError = await queryProviderUnknownOutcome({
    baseUrl: "https://provider.example",
    apiKey: null,
    reference,
    policy,
    fetchImpl: async () => new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" }
    })
  });
  assert.equal(httpError.status, "query_failed");
  assert.equal(httpError.providerHttpStatus, 503);
  assert.equal(httpError.reason, "provider_reconciliation_http_503");

  const misleadingUnauthorized = await queryProviderUnknownOutcome({
    baseUrl: "https://provider.example",
    apiKey: null,
    reference,
    policy,
    fetchImpl: async () => new Response(JSON.stringify({
      data: { state: "failed" }
    }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })
  });
  assert.equal(misleadingUnauthorized.status, "query_failed");
  assert.equal(misleadingUnauthorized.reason, "provider_reconciliation_http_401");

  const confirmedMissing = await queryProviderUnknownOutcome({
    baseUrl: "https://provider.example",
    apiKey: null,
    reference,
    policy,
    fetchImpl: async () => new Response(JSON.stringify({
      data: { state: "not_found" }
    }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })
  });
  assert.equal(confirmedMissing.status, "confirmed_not_accepted");
});
