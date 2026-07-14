# Honeycomb Backend Roadmap

This document tracks what the Honeycomb backend can do now, what is only partial,
and what still needs to be implemented. Keep it updated when backend capability
changes land.

## Current Priority Decision (2026-07-13)

Windows backend productization is the only active platform priority. macOS work
is paused after the native runner and Keychain foundation; those changes stay in
the codebase but receive no new implementation until the Windows release-candidate
gates pass.

The canonical execution order and acceptance criteria now live in
[`windows-backend-product-plan.md`](windows-backend-product-plan.md). When older
sections in this roadmap conflict with that document, the Windows plan wins.

Current order:

1. Persistent conversations and a structured panel-agent orchestration contract.
2. Queue, concurrency, cancellation propagation, retry/backoff, and spend control.
3. Durable artifact persistence, asynchronous media completion, and destination delivery.
4. Real behavioral validation for all four routing modes.
5. A Windows runtime and installer path that does not require ordinary users to operate Docker Desktop.
6. Release hardening; only then resume macOS.

### Windows Stage 1 Progress (2026-07-14)

The structured conversation-to-task contract is implemented:

- Projects, conversations, drafts, attachments, and messages have PostgreSQL
  records plus snapshot/CRUD APIs and desktop synchronization.
- Jobs persist a user-facing title, the validated orchestration plan, its
  source, the originating conversation, and the originating user message.
- The panel agent returns a validated JSON plan and may select only enabled
  registered child agents. Every accepted task plan uses `test-agent` as its
  quality gate.
- The desktop no longer performs a second task/routing decision. The worker
  executes the persisted plan and uses keyword inference only for legacy jobs.
- Source-message locking and a unique index make repeated task submission
  idempotent.
- `npm run check`, the desktop production build, and all 90 unit tests pass.
- Runtime database acceptance is pending because PostgreSQL and Docker Desktop
  were intentionally left stopped. `npm run smoke:conversation-persistence`
  now covers migration-backed snapshot persistence, job/message links, and
  duplicate-dispatch protection when the development backend is running.

### Windows Stage 2 Progress (2026-07-14)

The execution-control and spend-protection stage is implemented:

- Every new or resumed job runs a shared execution preflight before DBOS starts.
- Preflight checks every production agent, the test agent, and the discussion
  synthesis agent when required.
- It verifies the live local secret, provider/model/base URL, cached connection
  status, enabled state, and chat/image/video capability.
- All configured fallback routes are evaluated; a viable fallback can be
  selected without hiding the failed primary route.
- Results are stored on the job and recorded in its timeline. Blocking
  configuration errors move the job to `waiting_for_human` before model calls.
- HTTP, Feishu, schedules, session forks, resume, scheduler startup, and the
  worker's last pre-call check use the same contract.
- The desktop explains the blocking agent/configuration and now exposes a
  resume action. Mock runs are visibly labeled as simulations that do not
  produce real files.
- Opaque media endpoint names use the verified API kind instead of unreliable
  model-name guessing.
- API startup ensures the built-in agent catalog exists in a fresh database.
- Real model calls now acquire PostgreSQL-backed global, provider, and agent
  concurrency leases before the request is marked started or sent.
- Queue acquisition is serialized with a transaction advisory lock. Default
  limits are global 4, provider 2, and agent 1, with environment and registry
  metadata overrides.
- Queued and acquired records both have renewable expirations. A worker crash
  therefore releases capacity and queue fairness automatically instead of
  leaving a permanent blocker.
- Route completion, failure, and provider failover release only leases owned by
  that caller. Lost ownership cannot clear another caller's live queue state.
- Jobs persist their latest queue state; the desktop task list/details show
  queue status, provider/agent, position, limits, and active usage.
- `GET /runtime/model-call-queue` exposes the active global queue, and
  `npm run smoke:model-call-queue` covers migration-backed acquisition,
  blocking, independent-provider parallelism, release, and promotion.
- A persisted cancellation watcher now aborts active provider HTTP requests,
  generated-media downloads, file writes, and native OpenClaw processes. WSL
  runs receive an additional session-targeted Linux process termination.
- Cancellation is a distinct model-call state. It never triggers provider
  failover, is visible in runtime usage, and emits a dedicated task timeline
  event instead of being reported as a provider failure.
- The cancel API also requests native DBOS workflow cancellation. Honeycomb's
  persisted job status remains authoritative if that secondary request fails,
  and the failure is recorded for diagnosis instead of undoing user intent.
- Database guards reject model-call starts after a job is cancelled and resolve
  stale cancel-versus-success reads with row locks. The cancel API also marks
  every already-started call immediately, so a worker crash cannot leave a
  false active call behind.
- `npm run smoke:cancel-job` now verifies active-call cancellation, rejection
  of new calls after cancellation, runtime cancellation counts, and timeline
  metadata.
- Provider failures now use a shared classification contract. Authentication,
  authorization, quota/billing, model, endpoint, and invalid-request failures
  do not repeat on the same route; viable fallback routes remain available.
