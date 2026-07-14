# Job Cancellation Semantics

This document defines the v1 behavior of cancelling a non-terminal job.

## API Contract

Cancel is requested through:

```text
POST /jobs/:jobId/cancel
```

For jobs in a non-terminal status, the API:

```text
1. sets status=cancelled;
2. sets completedAt if it was empty;
3. marks every started or retry-waiting model call as cancelled;
4. appends job.cancelled with the number of stopped model calls;
5. archives the session with retentionPolicy.archiveReason=job_cancelled;
6. appends job.archived;
7. requests native DBOS workflow cancellation when a workflow ID exists and
   records whether that request succeeded.
```

Repeating cancel is idempotent. It returns the already-cancelled job and does
not append another `job.cancelled` or `job.archived` event when the archive is
already present.

Cancelling a `succeeded` or `failed` job returns `409 job_already_terminal`.

## Active Stop

Workflows still check cancellation between durable steps and before
finalization. In addition, every active model-call route watches the persisted
job status. The default poll interval is 750 ms and can be changed with
`HONEYCOMB_JOB_CANCELLATION_POLL_MS` (100-5000 ms).

When cancellation is observed, Honeycomb:

1. aborts provider-direct HTTP requests with `AbortSignal`;
2. aborts generated-media downloads and file writes;
3. aborts native OpenClaw child processes;
4. aborts `wsl.exe` and issues a best-effort Linux-side termination targeted at
   the unique OpenClaw session ID;
5. releases the persistent model-call concurrency lease;
6. records `model_calls.status=cancelled` (including a call currently in
   `retry_waiting`) and
   `tool.openclaw_agent_cancelled` without trying a fallback provider;
7. asks DBOS to cancel the durable workflow so it does not retry the cancelled
   step or schedule later steps.

The job status is the source of truth. If the DBOS cancellation request fails,
the user-facing cancellation remains successful because the persisted status,
model-call guard, and active request watcher still prevent further work. The
timeline records `job.workflow_cancel_failed` for diagnosis.

The database rejects new model-call starts for cancelled jobs. Row locks order
model-call start/success writes against cancellation, so a success write cannot
use a stale pre-cancellation job status after cancellation has committed.

Provider cancellation is necessarily best effort after a request has crossed
the network boundary. A remote service may already have accepted or completed
work before it receives the disconnect, but Honeycomb will not persist that
late response as a successful model call or continue the local task pipeline.

This means a cancelled job can still contain stage attempts, test reviews,
group messages, and artifacts that were committed before cancellation was
observed.

## Artifact Behavior

Artifacts are append-only records for audit and recovery. Cancelling a job does
not roll back, delete, or mark existing artifacts as stale.

The public timeline continues to show all artifact events for the job. This is
intentional: a cancelled session should remain inspectable so users can see what
was produced before the stop request took effect.

Partially downloaded media is not registered as a successful artifact. Existing
completed artifacts remain append-only for audit and recovery.

Cancelled jobs do not create a new final output. If a job is cancelled before
`finalizeJob`, `finalOutput` remains whatever it already was, usually `null`.
The `setJobFinalOutput` write is guarded so a cancelled job cannot later become
`succeeded`.

## Archive And Cleanup

Cancelled jobs enter the same archive/retention ledger as completed jobs, with a
different archive reason:

```text
retentionPolicy.archiveReason=job_cancelled
cleanupStatus=retained
```

The cleanup maintenance task may remove large temporary per-job files only after
`retentionUntil` has passed and only when run in apply mode:

```powershell
npm run maintenance:cleanup-sessions -- --apply
```

Database rows, timeline events, final summaries, and long-term experience files
are preserved according to the retention policy.

## Operator Expectations

Use cancel when a user wants to stop further work while preserving the record of
what happened. Do not use cancel as a cleanup command. Cleanup is a separate
retention-gated maintenance concern.
