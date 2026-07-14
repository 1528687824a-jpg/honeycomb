$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

function Start-DevForCancelSmoke {
  Set-Location $root
  $env:FEISHU_ADAPTER_ENABLED = "false"
  $env:FEISHU_DRY_RUN = "true"
  $env:OPENCLAW_AGENT_MODE = "mock"
  Remove-Item Env:\DBOS_TEST_CRASH_ONCE_AFTER -ErrorAction SilentlyContinue

  npm run dev:start | Out-Host
}

function Assert-Equal {
  param(
    [object]$Actual,
    [object]$Expected,
    [string]$Message
  )

  if ($Actual -ne $Expected) {
    throw "$Message. Expected '$Expected', got '$Actual'"
  }
}

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Wait-ForStatus {
  param(
    [string]$JobId,
    [string[]]$Statuses
  )

  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    $job = Invoke-RestMethod -Uri "http://localhost:3000/jobs/$JobId"
    if ($Statuses -contains $job.status) {
      return $job
    }
  }

  throw "Timed out waiting for $JobId to reach $($Statuses -join ', ')"
}

Start-DevForCancelSmoke

$createBody = @{
  prompt = "Cancel smoke: write a short note, but the model-call budget should pause the job before test review."
  requesterId = "cancel-smoke"
  routingMode = "supervisor_pipeline"
  maxModelCalls = 1
} | ConvertTo-Json

$created = Invoke-RestMethod `
  -Uri "http://localhost:3000/jobs" `
  -Method Post `
  -ContentType "application/json" `
  -Body $createBody

Assert-True -Condition ([bool]$created.jobId) -Message "jobId missing"

$waiting = Wait-ForStatus -JobId $created.jobId -Statuses @("waiting_for_human", "failed", "succeeded", "cancelled")
Assert-Equal -Actual $waiting.status -Expected "waiting_for_human" -Message "budget-limited job should wait for human"