- HTTP 408/425/429, explicit 5xx responses, DNS/connect failures, and connection
  refusal use bounded exponential backoff with jitter. Provider `Retry-After`
  is preserved and honored.
- Requests whose outcome may be unknown after dispatch are never automatically
  retried or failed over. Their model call becomes `failed_unknown_outcome` and
  the task pauses in `waiting_for_human` instead of risking duplicate spend.
- Retry waits use a durable `retry_waiting` model-call state. A worker restart
  resumes from the persisted route and attempt checkpoint, while cancellation
  stops both active and retry-waiting calls.
- Retry state, classification, attempts, delay, and next retry time are visible
  in task details and timeline events. Runtime usage reports retry-waiting jobs,
  retry-waiting calls, and scheduled retry count.
- Classified model failures do not trigger a second DBOS whole-step retry, and
  workflow failure handling cannot overwrite a task already paused for human
  action.
- `npm run smoke:model-retry` covers the migration-backed retry state machine
  and runtime counters when PostgreSQL is running.
- Model calls now persist a route-scoped local request reference before provider
  dispatch and capture provider request IDs from response headers/video tasks.
- Provider-specific, same-origin status lookup reconciles pending,
  not-accepted, failed, and succeeded outcomes without replaying the request.
- The resume API, legacy admin repair route, database transition, and worker all
  prevent unresolved unknown outcomes from being restarted.
- Reconciliation state and audit events are durable. The task page shows the
  affected agent/provider/model, supports provider lookup, and permits explicit
  manual confirmation only after warning about duplicate spend.
- Recovered image/video success requires a usable HTTP(S) media URL; a text-only
  success cannot falsely complete a media task.
- `npm run smoke:model-reconciliation` covers migration-backed request
  references, restart guards, state reset, safe retry unlock, and result reuse.
- Real provider calls now reserve USD atomically before dispatch against task
  lifetime, requester daily, and provider daily limits. Concurrent workers use
  one PostgreSQL advisory transaction lock, so they cannot both spend the same
  remaining allowance.
- `agent.model_call_spend` keeps one idempotent entry per route attempt. Known
  non-charge failures release it, unknown outcomes retain it, successful calls
  settle from provider token usage or a conservative request bound, and
  reconciliation releases or settles the same entry without replaying work.
- Panel-agent chat/planning calls use the same ledger for requester/provider
  daily limits, keyed by the persisted source message. A task lifetime cap is
  applied only after a task exists.
- Spend limits are opt-in. Task limits come from `maxCostUsd` or
  `HONEYCOMB_DEFAULT_JOB_MAX_COST_USD`; user/provider daily defaults come from
  `HONEYCOMB_USER_DAILY_MAX_COST_USD` and
  `HONEYCOMB_PROVIDER_DAILY_MAX_COST_USD`. Provider metadata
  `spendLimits.dailyUsd` can override the provider daily default.
- Provider metadata pricing supports token rates plus `maxPerRequestUsd` or
  `perRequestUsd`, including model-specific overrides. When any hard limit is
  enabled but a safe charge bound is unavailable, the task pauses before the
  request is sent instead of spending an unknown amount.
- Jobs persist settled, reserved, committed, and remaining USD plus the exact
  blocking scope. The task page renders this state and requires a higher task
  cap before resuming a task-level exhaustion.
- `GET /jobs/:jobId/spend` exposes the audit ledger, while
  `GET /runtime/usage` now includes authoritative spend-ledger totals alongside
  historical token-based estimates.
- `npm run smoke:model-call-spend` covers idempotent reservation, unknown
  outcome retention, release, settlement, concurrent task limits, and daily
  user/provider limits when PostgreSQL is running.
- `npm run check`, the desktop production build, and all 133 unit tests pass.

Provider hard-limit metadata example:

```json
{
  "pricing": {
    "inputPerMillionUsd": 0.14,
    "outputPerMillionUsd": 0.28,
    "maxInputTokens": 32000,
    "maxOutputTokens": 4096,
    "models": {
      "image-model": { "maxPerRequestUsd": 0.08 }
    }
  },
  "spendLimits": { "dailyUsd": 10 }
}
```

`maxPerRequestUsd` is the preferred conservative reservation for variable media
pricing. `perRequestUsd` may be used only when the provider charge is fixed.
Token-priced native/WSL routes need metadata token ceilings or the matching
`HONEYCOMB_SPEND_RESERVATION_MAX_*_TOKENS` environment settings.

Runtime database acceptance is pending while PostgreSQL and Docker Desktop are
stopped. Stage 2 is complete in code; the next active slice is Stage 3 durable
artifact persistence, asynchronous media completion, and destination delivery.

### Windows Stage 3 Progress (2026-07-14)

The media success gate and durable Windows desktop delivery loop are implemented:

- Finalization now reads every required image/video deliverable from the
  persisted orchestration plan and matches it to a unique generated media file.
- A provider URL, task ID, text receipt, zero-byte file, or path outside the job
  workspace cannot satisfy delivery. Missing files leave the job paused instead
  of recording false success.
- Requested image formats and exact dimensions are checked from the actual local
  file without trusting the filename or provider text.
