# Model Call Unknown-Outcome Reconciliation

This document defines how the Windows backend handles a model request that may
have reached a provider but did not produce a reliable response in Honeycomb.

## Product Rule

An unknown outcome is never replayed automatically. Honeycomb pauses the job,
persists the request reference, and requires one of these safe conclusions:

1. The provider is still processing: keep the job paused.
2. The provider did not accept the request or reports failure: mark the model
   call failed and allow the existing Resume action to retry it.
3. The provider reports success and returns a recoverable result: persist that
   result as the original model-call result, then allow Resume to reuse it.
4. No reliable conclusion is available: keep the job paused for manual review.

The API resume route and the worker both reject unresolved
`failed_unknown_outcome` calls. This prevents another entry point from bypassing
the task-page guard.

## Durable Records

Before provider dispatch, `agent.model_calls.request_reference` stores:

- a stable local route request ID, also sent as `idempotency-key`;
- provider, model, request kind, runner, route, and attempt;
- the provider request ID when it appears in response headers;
- a separate provider task ID for asynchronous video generation;
- the preparation time.

`agent.model_calls.reconciliation` stores the latest provider/manual check,
HTTP/provider status, reason, timestamps, and whether resuming is safe. Checks
and resolutions also produce task timeline events.

An asynchronous video call with a persisted task ID is not treated as an
unknown outcome. Worker recovery resumes the provider's read-only status API
automatically. It enters manual unknown-outcome handling only if task creation
may have been accepted but no reliable task ID was persisted.

## Provider Configuration

Automatic lookup is opt-in because providers use different status endpoints.
Configure `provider.metadata.unknownOutcomeReconciliation` through the existing
provider API:

```json
{
  "version": "honeycomb.provider-reconciliation.v1",
  "pathTemplate": "/v1/tasks/{requestId}",
  "requestIdSource": "providerRequestId",
  "statusPath": "data.status",
  "resultTextPath": "data.output.url",
  "pendingValues": ["queued", "running"],
  "notAcceptedValues": ["not_found"],
  "failedValues": ["failed", "cancelled"],
  "succeededValues": ["completed"],
  "timeoutSeconds": 10
}
```

The lookup is always a same-origin `GET`; absolute/cross-origin templates,
redirects, oversized responses, and non-HTTP(S) URLs are rejected. The provider
API key is read from local encrypted secret storage and is never persisted in
the model call, timeline, or response DTO.

For image/video calls, a provider success is not enough. Honeycomb must also
recover an HTTP(S) media URL from the provider payload or `resultTextPath`.
Otherwise the call remains paused, avoiding a false task success with no file.

## API And Desktop

- `GET /jobs/:jobId/model-calls/unknown-outcomes` lists unresolved calls.
- `POST /jobs/:jobId/model-calls/:modelCallId/reconcile` accepts
  `query_provider`, `keep_waiting`, `confirm_not_accepted`, `confirm_failed`, or
  `confirm_succeeded`.
- `POST /jobs/:jobId/resume` returns HTTP 409 while unresolved calls exist.

The task page explains the pause, shows the agent/provider/model and latest
check, and offers provider lookup. Manual "not executed" confirmation requires
the user to enter evidence from the provider console because a wrong answer can
cause duplicate work or charges.

## Verification

- `tests/model-reconciliation.test.ts` covers contracts, status mapping,
  same-origin lookup, auth/idempotency headers, media recovery, missing IDs, and
  unclassified HTTP failures.
- `npm run smoke:model-reconciliation` covers database migration, persistence,
  unsafe restart rejection, failed-call unlock, stale-state reset, and recovered
  success reuse when PostgreSQL is running.
