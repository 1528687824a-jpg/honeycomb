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

$job = Invoke-RestMethod -Uri "http://localhost:3000/jobs/$($created.jobId)"
Assert-Equal -Actual $job.status -Expected "cancelled" -Message "job status after cancel"

$secondCancel = Invoke-RestMethod `
  -Uri "http://localhost:3000/jobs/$($created.jobId)/cancel" `
  -Method Post `
  -ContentType "application/json" `
  -Body $cancelBody
Assert-Equal -Actual $secondCancel.ok -Expected $true -Message "second cancel ok"
Assert-Equal -Actual $secondCancel.changed -Expected $false -Message "second cancel idempotent"
Assert-Equal -Actual $secondCancel.reason -Expected "already_cancelled" -Message "second cancel reason"

$timeline = Invoke-RestMethod -Uri "http://localhost:3000/jobs/$($created.jobId)/timeline?limit=500"
$cancelEvents = @(
  $timeline.timeline | Where-Object { $_.eventType -eq "job.cancelled" }
)
Assert-True -Condition ($cancelEvents.Count -gt 0) -Message "timeline missing job.cancelled"

[pscustomobject]@{
  ok = $true
  jobId = $created.jobId
  waitingStatus = $waiting.status
  cancelStatus = $job.status
  secondCancelReason = $secondCancel.reason
  timelineCancelEvents = $cancelEvents.Count
  checked = @(
    "budget_waiting_job",
    "post_cancel",
    "cancel_is_idempotent",
    "timeline_has_cancel_event"
  )
} | ConvertTo-Json -Depth 4