- Required still images now pass through a deterministic normalization step
  before delivery. JPEG, PNG, WebP, GIF, AVIF, and TIFF inputs are decoded by
  Sharp/libvips; PNG, JPEG, WebP, and static GIF outputs can be produced.
- EXIF orientation is applied before sizing. One requested dimension preserves
  aspect ratio; two dimensions produce an exact attention-cropped canvas. A
  crop exceeding the default 15 percent safety limit pauses instead of silently
  destroying the composition.
- PNG/WebP transparency is retained, while JPEG transparency is explicitly
  flattened to white. Output bytes/pixels/dimensions/time are bounded and the
  derived file is decoded again before it becomes canonical.
- The source SHA-256 and requested specification determine the derived path.
  Worker/DBOS retries reuse a verified result, while a corrupt interrupted
  result is rebuilt. Original provider files are never overwritten.
- Multiple image deliverables use maximum one-to-one matching, so a flexible
  requirement cannot consume the only file that exactly satisfies a stricter
  requirement.
- The desktop exporter now prefers Honeycomb's authenticated local artifact
  download route. Base64-generated or already-downloaded files therefore reach
  the Windows desktop even when no external provider URL exists.
- Duplicate artifact references to the same local media path are exported once.
- The task page explains that a media file, format, or dimensions failed the
  delivery gate.
- Canonical `agent.artifact_files` records now persist source status, local and
  external locations, detected format, dimensions, byte count, SHA-256 checksum,
  source, and download error independently from model prose.
- `agent.artifact_deliveries` persists one required destination operation per
  deliverable. Its pending, leased/delivering, succeeded, failed, and cancelled
  states survive API, desktop, and worker restarts.
- A delivery claim has an expiring token and atomic database transition, so two
  desktop refreshes cannot both own the same write. Failed and expired claims
  can be safely retried.
- The native Tauri downloader streams to a same-directory temporary file,
  enforces the expected byte count, calculates SHA-256, flushes the file, and
  atomically renames it. Partial files are removed on every failure path.
- The desktop reports the destination path, byte count, and checksum through an
  authenticated completion endpoint. The backend rejects mismatched receipts.
- Jobs remain paused until every required destination confirms. The final
  delivery acknowledgement atomically claims one short DBOS finalization run,
  which skips completed model stages and only performs the final success step.
- Late workflow-ID writes can no longer move a running or terminal job back to
  queued. Task details expose each durable delivery and its current status.
- `npm run smoke:artifact-delivery` covers the PostgreSQL claim, mismatch,
  retry, finalization, and terminal-state concurrency invariants when the
  backend database is running.
- Provider-direct video generation now follows the asynchronous provider
  contract: one `POST` creates the task, authenticated `GET` requests poll the
  persisted task ID, and only a terminal `succeeded` payload with a media URL
  proceeds to result download.
- HTTP request IDs and provider video task IDs are persisted separately. A
  restarted DBOS step validates the original provider, model, route, and
  attempt, then resumes that exact task without issuing another `POST` or
  reserving spend twice.
- Queued/running states, status-query retries, download retries, completion,
  and cancellation are persisted in model-call progress and task timeline
  events. Repeated identical polling states do not flood the timeline.
- Status-read failures and polling-window expiry are continuation conditions,
  not provider failover. DBOS releases the concurrency lease and resumes the
  same task in its next infrastructure attempt.
- Job cancellation sends the provider's task `DELETE` request on a best-effort
  basis before completing local cancellation.
- A video model call succeeds only after the provider's MP4 has been downloaded
  into the job workspace. The final media gate reads ISO BMFF/MP4 track metadata
  directly to verify the real container format and display dimensions, including
  rotated tracks.
- Workspace delivery now binds to the job's exact registered and enabled
  workspace root. A model-provided relative path can narrow the destination but
  cannot authorize the root.
- Custom delivery now requires a separately approved, persisted destination
  grant. Grants may expire or be revoked; an unclaimed delivery cannot proceed
  after revocation.
- Every authorized delivery snapshots the authority ID, approved root, relative
  directory, and resolved destination. Retries reuse that destination, while
  completion receipts outside it are rejected.
- Windows network/device paths, traversal, reserved device names, invalid path
  components, and unapproved absolute workspace paths are rejected. The native
  Tauri writer canonicalizes the root and destination again before writing so a
  directory link cannot escape the approved root.
- Destination list/create/revoke APIs and workspace revoke are available. The
  claim response is the only delivery response that includes the approved root
  descriptor used by the local writer.
- `npm run smoke:artifact-destination-authorization` covers registration/grant
  requirements, authorization refresh, receipt boundaries, revocation, and the
  defined behavior for a delivery that already owns a short lease.
- Explicit MD, TXT, JSON, CSV, PDF, DOCX, PPTX, and XLSX requests now create a
  required document-file gate. Ordinary conversation text remains a chat reply
  and does not create a file only for internal bookkeeping.
