# Unified task execution state

`GET /jobs/:jobId/execution-state` is the task page's authoritative read model. It combines durable records instead of asking the desktop to infer Agent state from recent timeline text.

## Sources

The projection reads:

- the task status, routing mode, heartbeat, queue, retry, preflight, and spend budget;
- ordered pipeline stages and the latest persisted task plan;
- active model-call queue rows and sanitized model-call state;
- pending tool approvals;
- canonical artifact/file counts and required delivery status.

The response never includes model-call claim tokens, provider request references, API keys, artifact-delivery claim tokens, approval commands, approval input payloads, or approval policy payloads.

## Precedence

The task phase and each Agent state use stable precedence:

1. terminal task outcomes;
2. unknown provider outcomes requiring reconciliation;
3. pending human approval;
4. blocked Agent configuration or spend limits;
5. required artifact delivery;
6. stalled execution or resumable provider video polling;
7. retry wait and model-call queue wait;
8. persisted task/stage status.

This prevents a generic `running` stage or a recent timeline event from hiding the real reason work cannot proceed.

## Response sections

- `job.phase` is the task page's primary state.
- `stateUpdatedAt` is the newest timestamp across all durable records used by the projection.
- `progress` reports weighted stage progress and all currently active or blocked stages.
- `agents` contains only the coordinator, selected/observed workers, quality-gate Agent, and explicitly skipped Agents.
- `runtime` summarizes model calls, queues, approvals, artifacts, deliveries, heartbeat, and spend.
- `blockers` is ordered by operational priority. `primaryBlocker` is the first item.
- `recommendedActions` contains stable action IDs for product controls and localization.

Pure projection coverage is in `tests/job-execution-state.test.ts`. With PostgreSQL running, execute:

```powershell
npm run smoke:job-execution-state
```

The database smoke test verifies stage/plan aggregation, approval precedence, payload sanitization, and state changes after approval resolution.

For task-list batching and revision-based incremental refresh, see `docs/job-execution-summaries.md`.
