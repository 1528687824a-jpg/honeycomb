# Model Call Retry Semantics

This document defines the Windows backend policy for provider failures, retries,
fallback routes, and unknown outcomes.

## Safety Rule

Honeycomb retries only when it can reasonably determine that repeating the
request is safe. It does not infer retryability from every generic error.

| Failure | Same-route retry | Fallback route | Job result |
| --- | --- | --- | --- |
| HTTP 408, 425, 429 | Yes | After attempts are exhausted | Fail if every route fails |
| HTTP 5xx | Yes | After attempts are exhausted | Fail if every route fails |
| Connection refused, DNS temporary failure, connect timeout | Yes | After attempts are exhausted | Fail if every route fails |
| Invalid API key, permission, billing/quota, model/endpoint | No | Yes | Wait for human if no route succeeds |
| Invalid request | No | Yes | Wait for human if no route succeeds |
| Invalid model output | No | Yes | Fail if no route succeeds |
| Timeout or disconnect after dispatch | No | No | Wait for human as unknown outcome |
| Video task queued/running or status read timeout | Query the same task only | No | Keep running and recover by task ID |
| User cancellation | No | No | Cancelled |

The default policy is three attempts per route with exponential backoff,
20 percent jitter, and a 60-second maximum. `Retry-After` is honored up to the
configured maximum. Provider-direct requests also carry a stable route-scoped
`idempotency-key` header so providers that support it can deduplicate retries.

## Durable Waiting

Before Honeycomb sleeps between attempts, it persists both:

- `model_calls.status=retry_waiting`, including the route history and next
  attempt checkpoint;
- `jobs.execution_retry`, which is the public task-page state.

The provider concurrency lease is released before the delay. A restarted DBOS
step reads the checkpoint, waits only for the remaining delay, and resumes from
the saved route and attempt number. It does not restart the retry count.

The task timeline records:

- `tool.openclaw_agent_route_failed` with the sanitized classification;
- `model_call.retry_scheduled` with the delay and next attempt;
- `model_call.retry_started` for a normal continuation;
- `model_call.retry_recovered` after worker recovery.

Task details expose the agent, provider, failure category, next attempt, delay,
and retry time. Runtime usage exposes current retry-waiting jobs/model calls and
the number of retries scheduled.

## DBOS Boundary

Provider failures are wrapped as classified model-call errors after Honeycomb's
own route policy finishes. DBOS must not repeat the whole model-calling step for
those errors. Infrastructure failures that happen before a classified provider
result remain eligible for DBOS step retry.

Provider-direct video is a special long-running continuation, not a repeated
model request. Once task creation returns a provider task ID, Honeycomb stores
that ID separately from response-header request IDs. Poll-window expiry raises
a DBOS-retryable continuation while the model call remains `started`; the next
step attempt validates the recorded provider/model/route/attempt and calls only
`GET /contents/generations/tasks/{id}`. It never sends another create request.
The spend reservation is reused and the provider concurrency lease is released
between DBOS attempts.

## Unknown Outcomes

A request that may have reached the provider is never retried or failed over
automatically when Honeycomb cannot prove the outcome. The model call becomes
`failed_unknown_outcome` and the job becomes `waiting_for_human`.

Honeycomb now persists a local request reference before dispatch and captures a
provider request ID from response headers or video task responses when one is
available. Provider-specific, same-origin status lookup can confirm pending,
not-accepted, failed, or succeeded outcomes. Provider lookup never sends a
second model request.

The normal resume route and the worker both reject unresolved unknown outcomes.
Confirmed failed/not-accepted calls become safely retryable. Confirmed successful
calls persist a reusable result; image/video success additionally requires a
recoverable HTTP(S) artifact URL. Inconclusive or unsupported lookups stay
paused. See
[`model-call-unknown-outcome-reconciliation.md`](model-call-unknown-outcome-reconciliation.md).

## Configuration

```text
HONEYCOMB_MODEL_RETRY_MAX_ATTEMPTS=3
HONEYCOMB_MODEL_RETRY_BASE_DELAY_MS=1000
HONEYCOMB_MODEL_RETRY_MAX_DELAY_MS=60000
HONEYCOMB_MODEL_RETRY_JITTER_RATIO=0.2
OPENCLAW_VIDEO_POLL_INTERVAL_MS=10000
OPENCLAW_VIDEO_POLL_WINDOW_MS=
OPENCLAW_VIDEO_STATUS_REQUEST_TIMEOUT_MS=30000
```

The product bounds attempts to 1-5, delay to 100-300000 ms, and jitter to
0-0.5. Secrets are never included in retry state or timeline payloads.