- Child-agent document files are inspected from their bytes. PDF page structure
  and OOXML package roots are validated; fake extensions, malformed archives,
  encrypted/path-traversing ZIP entries, expansion bombs, and paths outside the
  job work directory cannot become canonical artifacts.
- Validated child-agent text can be converted to MD, TXT, PDF, and DOCX. JSON
  and CSV are emitted only when the source already parses as that exact
  structure; Honeycomb never invents rows or fields. PPTX/XLSX require a real
  child-agent-created OOXML file.
- PDF generation embeds a CJK-capable font. Windows uses an installed Chinese
  system font and the Linux worker image installs Noto Sans CJK. Mock stage
  output is excluded, so a simulation cannot satisfy a real document request.
- Derived document paths are content/specification-addressed. Valid results are
  reused before regeneration; corrupt interrupted results are rebuilt through a
  flushed temporary file, structural reinspection, and atomic rename.
- Canonical document rows use the same authenticated download and durable
  destination-delivery protocol as media. Missing or malformed required files
  leave the task paused with an explicit document-delivery reason.
- See [`document-artifact-normalization.md`](document-artifact-normalization.md)
  for the completion contract, limits, and focused verification command.
- All 178 unit tests, TypeScript build/check, desktop production build,
  dependency audit, cross-platform Sharp lock verification, Compose validation,
  package-layout check, no-secrets check, and diff whitespace check pass.

Stage 3 is complete in code. PostgreSQL and Docker Desktop remained stopped, so
the migration-backed smoke scripts have not yet been executed. The next active
slice is Stage 4: real behavioral regression for all four routing modes.

## Current Backend Status

### Done Enough For Product Integration

1. Jobs and sessions
   - HTTP job ingress via `POST /jobs`.
   - Feishu webhook ingress skeleton via `POST /webhooks/feishu/events`.
   - Job list, details, timeline, messages, cancellation, archive, restore, fork,
     and compression APIs.

2. Runtime observability
   - Runtime logs and usage summary.
   - Token usage aggregation in `GET /runtime/usage`: totals, per-agent, and
     per-day prompt/completion/total tokens read from real-mode OpenClaw
     usage payloads.
   - Provider pricing metadata drives estimated USD cost in `GET /runtime/usage`:
     summary cost, per-provider/model cost, and per-agent/per-day cost buckets.
     Pricing is read from `provider.metadata.pricing`, including optional
     model-specific overrides.
   - Atomic spend reservations enforce optional task/user/provider hard limits;
     `GET /jobs/:jobId/spend` provides the per-attempt audit ledger.
   - Session events list.
   - Session events SSE stream for live UI updates.
   - Runtime diagnostics aggregate through `GET /runtime/diagnostics`,
     including open MCP session stats.
   - Job heartbeat summary and stalled-job scan are available through
     `GET /runtime/heartbeats` and `POST /runtime/heartbeats/scan`; worker
     activities update heartbeat source/status around planning, OpenClaw
     calls, testing, fixing, and finalization.

3. Plans and Todo
   - Job plan creation.
   - Plan listing, reading, patching.
   - Plan item creation and patching.

4. Experience memory
   - Routing outcome candidates.
   - Adopt/reject flow.
   - Repair script for cancelled archive cleanup.

5. Workspace read APIs
   - Registered workspace root list and approval-gated registration.
   - Workspace inspect.
   - File tree listing.
   - File read with binary detection and size limits.
   - Git status.
   - Workspace reads/writes/commands/git status now require a registered root.

6. Human approval ledger
   - Tool approval request table.
   - Pending/approved/rejected/cancelled/consumed/expired state machine.
   - Approval events are written into the session event stream.
   - Desktop pending approval queue can approve or reject requests.

7. Approval-gated local tools
   - Workspace file write: protected by approval target matching.
   - Workspace command run: protected by approval command and cwd matching,
     `shell: false`, timeout, and output limits.

8. Skills/MCP registry foundation
   - Skill registry CRUD API.
   - MCP server registry CRUD API.
   - Enable/disable state.
   - MCP command availability diagnostics.
   - Approval-gated MCP stdio `tools/call` proxy with timeout/output caps and
     audit events.
   - Approval-gated MCP stdio `tools/list` and `resources/list` discovery with
     results cached into MCP server config for UI use.
   - Per-agent MCP access policy API and enforcement for tools/list,
     resources/list, and tools/call.
   - Long-lived MCP stdio sessions: the initialize handshake runs once per
     server, later calls reuse the same process, idle sessions are swept after
     a timeout (`HONEYCOMB_MCP_SESSION_IDLE_MS`), and config changes or
     enable/disable flips invalidate the old session. JSON-RPC error responses
     keep the session; timeout/output-cap/protocol failures drop it.
   - MCP session stats are visible through `GET /runtime/diagnostics`, and MCP
     audit events record session pid/request count/reuse.

9. Scheduled task foundation
   - Schedule table and CRUD API.
   - One-time, daily, interval, and manual schedule metadata.
   - Due-task listing.
   - Manual trigger creates a real job.
   - Worker scheduler runner claims due tasks and catches up overdue tasks on
     worker startup.
   - Consecutive trigger failures are counted in schedule metadata and the
     schedule auto-disables at a configurable threshold
     (`HONEYCOMB_SCHEDULE_MAX_CONSECUTIVE_FAILURES`, default 5); a successful
     trigger resets the counter.

