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
3. appends job.cancelled;
4. archives the session with retentionPolicy.archiveReason=job_cancelled;
5. appends job.archived.
```

Repeating cancel is idempotent. It returns the already-cancelled job and does
not append another `job.cancelled` or `job.archived` event when the archive is
already present.

Cancelling a `succeeded` or `failed` job returns `409 job_already_terminal`.

## Cooperative Stop

Cancellation is cooperative, not preemptive. Workflows check cancellation state
between durable steps and before finalization. If a DBOS step is already running
when cancel is requested, that step may finish and persist its normal outputs
before the next cancellation check stops the workflow.

This means a cancelled job can still contain stage attempts, test reviews,
group messages, and artifacts created before the cancellation was observed.

## Artifact Behavior

Artifacts are append-only records for audit and recovery. Cancelling a job does
not roll back, delete, or mark existing artifacts as stale.

The public timeline continues to show all artifact events for the job. This is
intentional: a cancelled session should remain inspectable so users can see what
was produced before the stop request took effect.

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
