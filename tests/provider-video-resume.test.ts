import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelCallRequestReference } from "../packages/shared/src/model-reconciliation";
import { resolveProviderVideoResumeReference } from "../packages/shared/src/provider-video-resume";

const reference: ModelCallRequestReference = {
  version: "honeycomb.model-request-reference.v1",
  requestId: "local-route-request",
  providerRequestId: "http-request-id",
  providerTaskId: "video-task-id",
  providerId: "video-provider",
  model: "video-model",
  kind: "video",
  runner: "provider-direct",
  routeIndex: 1,
  routeAttemptNo: 2,
  preparedAt: "2026-07-14T12:00:00.000Z"
};

const routes = [
  { providerId: "fallback-provider", model: "fallback-model" },
  { providerId: "video-provider", model: "video-model" }
];

test("video recovery accepts only the persisted provider, model, route, and task", () => {
  assert.equal(resolveProviderVideoResumeReference({
    modelCallStatus: "started",
    currentRunner: "provider-direct",
    reference,
    routes
  }), reference);

  assert.equal(resolveProviderVideoResumeReference({
    modelCallStatus: "started",
    currentRunner: "provider-direct",
    reference,
    routes: [...routes].reverse()
  }), null);
  assert.equal(resolveProviderVideoResumeReference({
    modelCallStatus: "started",
    currentRunner: "native",
    reference,
    routes
  }), null);
  assert.equal(resolveProviderVideoResumeReference({
    modelCallStatus: "failed",
    currentRunner: "provider-direct",
    reference,
    routes
  }), null);
  assert.equal(resolveProviderVideoResumeReference({
    modelCallStatus: "started",
    currentRunner: "provider-direct",
    reference: { ...reference, providerTaskId: null },
    routes
  }), null);
});