10. Packaging/layout checks
   - Package layout audit script.
   - No-secret scan.
   - Desktop launcher and shortcut repair path.

11. Worker model/agent routing foundation
   - Worker resolves `main-agent`/panel aliases through the backend agent
     registry.
   - The panel-agent maps to OpenClaw `main-agent`; Honeycomb no longer needs a
     duplicate `main-agent` registry entry.
   - Worker reads provider/model/key configuration and passes redacted routing
     metadata into job events.
   - Docker API and worker containers share a local-only provider secret volume.

12. OpenClaw native runtime config writer
   - `/openclaw/sync/apply` writes `cluster.config.json`,
     `agent-model-configs.json`, `openclaw.env`, and `runtime-manifest.json`
     into the selected runtime.
   - Generated provider config records API key configured/fingerprint status but
     never writes plaintext API keys.
   - Docker API and worker containers now discover `/app/honeycomb-runtime` and
     the launcher-provided runtime config paths.
   - Runtime control API exposes status/start/restart/stop hooks. Explicit host
     commands still take priority, and builtin packaged defaults prepare/mark
     the local OpenClaw runtime when host commands are absent.

13. Local API security baseline
   - All non-health API routes require a Honeycomb bearer token.
   - Desktop launcher generates a per-machine random token under the local app
     data directory and passes it to Docker/API and the UI.
   - Desktop API calls send `Authorization: Bearer <token>`.
   - Desktop SSE fetches use the bearer header. Native browser `EventSource`
     obtains a short-lived signed ticket restricted to one exact stream path;
     the long-lived machine token is never placed in the URL.
   - Docker API and Postgres ports are published only on `127.0.0.1`.
   - Source/dev and Docker smoke tests assert that unauthenticated business API
     requests are rejected.
   - Workspace filesystem APIs require a registered root. First registration is
     approval-gated through `workspace.register`.
   - Provider and agent API keys are stored outside JSON config through a local
     secret boundary; Windows uses DPAPI and legacy plaintext files are migrated
     on read.
   - Local provider secret reads have a process-local TTL cache, and recognized
     encrypted envelopes do not fall back to legacy plaintext migration if
     decryption fails.
   - Tool approvals now receive a default expiry, approved requests expire
     before consumption, and API approval decisions record the desktop approval
     boundary instead of trusting the client-provided decider.
   - Web fetch resolves and pins the connect IP for each request/redirect while
     keeping Host/SNI on the original hostname, closing the DNS rebinding
     check/connect gap.

14. Backend source hygiene
   - Worker no longer imports source files from the orchestrator API app.
   - Shared local secret handling now lives in `packages/runtime`.
   - DBOS workflow launch helpers live with the worker runtime.
   - `node:test` unit coverage now covers web fetch safety, approval expiry
     policy, API auth token parsing, workspace registration target
     normalization, MCP policy matching, secret cache/corruption behavior,
     MCP long-lived session lifecycle (reuse, crash recovery, idle sweep,
     timeout/output-cap destruction, config invalidation), and schedule
     failure policy.
   - HONEYC review notes are now tracked under `docs/reviews/`.
   - GitHub Actions runs `npm run test:unit`, and Docker quickstart CI uses the
     local API token model.

15. Process lifecycle hardening
   - The orchestrator API handles SIGINT/SIGTERM: it stops accepting
     connections, closes open SSE connections, shuts down long-lived MCP
     sessions, and closes the Postgres pool before exit (10s force-exit
     fallback).
   - The DBOS worker handles SIGINT/SIGTERM: it stops the scheduler runner,
     shuts down DBOS, and closes the Postgres pool before exit.
   - Admin token comparison now uses the same timing-safe equality helper as
     the API bearer token.

## Partial Or Not Yet Real Enough

1. OpenClaw real-agent orchestration
   - Current worker can run the platform workflow shape.
   - Runtime discovery is now available through `GET /openclaw/runtime`.
   - Sync plan/apply/validate APIs now write Honeycomb prompt/config files into
     the selected runtime.
   - Sync apply now also writes native runtime files: `cluster.config.json`,
     `agent-model-configs.json`, `openclaw.env`, and `runtime-manifest.json`.
   - Runtime control now has configurable status/start/restart/stop command
     endpoints plus builtin packaged defaults.
   - Worker execution now resolves Honeycomb agents to OpenClaw agent IDs and
     supplies provider/model/key runtime environment variables for real CLI
     calls.
   - Real OpenClaw end-to-end regression against an installed runtime is still
     not complete.

