# Honeycomb Product Backend Gap Review - 2026-07-02

This review uses the current product standard: Honeycomb must feel reliable as
a multi-agent product, not just as a local developer demo.

## Product Conclusion

The Windows-local backend is now usable enough for owner trials, but macOS raises
the product standard. The Apple target is a real desktop product, not a phone
companion, so the backend must remove Windows-only assumptions while keeping the
same local task-execution model.

The most important next backend work is:

1. Cross-platform local execution and macOS readiness checks.
2. Reliable job execution: queue, cancellation, retry, and provider failure
   handling.
3. Durable artifact delivery: generated files must be recoverable, previewable,
   and downloadable on every client.

## Deepening Opportunities

### 1. macOS Desktop Runtime Module

Files/modules involved:
- `apps/dbos-worker/src/adapters/openclaw.ts`
- `packages/runtime/src/local-secrets.ts`
- `apps/desktop-app/src-tauri/src/main.rs`
- `scripts/`
- macOS planning folder under `D:\honeycomb-macos`

Problem:
- OpenClaw execution is Windows/WSL oriented.
- Secret storage currently depends on Windows DPAPI.
- Launcher, smoke, and repair scripts are mostly PowerShell.
- A macOS user should not need WSL or Windows-specific setup.

Solution:
- Add a deep module for platform runtime:
  - choose the correct OpenClaw execution command per OS,
  - route secrets through a SecretBackend interface,
  - provide bash/zsh launchers and diagnostics,
  - expose macOS readiness status to the desktop UI.

Benefits:
- Locality: platform-specific behavior stops leaking through workers and
  scripts.
- Leverage: Windows, macOS, Linux desktop, and server mode share one interface.
- Tests improve because platform decisions can be asserted without running a
  full desktop app.

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
- desktop and web artifact clients

Problem:
- Recent work fixed URL-only media discovery, but artifact delivery is still
  split between local files, external URLs, and task JSON records.
- macOS and web clients need previews and download links that remain valid after
  provider URLs expire.

Solution:
- Add one deep Module for generated artifacts:
  - normalize local file, external URL, and provider task output into one
    artifact record,
  - persist remote media into durable storage when possible,
  - expose thumbnails/previews,
  - proxy or re-sign downloads safely.

Benefits:
- Locality: media handling stops being scattered across worker, API, and UI.
- Leverage: desktop, web, memory, and review pages all get the same artifact
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
- Leverage: Tasks page, desktop UI, logs, and memory can explain the same plan.
- Tests improve because task routing can assert a structured plan.

### 5. Remote Operations Module

Files/modules involved:
- `apps/orchestrator-api/src/runtime-diagnostics.ts`
- `apps/orchestrator-api/src/runtime-repair.ts`
- `scripts/`
- `docker-compose.yml`

Problem:
- Diagnostics are strong for Windows-local use, but macOS and server mode need a
  clearer operations story: health, upgrades, logs, repair, and backup.

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
- Leverage: Windows owner trials, macOS desktop, and server mode all use the same health
  story.

## Recommended Execution Order

1. macOS desktop runtime.
2. Artifact delivery.
3. Job execution control.
4. Planner orchestration contract.
5. Remote operations.

This order lets Apple computers become first-class desktop hosts instead of
treating them like mobile remote clients.
