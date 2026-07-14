# Task-list execution summaries

The task list can load durable execution status without issuing one request per task.

## First page

Add `includeExecutionSummaries=true` to the existing paginated job list:

```text
GET /jobs?limit=50&sort=updatedAt&order=desc&includeExecutionSummaries=true
```

The normal `jobs` and `page` fields remain unchanged. The response also includes `executionSummaries`, containing one summary for every returned task.

Each summary contains:

- task status, execution phase, routing mode, progress, and current stages;
- every selected/observed Agent's state and current action;
- compact plan counts, primary blocker, and stable recommended actions;
- queue, retry, reconciliation, approval, artifact, delivery, and spend counts;
- `updatedAt` from the latest durable source record;
- a SHA-256 `revision` of the safe visible summary.

The batch implementation reads each table once for the requested task set. It does not call the single-task endpoint in a loop.

## Incremental refresh

Send the currently visible task IDs and revisions:

```text
POST /jobs/execution-summaries/query
Content-Type: application/json

{
  "jobIds": ["JOB-A", "JOB-B"],
  "knownRevisions": {
    "JOB-A": "<64-character revision>",
    "JOB-B": "<64-character revision>"
  }
}
```

The API accepts up to 100 task IDs. It returns changed summaries only, plus:

- `unchangedJobIds` for revisions that still match;
- `missingJobIds` for tasks that no longer exist;
- `revisions` for every task that was found.

Revision comparison avoids timestamp races: updates committed in the same clock tick or by a long transaction cannot be skipped merely because their timestamp equals a polling cursor. `generatedAt` is not part of the revision.

## Safety

Summaries are projected from the sanitized execution-state model. They do not include model-call idempotency keys, claim tokens, provider request/task references, approval commands/input/policy, API keys, delivery claim tokens, artifact paths, or raw provider and delivery errors. Blocker details use controlled public descriptions; use the authenticated single-task execution-state endpoint for deeper diagnosis.

Pure projection and revision tests are in `tests/job-execution-state.test.ts`. With PostgreSQL running, verify the multi-task database aggregate:

```powershell
npm run smoke:job-execution-summaries
```