2. Model/provider configuration center
   - First-run UI can collect model and API key.
   - Backend provider registry now exists through `/providers`.
   - API keys are saved through a local-only secret boundary; responses only
     expose configured/fingerprint status.
   - Provider responses now reconcile database key flags with live local secret
     storage, so stale `apiKeyConfigured=true` records stop showing as
     configured after their secret file is missing or unreadable.
   - `/providers/verify-batch` verifies multiple OpenAI-compatible providers
     at once, records latency/status in `provider.metadata.verification`, and
     keeps pricing metadata intact.
   - Worker routing consumes provider base URL, model, and API key from this
     registry.
   - Worker route resolution supports fallback provider/model candidates from
     `agent.metadata.fallbackRoutes` / `fallbackProviderIds` and primary
     `provider.metadata` fallback declarations. Failed primary attempts are
     recorded in model-call routeAttempts before the worker tries the next
     route.
   - Native generated OpenClaw provider config now writes redacted model/provider
     records for each agent; plaintext keys still stay in the local secret
     boundary.
   - Real provider end-to-end regression against installed OpenClaw is still
     pending.

3. Agent registry
   - Product concept needs panel supervisor, research, writer, image, video,
     test/reviewer and future specialist agents.
   - Backend agent registry now exists through `/agents`.
   - Default seed creates panel-agent, research-agent, writer-agent, image-agent,
     video-agent, and test-agent.
   - The panel-agent maps to OpenClaw `main-agent` without duplicating a
     Honeycomb main-agent entry.
   - OpenClaw prompt/config sync and validation exist.
   - Worker maps panel/main aliases through the registry before calling
     OpenClaw.
   - Native OpenClaw config writing exists; packaged launch/restart validation
     after sync is still missing.

4. Skills and MCP registry
   - Backend persists skills and MCP servers through `/skills` and
     `/mcp-servers`.
   - MCP command availability can be checked.
   - Minimal approval-gated stdio MCP `tools/call` execution exists.
   - Approval-gated stdio MCP `tools/list` and `resources/list` discovery
     exists and stores the latest discovery result in server config.
   - Per-agent MCP access policies can allow tools/list, resources/list, all
     tools, or a specific tool allow-list.
   - Long-lived MCP sessions with idle cleanup and config invalidation now
     exist; MCP server notifications/streaming are still not surfaced.

5. Web/MCP/network tool gateway
   - File writes and command runs are approval-gated.
   - Approval-gated web fetch now supports HTTP/HTTPS GET with approval target
     matching, timeout/output caps, redirect revalidation, private-network
     blocking by default, and audit events.
   - Approval-gated web search and browser snapshot now reuse the same network
     gateway pattern: exact approval target/command matching, DNS-pinned
     fetches, private-network blocking unless approved, approval consumption,
     and audit events.
   - Per-agent network policy can now allow or deny web fetch, web search, and
     browser snapshot by operation, private-network use, protocol, and host
     allow/block lists stored in agent metadata.
   - MCP calls now run through approval-gated long-lived sessions.
   - Full interactive browser automation and broader external network
     connectors still need safe product rules.

6. Scheduled tasks
   - Durable schedule table and CRUD API exist.
   - Manual trigger can create a real job.
   - Worker scheduler runner and startup catch-up exist.
   - Selected model/workspace execution policies are still incomplete.

7. Mobile and IM background agent
   - Feishu webhook exists as ingress.
   - Lark/WeChat/IM relay, phone connection setup, and background agent session
     management are not complete.

8. Desktop approval UI
   - Backend supports approvals and approved tool execution.
   - Desktop pending approval queue, risk text, detail view, and reject/approve
     controls exist.
   - SSE refresh and policy editing are still incomplete.

9. Installer and runtime diagnostics
   - Windows local launcher is repaired.
   - Runtime diagnostics aggregate exists.
   - Runtime diagnostics now reconcile provider key status with live local
     secret storage and include a real-provider E2E readiness check that does
     not count localhost/example fake providers as live external providers.
   - Runtime diagnostics now include `job_heartbeats`, reporting expired
     active heartbeats and jobs already marked `stalled`.
   - Runtime repair API now exposes a repair action catalog and can reconcile
     provider secret state, prepare/restart the builtin OpenClaw runtime, seed
     default agents, apply OpenClaw sync, run idempotent database migrations,
     and re-check enabled MCP server commands.
   - Desktop supervisor workbench now includes a diagnostics repair card that
     lists backend repair actions and can execute them from the panel.
   - Full installer readiness and safe Docker/WSL repair actions still need
     deeper work.

10. Security hardening from `HONEYC~2.MD`
   - S1 API bearer token and local-only Docker/Postgres port publishing are
     implemented.
   - S2 registered workspace root whitelist and approval-gated first
     registration are implemented.
   - S4 Windows DPAPI encryption for saved provider/agent API keys is
     implemented; macOS Keychain has a first SecretBackend slice, while
     Linux/libsecret remains a cross-platform release item.
   - S5 default approval expiry, approved-before-consume expiry checks, and a
     tighter desktop decision actor boundary are implemented.
   - S6 web fetch hostname/IP pinning is implemented for initial requests and
     redirects.
   - Worker-to-API reverse imports for runtime/secret helpers are removed.
   - Unit test coverage has started with web fetch safety behavior; the large
     API and desktop modules still need further extraction into tested units.

