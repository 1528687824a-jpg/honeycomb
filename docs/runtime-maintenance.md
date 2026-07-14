# Automatic runtime maintenance

Honeycomb automatically classifies expired model-call leases and stale task heartbeats. Both the orchestrator API and DBOS worker start the runner so either process can keep recovery active.

## Single-run ownership

Every cycle first acquires the PostgreSQL session advisory lock `honeycomb.runtime-maintenance.v1`. The winner then checks the persisted `next_run_at` value before doing work. This provides two protections:

- API/worker replicas cannot run the same cycle concurrently;
- processes that start a few seconds apart cannot run duplicate back-to-back cycles.

The lock is released automatically if the process or database connection exits. The underlying lease and heartbeat scans remain independently concurrency-safe and idempotent.

## Order and safety

Each cycle runs the specific model-call lease recovery before the generic heartbeat scan. This allows an expired request to become either a resumable provider video task or an explicit unknown outcome before a generic stale-heartbeat state is considered.

Automatic maintenance never repeats an ambiguous paid provider request and never automatically resumes a task. It only records the safe recovery state that the task page and operator can act on.

## Persisted health

`agent.runtime_maintenance_state` stores the owner, run ID, trigger, start/completion/success times, next run, bounded error text, component counts, total runs, and consecutive failures. A process crash can therefore be detected after restart instead of losing the last maintenance state.

Authenticated routes:

```text
GET  /runtime/maintenance
POST /runtime/maintenance/run
```

The POST route forces one immediate cycle, but still respects the cross-process advisory lock. Runtime diagnostics also reports `runtime_maintenance` as healthy, running, degraded, failed, disabled, never run, or stale.

## Configuration

```text
HONEYCOMB_RUNTIME_MAINTENANCE_ENABLED=true
HONEYCOMB_RUNTIME_MAINTENANCE_INTERVAL_SECONDS=30
HONEYCOMB_RUNTIME_MAINTENANCE_HEARTBEAT_LIMIT=100
HONEYCOMB_RUNTIME_MAINTENANCE_MODEL_CALL_LIMIT=100
HONEYCOMB_RUNTIME_MAINTENANCE_STALE_SECONDS=
JOB_HEARTBEAT_TIMEOUT_SECONDS=300
```

The stale threshold defaults to the greater of three intervals or 120 seconds. Values are bounded in code so an invalid environment value cannot create a busy loop or an unbounded scan.

With PostgreSQL running, verify lock ownership, due-time suppression, persisted success, forced manual execution, and partial-failure diagnostics:

```powershell
npm run smoke:runtime-maintenance
```
