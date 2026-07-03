# Honeycomb Product Backend Gap Review - 2026-07-02

This review uses the current product standard: Honeycomb must feel reliable as
a multi-agent product, not just as a local developer demo.

## Product Conclusion

The Windows-local backend is now usable enough for owner trials, but iOS changes
the product standard. A phone cannot run the local Docker/Postgres/worker stack,
so the backend must become a secure remote host that a mobile client can trust.

The most important next backend work is:

1. Mobile-safe authentication and device pairing.
2. Reliable job execution: queue, cancellation, retry, and provider failure
   handling.
3. Durable artifact delivery: generated files must be recoverable, previewable,
   and downloadable on every client.

Update after first implementation slice:
- Mobile device token storage, verification, and revocation now exist.
- Pairing-code UX, per-device scopes, HTTPS production ingress, and short-lived
  SSE tickets are still pending.

## Deepening Opportunities

### 1. Mobile Device Access Module

Files/modules involved:
- `apps/orchestrator-api/src/api-auth.ts`
- `apps/orchestrator-api/src/server.ts`
- `apps/desktop-app/src/api.ts`
- future iOS client under `D:\honeycomb-ios`

Problem:
- The current bearer token is a local desktop token. It works for Windows on
  one machine, but it is too blunt for iOS.
- iOS needs device pairing, device revocation, HTTPS-only production mode, and
  short-lived stream access.

Solution:
- Add a deep Module for device access:
  - pair a phone with a backend host,
  - issue per-device tokens,
  - revoke a device,
  - mint short-lived SSE/timeline tickets.

Benefits:
- Locality: token and stream rules stop leaking across every route.
- Leverage: Windows, iOS, PWA, and future IM clients use the same Interface.
- Tests improve because auth behaviour can be tested at one seam instead of
  repeating route-level token cases.

### 2. Job Execution Control Module

Files/modules involved:
- `apps/dbos-worker/src/activities.ts`
- `apps/dbos-worker/src/worker.ts`
- `packages/db/src/jobs.ts`
- `packages/db/src/model-calls.ts`

Problem:
- Jobs can run real provider calls, but cancellation and concurrency are still
  not product-grade.
- A failed or slow provider call can waste user budget or block the queue.

Solution:
- Add one deep Module for execution control:
  - job concurrency limits,
  - per-agent/provider budgets,
  - abort propagation for provider calls,
  - retry/backoff policy,
  - stalled job repair.

Benefits:
- Locality: wallet-risk logic lives in one place.
- Leverage: every routing mode benefits without duplicating checks.
- Tests improve because queue/cancel/stall behaviour can be tested through a
  single Interface.

### 3. Artifact Delivery Module

Files/modules involved:
- `apps/orchestrator-api/src/artifact-files.ts`
- `apps/orchestrator-api/src/server.ts`
- `apps/dbos-worker/src/activities.ts`
- desktop and iOS artifact clients

Problem:
- Recent work fixed URL-only media discovery, but artifact delivery is still
  split between local files, external URLs, and task JSON records.
- iOS needs previews and download links that remain valid after provider URLs
  expire.

Solution:
- Add one deep Module for generated artifacts:
  - normalize local file, external URL, and provider task output into one
    artifact record,
  - persist remote media into durable storage when possible,
  - expose thumbnails/previews,
  - proxy or re-sign downloads safely.

Benefits:
- Locality: media handling stops being scattered across worker, API, and UI.
- Leverage: desktop, iOS, memory, and review pages all get the same artifact
  contract.
- Tests improve because URL expiry, missing files, and download fallback can be
  verified through one Interface.

### 4. Planner/Agent Orchestration Contract Module

Files/modules involved:
- `apps/dbos-worker/src/activities.ts`
- `packages/shared/src/job-title.ts`
- `platform-assets/openclaw-agent-templates/`
- prompt files written into the OpenClaw runtime

Problem:
- The current flexible agent selection is improving, but it still has some
  regex-based stage inference. That is fragile for a product where the panel
  agent should choose the right specialists from task intent.

Solution:
- Make the panel agent produce an explicit orchestration contract:
  - task title,
  - requested output types,
  - selected agents,
  - skipped agents with reasons,
  - artifact expectations.

Benefits:
- Locality: routing mistakes can be fixed in the planner contract instead of
  in scattered UI and worker heuristics.
- Leverage: Tasks page, mobile UI, logs, and memory can explain the same plan.
- Tests improve because task routing can assert a structured plan.

### 5. Remote Operations Module

Files/modules involved:
- `apps/orchestrator-api/src/runtime-diagnostics.ts`
- `apps/orchestrator-api/src/runtime-repair.ts`
- `scripts/`
- `docker-compose.yml`

Problem:
- Diagnostics are strong for Windows-local use, but remote/iOS needs a server
  operations story: health, upgrades, logs, repair, and backup.

Solution:
- Add a deployable remote operations Module:
  - HTTPS/public ingress checks,
  - database backup/restore,
  - worker liveness,
  - log bundle export,
  - safe repair actions suitable for server mode.

Benefits:
- Locality: operations knowledge is concentrated instead of spread across
  scripts and docs.
- Leverage: Windows owner trials, server mode, and iOS all use the same health
  story.

## Recommended Execution Order

1. Device access and pairing.
2. Artifact delivery.
3. Job execution control.
4. Planner orchestration contract.
5. Remote operations.

This order lets iOS become useful without pretending the phone can run the
agent backend locally.
