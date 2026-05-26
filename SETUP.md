# Agent OpenClaw Setup Notes

## Current Runtime

The local orchestration kernel is now:

```text
orchestrator-api
  -> DBOS workflow library
  -> Postgres
  -> OpenClaw adapter
  -> Feishu display adapter
```

Temporal Server and Temporal UI are no longer part of the local dev stack.
DBOS stores durable workflow state in Postgres under the `dbos` schema.
Business state still lives in the `agent` schema.

## Local Services

Start Postgres, run migrations, and launch the API:

```powershell
npm run dev:start
```

Stop the API and Docker Compose services:

```powershell
npm run dev:stop
```

Service URLs:

```text
API: http://localhost:3000
Postgres: localhost:5432
```

Development database defaults:

```text
DATABASE_URL=postgresql://temporal:temporal@localhost:5432/temporal
DBOS_SYSTEM_DATABASE_SCHEMA=dbos
```

The username/database name are historical local defaults from the previous
Temporal setup. They are not used to run Temporal anymore.

## Manual Commands

Install dependencies:

```powershell
npm install
```

Run business-table migrations:

```powershell
npm run db:migrate
```

Start only the API:

```powershell
npm run dev:api
```

Start the optional DBOS recovery worker:

```powershell
npm run dev:worker
```

The normal local path does not need a separate worker. The API process calls
`DBOS.launch()` and starts/recover workflows itself.

## Local POST /jobs Check

Use dry-run Feishu mode for local verification unless you intentionally want
real group messages:

```powershell
$env:FEISHU_DRY_RUN='true'
npm run dev:api
```

Create a local job:

```powershell
$body = @{
  rawPrompt = 'research current AI trends, write a short article, and create an image poster brief'
  requesterId = 'local-test-user'
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri 'http://localhost:3000/jobs' -Method Post -ContentType 'application/json' -Body $body
$response
Invoke-RestMethod -Uri "http://localhost:3000/jobs/$($response.jobId)"
Invoke-RestMethod -Uri "http://localhost:3000/jobs/$($response.jobId)/details"
```

Expected behavior:

```text
POST /jobs
  -> creates agent.jobs row
  -> starts DBOS JobPipelineWorkflow
  -> main-agent creates stages
  -> child agent writes an artifact and creates a visible group update
  -> test-agent PASS advances to the next stage
  -> test-agent FAIL routes back to the previous child agent
  -> after 3 consecutive FAILs, the job enters waiting_for_human
```

## DBOS Checkpoints

DBOS system state is stored in Postgres:

```text
dbos.workflow_status
dbos.operation_outputs
```

`workflow_status` stores workflow identity/status/input/output. `operation_outputs`
stores completed step outputs, so recovery can skip finished steps after a crash.

## OpenClaw Idempotency

OpenClaw calls are guarded by business-table idempotency records:

```text
agent.model_calls
idempotency_key = jobId + stageId + attemptNo + actionType
```

If recovery reruns a step after an OpenClaw call already succeeded, the step
reuses the stored model-call result and records `tool.openclaw_agent_reused`
instead of calling OpenClaw again.

If a prior call is only `started` and has no completed result, the workflow
throws instead of silently making a second ambiguous external call.

## Crash Recovery Test Hook

The workflow includes test-only crash hooks. They are disabled unless this
environment variable is set.

Crash after a whole `runStageAgent` step has checkpointed:

```text
DBOS_TEST_CRASH_ONCE_AFTER=after-runStageAgent-stage-001-attempt-01
```

Crash inside the `runStageAgent` step after OpenClaw result is recorded but
before DBOS can checkpoint the step:

```text
DBOS_TEST_CRASH_ONCE_AFTER=after-openclaw-stage-agent-stage-001-attempt-01
```

Restart the API without the variable set. The first hook should skip the
completed step; the second hook should rerun the step but reuse the
`agent.model_calls` record instead of calling OpenClaw again.

## Feishu Webhook

Feishu is still only the human entrypoint and visible display screen. Real
agent-to-agent handoff is controlled locally by DBOS/Postgres, not by Feishu
mentions.

```text
POST http://localhost:3000/webhooks/feishu/events
```

Public HTTPS webhook setup is intentionally after local DBOS validation.

## OpenClaw Runtime Mode

Default local verification uses mock agent outputs:

```text
OPENCLAW_AGENT_MODE=mock
```

To call real WSL OpenClaw agents:

```text
OPENCLAW_AGENT_MODE=real
OPENCLAW_WSL_DISTRO=Ubuntu-24.04
OPENCLAW_CLI=/home/administrator/.npm-global/bin/openclaw
OPENCLAW_AGENT_TIMEOUT_SECONDS=600
```

## Session Archive And Cleanup

Completed jobs are archived and retained before heavy intermediate cleanup:

```text
archived_at
retention_until
cleanup_status=retained
retention_policy
```

Preview cleanup:

```powershell
npm run maintenance:cleanup-sessions
```

Apply cleanup:

```powershell
npm run maintenance:cleanup-sessions -- --apply
```
