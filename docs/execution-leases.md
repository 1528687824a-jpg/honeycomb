# Durable execution ownership

Honeycomb uses two database-backed ownership layers before a provider request can run.

## Job workflow claim

- `agent.jobs.workflow_id` is the current execution owner.
- A created or unclaimed queued job can be claimed once.
- Re-entering with the same workflow ID is idempotent.
- A different workflow ID is rejected while the current job heartbeat is healthy.
- A waiting job may start a new workflow generation.
- A stalled job reuses its existing DBOS workflow ID and calls `DBOS.resumeWorkflow`, so recovery continues from durable checkpoints instead of starting a duplicate workflow.
- Every model-calling DBOS step carries the workflow ID and checks it before changing stage state or dispatching a provider request.

The resume endpoint assigns `workflow_id`, changes the job to `queued`, and restores a healthy heartbeat in the same SQL update. Two concurrent resume requests therefore cannot both claim the job.

## Model-call lease

Each `agent.model_calls` row stores `claim_token` and `lease_expires_at`.

- A PostgreSQL transaction advisory lock serializes acquisition for one idempotency key.
- Only the lease owner may persist request references, provider task progress, retries, failures, or success.
- An administrator may force only the explicit unknown-outcome transition; that operation clears the lease and requires reconciliation before any retry.
- Completion clears the lease. Retry waiting also clears it before a later attempt acquires a fresh token.
- An active lease produces `model_call_in_progress`; it never starts a second provider request.
- An expired ordinary request becomes an unknown outcome and requires reconciliation before retry.
- An expired asynchronous video request may transfer ownership only when a persisted provider task ID makes it safe to continue polling without another create request.
- Video progress and request-reference updates renew the lease. Other calls receive a lease at least two minutes longer than their configured timeout.

`MODEL_CALL_LEASE_SECONDS` defaults to `900`. Runtime calls use the greater safety window implied by their configured timeout.

## Expired lease recovery

Honeycomb exposes expired calls without returning claim tokens or provider secrets:

- `GET /runtime/model-call-leases` returns global counts and recent affected calls.
- `GET /jobs/:jobId/model-call-leases` returns the same view for one task.
- `POST /runtime/model-call-leases/scan` classifies a bounded batch.
- `POST /jobs/:jobId/model-call-leases/scan` limits recovery to one task.
- The `modelCalls.scanExpiredLeases` runtime repair action runs the same safe scan from the diagnostics workbench.

The scanner uses the same database lock order as execution and cancellation. Concurrent scanners skip a model-call ownership lock that is already held and recheck the lease before changing state.

- A persisted provider-direct video task stays `started`, loses its stale owner token, marks the task stalled, and becomes available for polling takeover with the existing provider task ID.
- Every other expired started call becomes `failed_unknown_outcome`; its task pauses in `waiting_for_human` until an operator records the real provider outcome.
- Any reserved spend becomes unknown-outcome spend instead of being silently released or charged twice.
- Re-running the scanner is idempotent and never repeats the original provider create request.

## Verification

Pure policy coverage is in `tests/execution-lease-policy.test.ts`. Routing ownership propagation is covered by `tests/routing-execution.test.ts`.

With PostgreSQL running, execute:

```powershell
npm run smoke:execution-leases
```

The smoke test races two workflow claims, two resume requests, and two model-call owners. It also verifies provider-task lease takeover, stale-owner fencing, ordinary unknown-outcome classification, and resumable video-task classification.
