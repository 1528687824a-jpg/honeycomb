$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "honeycomb-api-token.ps1")
$apiHeaders = Get-HoneycombApiHeaders
$apiBaseUrl = "http://127.0.0.1:3000"

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

function Invoke-JsonPost {
  param(
    [string]$Uri,
    [object]$Body
  )

  $json = $Body | ConvertTo-Json -Depth 20
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Invoke-RestMethod `
    -Uri $Uri `
    -Method Post `
    -Headers $apiHeaders `
    -ContentType "application/json; charset=utf-8" `
    -Body $bytes
}

Set-Location $root
$env:FEISHU_ADAPTER_ENABLED = "false"
$env:FEISHU_DRY_RUN = "true"
$env:OPENCLAW_AGENT_MODE = "mock"
Remove-Item Env:\DBOS_TEST_CRASH_ONCE_AFTER -ErrorAction SilentlyContinue
npm run dev:start | Out-Host

$marker = [guid]::NewGuid().ToString("N")
$projectId = "project-smoke-$marker"
$conversationId = "conversation-smoke-$marker"
$messageId = "message-smoke-$marker"
$now = (Get-Date).ToUniversalTime().ToString("o")
$snapshot = @{
  generatedAt = $now
  projects = @(
    @{
      id = $projectId
      name = "Conversation persistence smoke"
      workspacePath = $root
      pinned = $false
      archivedAt = $null
      metadata = @{ smoke = $marker }
      createdAt = $now
      updatedAt = $now
      conversations = @(
        @{
          id = $conversationId
          projectId = $projectId
          title = "Tea ceremony poster"
          draft = ""
          attachments = @()
          pinned = $false
          unread = $false
          archivedAt = $null
          metadata = @{ smoke = $marker }
          createdAt = $now
          updatedAt = $now
          messages = @(
            @{
              id = $messageId
              conversationId = $conversationId
              role = "user"
              body = "Create a 1080x1920 tea ceremony promotional poster as a PNG file on the desktop."
              status = "sent"
              jobId = $null
              attachments = @()
              metadata = @{ smoke = $marker }
              createdAt = $now
              updatedAt = $now
            }
          )
        }
      )
    }
  )
}

$synced = Invoke-JsonPost -Uri "$apiBaseUrl/conversation-workspace/sync" -Body $snapshot
Assert-Equal -Actual $synced.accepted.projects -Expected 1 -Message "project sync count"
Assert-Equal -Actual $synced.accepted.conversations -Expected 1 -Message "conversation sync count"
Assert-Equal -Actual $synced.accepted.messages -Expected 1 -Message "message sync count"

$jobRequest = @{
  prompt = "Create a 1080x1920 tea ceremony promotional poster as a PNG file on the desktop."
  displayTitle = "Tea ceremony poster"
  conversationId = $conversationId
  sourceMessageId = $messageId
  requesterId = "conversation-persistence-smoke"
  routingMode = "supervisor_pipeline"
  maxModelCalls = 20
}
$firstJob = Invoke-JsonPost -Uri "$apiBaseUrl/jobs" -Body $jobRequest
$duplicateJob = Invoke-JsonPost -Uri "$apiBaseUrl/jobs" -Body $jobRequest
Assert-Equal -Actual $duplicateJob.jobId -Expected $firstJob.jobId -Message "source message idempotency"

$job = Invoke-RestMethod -Uri "$apiBaseUrl/jobs/$($firstJob.jobId)" -Headers $apiHeaders
Assert-Equal -Actual $job.conversationId -Expected $conversationId -Message "job conversation link"
Assert-Equal -Actual $job.sourceMessageId -Expected $messageId -Message "job source message link"
Assert-Equal -Actual $job.displayTitle -Expected "Tea ceremony poster" -Message "persisted job title"
Assert-Equal -Actual $job.orchestrationPlan.selectedAgents.Count -Expected 1 -Message "minimum agent count"
Assert-Equal -Actual $job.orchestrationPlan.selectedAgents[0] -Expected "image-agent" -Message "image agent selection"

$workspace = Invoke-RestMethod -Uri "$apiBaseUrl/conversation-workspace" -Headers $apiHeaders
$savedProject = @($workspace.projects | Where-Object { $_.id -eq $projectId })
Assert-Equal -Actual $savedProject.Count -Expected 1 -Message "saved project count"
$savedMessage = @($savedProject[0].conversations[0].messages | Where-Object { $_.id -eq $messageId })
Assert-Equal -Actual $savedMessage.Count -Expected 1 -Message "saved message count"
Assert-Equal -Actual $savedMessage[0].jobId -Expected $firstJob.jobId -Message "message job back-link"

Invoke-RestMethod `
  -Uri "$apiBaseUrl/conversation-projects/$([uri]::EscapeDataString($projectId))" `
  -Method Delete `
  -Headers $apiHeaders | Out-Null
$afterDelete = Invoke-RestMethod -Uri "$apiBaseUrl/conversation-workspace" -Headers $apiHeaders
Assert-True `
  -Condition (-not @($afterDelete.projects | Where-Object { $_.id -eq $projectId }).Count) `
  -Message "deleted project should not be returned"

[pscustomobject]@{
  ok = $true
  marker = $marker
  projectId = $projectId
  conversationId = $conversationId
  messageId = $messageId
  jobId = $firstJob.jobId
  checked = @(
    "workspace_snapshot_sync",
    "job_conversation_link",
    "job_source_message_link",
    "source_message_idempotency",
    "persisted_orchestration_plan",
    "message_job_back_link",
    "soft_delete_visibility"
  )
} | ConvertTo-Json -Depth 5
