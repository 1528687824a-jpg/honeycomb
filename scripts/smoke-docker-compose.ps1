$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$docker = "docker"
$composeProject = "agent-openclaw-smoke"

function Invoke-DockerCompose {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & $docker compose -p $composeProject @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose $($Arguments -join ' ') failed"
  }
}

function Invoke-Json {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [string]$Method = "Get",
    [object]$Body = $null
  )

  if ($Body) {
    return Invoke-RestMethod -Uri $Uri -Method $Method -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 10)
  }

  return Invoke-RestMethod -Uri $Uri -Method $Method
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

function Wait-ForHealth {
  for ($i = 0; $i -lt 90; $i++) {
    try {
      $health = Invoke-Json -Uri "http://localhost:3000/health"
      if ($health.ok -eq $true) {
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }

  throw "Timed out waiting for compose API health"
}

function Wait-ForTerminalStatus {
  param(
    [string]$JobId
  )

  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $job = Invoke-Json -Uri "http://localhost:3000/jobs/$JobId"
    if (@("succeeded", "failed", "waiting_for_human", "cancelled") -contains $job.status) {
      return $job
    }
  }

  throw "Timed out waiting for $JobId"
}

Set-Location $root

try {
  npm run dev:stop | Out-Host
  Invoke-DockerCompose -Arguments @("down", "--remove-orphans", "-v")
  Invoke-DockerCompose -Arguments @("up", "-d", "--build")
  Wait-ForHealth

  $created = Invoke-Json `
    -Uri "http://localhost:3000/jobs" `
    -Method "Post" `
    -Body @{
      prompt = "Docker Compose smoke: run the mock platform quickstart job"
      requesterId = "docker-compose-smoke"
    }

  Assert-True -Condition ([bool]$created.jobId) -Message "jobId missing"
  Assert-Equal -Actual $created.ingressOrigin -Expected "http" -Message "created ingress origin"

  $job = Wait-ForTerminalStatus -JobId $created.jobId
  Assert-Equal -Actual $job.status -Expected "succeeded" -Message "job terminal status"
  Assert-Equal -Actual $job.ingressOrigin -Expected "http" -Message "job ingress origin"

  $messages = Invoke-Json -Uri "http://localhost:3000/jobs/$($created.jobId)/messages"
  Assert-True -Condition (@($messages.messages).Count -gt 0) -Message "expected message chain"

  Invoke-DockerCompose -Arguments @("down", "--remove-orphans")
  Invoke-DockerCompose -Arguments @("up", "-d")
  Wait-ForHealth

  $persisted = Invoke-Json -Uri "http://localhost:3000/jobs/$($created.jobId)"
  Assert-Equal -Actual $persisted.status -Expected "succeeded" -Message "persisted job status after restart"

  [pscustomobject]@{
    ok = $true
    jobId = $created.jobId
    terminalStatus = $job.status
    ingressOrigin = $job.ingressOrigin
    messageCount = @($messages.messages).Count
    persistenceCheck = "passed"
    checked = @(
      "compose_up_build",
      "http_create_job",
      "poll_succeeded",
      "get_messages",
      "compose_restart_persistence"
    )
  } | ConvertTo-Json -Depth 4
} catch {
  docker compose -p $composeProject logs --tail=200 | Out-Host
  throw
} finally {
  docker compose -p $composeProject down --remove-orphans -v | Out-Host
}