11. Follow-up notes from `HONEYC~3.MD`
   - Review notes are now stored in `docs/reviews/`.
   - Local secret reads now have TTL caching and safer corrupted-envelope
     behavior.
   - Second unit-test batch and CI wiring are implemented.
   - Remote browser/IM access still needs short-lived SSE tickets or cookie
     auth. Apple desktop support is macOS-first, not iOS-first.
   - OpenClaw real provider E2E should happen before Schedule UI investment.

## Work Order

### Phase A: Make Product State Inspectable

1. Add `/runtime/capabilities`.
   - Return backend capability status, routes, risks, and next actions.
   - Purpose: settings/diagnostics page can show what is real and what is still
     planned.
   - Status: done.

2. Add OpenClaw runtime discovery.
   - Locate configured OpenClaw runtime.
   - Report installed/missing/unknown status.
   - Report known config paths without printing secrets.
   - Status: done.

### Phase B: Make First-Run Setup Actually Provision The System

3. Add provider registry.
   - Store provider name, base URL template, model, key configured flag, and
     verification status.
   - Keep API keys local-only and redacted.
   - Status: partial done. Registry, live local-only key status, verification,
     shared Docker secret volume, native redacted config writing, and worker
     routing now exist; real OpenClaw provider E2E validation is still missing.

4. Add agent registry.
   - Store panel supervisor and child agents.
   - Use the user-provided panel-agent name for the main/panel agent.
   - Add missing `video-agent`.
   - Track whether each agent is synced to OpenClaw.
   - Status: partial done. Registry, default catalog, OpenClaw prompt/config
     sync, and worker runtime resolution exist; OpenClaw launch/restart
     validation is still missing.

5. Add OpenClaw sync API.
   - Generate or update agent prompt files.
   - Generate or update model/provider config.
   - Validate that OpenClaw can see the agents.
   - Status: partial done. The backend can plan/apply/validate Honeycomb prompt
     files, generated config, native runtime config, redacted model/provider
     config, env file, and runtime manifest. It still needs packaged default
     launch/restart command wiring and real OpenClaw E2E validation.

### Phase C: Make Tooling Useful And Safe

6. Security baseline before broader tool exposure.
   - Enforce local API auth and avoid LAN-exposed development services.
   - Status: done for the current Windows-local baseline. Non-health API routes now require a bearer token,
      desktop/dev launchers generate and inject that token, and Docker API /
      Postgres ports bind to `127.0.0.1`; registered workspace roots and
      approval-gated workspace registration now exist. Provider/agent API keys
      use DPAPI on Windows, approval expiry is enforced before decisions and
      consumption, SSE EventSource URLs use short-lived signed exact-path
      tickets instead of the machine token, and web fetch pins the resolved connect IP. macOS Keychain
     has a first slice; Linux/libsecret and real Mac validation are still needed
     before cross-platform release builds.

7. Add desktop approval UI.
   - Queue, detail, approve/reject/cancel.
   - Risk level text.
   - Live SSE updates.
   - Status: partial done. Pending queue, detail cards, and approve/reject
     controls exist; SSE refresh and policy editing are still missing.

8. Add Skills/MCP registry.
   - CRUD skills and MCP servers.
   - Diagnostics and enable/disable switches.
   - Per-agent policy.
   - Status: partial done. Registry, command diagnostics, approval-gated stdio
     calls/discovery, per-agent policy enforcement, and long-lived MCP
     sessions with idle cleanup exist; MCP notifications/streaming are still
     missing.

9. Add approval-gated Web/MCP calls.
   - Same approval ledger as file/command.
   - Timeout/output caps.
   - Event stream visibility.
   - Status: partial done. Web fetch, web search, browser snapshot, and MCP
     stdio tools/list, resources/list, and tools/call are approval-gated,
     audited, and reuse the same safe gateway principles. Agent metadata can
     now enforce per-agent network policy for fetch/search/snapshot; richer
     interactive browser automation is still missing.

### Phase D: Make It Operable Like A Product

10. Add scheduled tasks.
   - One-time, daily, interval, manual tasks.
   - Bind workspace, model, and reasoning/execution settings.
   - Status: partial done. Schedule CRUD, due listing, next-run calculation,
     manual trigger-to-job, worker runner, and startup catch-up exist; product
     UI and model/reasoning policy binding are still missing.

11. Add IM/mobile background agent.
    - Feishu/Lark/WeChat/relay setup.
    - Independent background sessions.