$env:SMOKE_CANCEL_JOB_ID = $created.jobId
$env:SMOKE_CANCEL_MODEL_CALL_KEY = "$($created.jobId):cancel-smoke-active-call"
$seedModelCallScript = @'
async function main() {
  const { pool } = await import("./packages/db/src/pool");
  await pool.query(
    `insert into agent.model_calls (
      id, idempotency_key, job_id, attempt_no, action_type, agent_id, status
    ) values ($1, $2, $3, 1, 'cancel-smoke', 'research-agent', 'started')`,
    [
      `MC-CANCEL-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
      process.env.SMOKE_CANCEL_MODEL_CALL_KEY,
      process.env.SMOKE_CANCEL_JOB_ID
    ]
  );
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'@
$seedModelCallScript | npx tsx -

$cancelBody = @{
  reason = "cancel smoke requested"
  requesterId = "cancel-smoke"
} | ConvertTo-Json

$cancelled = Invoke-RestMethod `
  -Uri "http://localhost:3000/jobs/$($created.jobId)/cancel" `
  -Method Post `
  -ContentType "application/json" `
  -Body $cancelBody

Assert-Equal -Actual $cancelled.ok -Expected $true -Message "cancel ok"
Assert-Equal -Actual $cancelled.changed -Expected $true -Message "cancel changed"
Assert-Equal -Actual $cancelled.status -Expected "cancelled" -Message "cancel response status"
Assert-Equal -Actual $cancelled.workflowCancellation -Expected "requested" -Message "DBOS workflow cancellation"

$job = Invoke-RestMethod -Uri "http://localhost:3000/jobs/$($created.jobId)"
Assert-Equal -Actual $job.status -Expected "cancelled" -Message "job status after cancel"
Assert-True -Condition ([bool]$job.completedAt) -Message "cancelled job missing completedAt"
Assert-True -Condition ([bool]$job.archivedAt) -Message "cancelled job missing archivedAt"
Assert-True -Condition ([bool]$job.retentionUntil) -Message "cancelled job missing retentionUntil"
Assert-Equal -Actual $job.cleanupStatus -Expected "retained" -Message "cancelled job cleanupStatus"
Assert-Equal -Actual $job.retentionPolicy.archiveReason -Expected "job_cancelled" -Message "cancel archive reason"
Assert-True -Condition ($job.retentionPolicy.retentionDays -gt 0) -Message "cancel retentionDays should be positive"

$verifyModelCallScript = @'
async function main() {
  const { markModelCallStarted } = await import("./packages/db/src/model-calls");
  const { pool } = await import("./packages/db/src/pool");
  const result = await pool.query(
    `select status, error from agent.model_calls where idempotency_key = $1`,
    [process.env.SMOKE_CANCEL_MODEL_CALL_KEY]
  );
  let restartError = null;
  try {
    await markModelCallStarted({
      idempotencyKey: `${process.env.SMOKE_CANCEL_MODEL_CALL_KEY}:restart`,
      jobId: process.env.SMOKE_CANCEL_JOB_ID,
      attemptNo: 2,
      actionType: "cancel-smoke-restart",
      agentId: "research-agent"
    });
  } catch (error) {
    restartError = error instanceof Error ? error.message : String(error);
  }
  console.log(JSON.stringify({
    status: result.rows[0]?.status ?? null,
    error: result.rows[0]?.error ?? null,
    restartError
  }));
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'@
$modelCallCheck = ($verifyModelCallScript | npx tsx - | ConvertFrom-Json)
Assert-Equal -Actual $modelCallCheck.status -Expected "cancelled" -Message "active model call status after cancel"
Assert-Equal -Actual $modelCallCheck.error -Expected "job_cancelled" -Message "active model call cancel reason"
Assert-Equal -Actual $modelCallCheck.restartError -Expected "job_cancelled" -Message "cancelled job must reject new model calls"

$secondCancel = Invoke-RestMethod `
  -Uri "http://localhost:3000/jobs/$($created.jobId)/cancel" `
  -Method Post `
  -ContentType "application/json" `
  -Body $cancelBody
Assert-Equal -Actual $secondCancel.ok -Expected $true -Message "second cancel ok"
Assert-Equal -Actual $secondCancel.changed -Expected $false -Message "second cancel idempotent"
Assert-Equal -Actual $secondCancel.reason -Expected "already_cancelled" -Message "second cancel reason"

$timeline = Invoke-RestMethod -Uri "http://localhost:3000/jobs/$($created.jobId)/timeline?limit=500"
$timelineItems = @($timeline.timeline)
$cancelEvents = @(
  $timelineItems | Where-Object { $_.source -eq "job_event" -and $_.eventType -eq "job.cancelled" }
)
$archiveEvents = @(
  $timelineItems | Where-Object { $_.source -eq "job_event" -and $_.eventType -eq "job.archived" }
)
Assert-True -Condition ($cancelEvents.Count -gt 0) -Message "timeline missing job.cancelled"
Assert-Equal -Actual $cancelEvents.Count -Expected 1 -Message "timeline should have one job.cancelled job event"
Assert-Equal -Actual $archiveEvents.Count -Expected 1 -Message "timeline should have one job.archived job event"
Assert-True -Condition ($cancelEvents[0].payload.cancelledModelCallCount -ge 1) -Message "cancel event should count stopped model calls"

$usage = Invoke-RestMethod -Uri "http://localhost:3000/runtime/usage"
Assert-True -Condition ($usage.summary.modelCalls.cancelled -ge 1) -Message "runtime usage should count cancelled model calls"

$cancelIndex = -1
$archiveIndex = -1
for ($i = 0; $i -lt $timelineItems.Count; $i++) {
  $item = $timelineItems[$i]
  if ($item.source -eq "job_event" -and $item.eventType -eq "job.cancelled") {
    $cancelIndex = $i
  }
  if ($item.source -eq "job_event" -and $item.eventType -eq "job.archived") {
    $archiveIndex = $i
  }
}
Assert-True -Condition ($archiveIndex -gt $cancelIndex) -Message "job.archived should appear after job.cancelled"

[pscustomobject]@{
  ok = $true
  jobId = $created.jobId
  waitingStatus = $waiting.status
  cancelStatus = $job.status
  cleanupStatus = $job.cleanupStatus
  archivedAt = $job.archivedAt
  retentionUntil = $job.retentionUntil
  secondCancelReason = $secondCancel.reason
  timelineCancelEvents = $cancelEvents.Count
  timelineArchiveEvents = $archiveEvents.Count
  checked = @(
    "budget_waiting_job",
    "post_cancel",
    "dbos_workflow_cancel_requested",
    "cancel_archives_session",
    "cancel_is_idempotent",
    "active_model_call_cancelled",
    "cancelled_job_rejects_new_model_calls",
    "runtime_usage_counts_cancelled_model_calls",
    "timeline_has_cancel_event",
    "timeline_has_archive_event",
    "archive_event_after_cancel_event"
  )
} | ConvertTo-Json -Depth 4