12. Add installer/runtime diagnostics.
    - OpenClaw, WSL/Docker, database, API, worker, desktop bundle, and provider
      checks.
    - Safe repair actions.
    - Status: partial done. Runtime diagnostics aggregate exists, provider
      secret-state reconciliation is included, and real-provider E2E readiness
      is explicit. First repair actions now exist for provider secret
      reconciliation, OpenClaw runtime control, default agent seeding, and
      OpenClaw sync apply. Database migration and MCP command re-check repair
      actions also exist. Desktop workbench can list and execute repair
      actions. Read-only WSL/Docker host checks now run inside
      `GET /runtime/diagnostics` with short-TTL probe caching: wsl.exe
      availability, configured distro presence/state (UTF-16 output handled),
      Docker CLI/daemon reachability, and Honeycomb container status; the
      checks skip themselves inside containers or on non-Windows hosts, and
      real-provider E2E readiness now requires the configured WSL distro.
      Safe WSL/Docker repair actions (mutating) are still deliberately not
      implemented until a safer installer strategy is designed.
      Job heartbeat/stall detection also exists now: `GET /runtime/heartbeats`
      reads active/stale/stalled counts, `POST /runtime/heartbeats/scan`
      marks expired active jobs as `stalled` without cancelling or deleting
      them, and `npm run smoke:job-heartbeats` validates the path.
      Expired model-call leases are now visible globally and per task through
      `/runtime/model-call-leases` and `/jobs/:jobId/model-call-leases`.
      The bounded recovery scan and diagnostics repair action preserve resumable
      provider video task IDs, while ambiguous ordinary calls pause for explicit
      reconciliation instead of being sent again.
      The task page also has an authoritative aggregate at
      `GET /jobs/:jobId/execution-state`: stage/plan progress, selected Agent
      state, queue/retry/model-call activity, approvals, artifact delivery,
      spend, blockers, and recommended actions are projected from durable
      records instead of inferred from timeline wording.
      Paginated task lists can include the same state as compact batch
      summaries, and revision-based refresh returns only changed tasks without
      relying on timestamp cursors or one request per task.
      A durable task-update SSE stream now reads a transaction-ordered global
      job-event stream ID as its disconnect cursor and sends only coalesced
      changed task IDs. Initial
      connections resync from the summary endpoint; reconnects replay events
      after `Last-Event-ID`. Desktop fetch streaming keeps the bearer token in
      an authorization header, while native EventSource uses a 60-second signed,
      path-bound ticket instead of a long-lived URL token.
      Runtime maintenance is also automatic: API and worker processes compete
      for one PostgreSQL advisory lock, honor a persisted next-run time, scan
      expired model-call leases before stale heartbeats, and persist health,
      counts, errors, and consecutive failures for diagnostics.

## Current Next Step: Staged Work Plan (2026-06-12)

Everything up to read-only WSL/Docker host diagnostics has landed. What
remains, ordered into execution stages. Cross-platform support is
deliberately the LAST stage (user decision: finish the product first).

### Stage A - Prove the product is real (now)

1. Real OpenClaw provider E2E regression (`npm run smoke:openclaw-real`).
   Blocked on the user re-entering and verifying a real external provider
   API key; the `real_provider_e2e` diagnostic lists exactly what is
   missing. Fix whatever the first real runs expose.
2. Job heartbeat/stall detection: done. Jobs store heartbeat time/status/source
   and stalledAt; worker activities update heartbeat around long steps; API
   and diagnostics expose the state; the smoke test creates an expired running
   job and verifies scan/diagnostics behavior.
3. Desktop system notifications: done for the current desktop webview path.
   The app now uses the Web Notification API with local de-dupe storage for
   job succeeded/failed/waiting-for-human events and newly pending approvals.
   Unsupported or denied notification permission silently degrades without
   breaking the panel.

### Stage B - Complete the core workflow (after the real loop is proven)

4. Adopted-experience retrieval into subsequent jobs, plus confidence
   aggregation across similar results (README "next build" items).
5. Requirement clarification flow: background/goal/acceptance-criteria
   before job creation, AI-assisted clarification, feeding the plan and the
   test-agent quality gate.
6. Schedule execution policy binding (model/workspace/reasoning) and the
   Schedule product UI.
7. Approval queue SSE live refresh and approval policy editing.

### Stage C - Architecture and quality

8. Phase 18.5: split `server.ts` (~3k lines) into route modules and desktop
   `main.tsx` into tested modules; extend unit coverage over the big
   modules.
9. Phase 18 remainder: richer interactive browser automation (multi-step
   click/fill flows) behind the same approval ledger.
10. P2 backlog from the competitive analysis: `mcp_search` progressive tool
    discovery, memory/experience management UI (edit/classify/export),
    config backup/restore with key re-encryption.
11. Safe WSL/Docker repair actions on top of the read-only checks (explicit
    confirmation, scoped to Honeycomb's own stack).

### Stage D - IM and remote browser ingress

12. Feishu relay completion and independent background agent sessions; then
    WeChat/other channels.
13. Remote access auth: per-device tokens and short-lived SSE tickets
    (HONEYC~3 item; shared prerequisite for remote browser/IM access).

### Stage E - Cross-platform adaptation (LAST) + Alpha

14. Execute `docs/cross-platform-plan.md`: process-execution adapter
    (win32 WSL wrapper vs native CLI), SecretBackend abstraction
    (DPAPI/Keychain/libsecret/encrypted-file), bash launchers, Tauri
    macOS/Linux builds, and hosted web panel for headless Linux/WSL2.
    Apple computer support means macOS desktop support, not iOS support.
15. Cross-platform installer validation, then the first public Alpha.
