$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root ".runtime\m3-real-provider-e2e"
$answersPath = Join-Path $root "examples\m3\interview.answers.example.json"
$configPath = Join-Path $outDir "cluster.config.json"
$envPath = Join-Path $root ".env"

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

function Normalize-DotEnvValue {
  param([string]$Value)

  $trimmed = $Value.Trim()
  if (($trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) -or ($trimmed.StartsWith("'") -and $trimmed.EndsWith("'"))) {
    return $trimmed.Substring(1, $trimmed.Length - 2)
  }

  return $trimmed
}

function Import-DotEnvKeyIfMissing {
  param([string]$Name)

  $current = [Environment]::GetEnvironmentVariable($Name, "Process")
  if (-not [string]::IsNullOrWhiteSpace($current)) {
    return
  }

  if (-not (Test-Path -LiteralPath $envPath)) {
    return
  }

  $pattern = "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$"
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match $pattern) {
      $value = Normalize-DotEnvValue -Value $matches[1]
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        [Environment]::SetEnvironmentVariable($Name, $value, "Process")
      }
      return
    }
  }
}

function Test-ConfiguredEnv {
  param([string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  return -not [string]::IsNullOrWhiteSpace($value)
}

function Wait-ForTerminalStatus {
  param([string]$JobId)

  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 1
    $job = Invoke-RestMethod -Uri "http://localhost:3000/jobs/$JobId"
    if (@("succeeded", "failed", "waiting_for_human", "cancelled") -contains $job.status) {
      return $job
    }
  }

  throw "Timed out waiting for $JobId"
}

Set-Location $root

@(
  "M3_PLANNER_BASE_URL",
  "M3_PLANNER_MODEL",
  "M3_PLANNER_API_KEY",
  "M3_PLANNER_TEMPERATURE",
  "M3_PLANNER_TIMEOUT_SECONDS"
) | ForEach-Object {
  Import-DotEnvKeyIfMissing -Name $_
}

$missing = @(
  "M3_PLANNER_BASE_URL",
  "M3_PLANNER_MODEL",
  "M3_PLANNER_API_KEY"
) | Where-Object { -not (Test-ConfiguredEnv -Name $_) }

if ($missing.Count -gt 0) {
  throw "Missing required M3 real planner environment variables: $($missing -join ', '). Set them in the shell or local .env. Secret values were not printed."
}

$baseUrl = [Environment]::GetEnvironmentVariable("M3_PLANNER_BASE_URL", "Process")
if ($baseUrl -match "api\.example\.com" -or $baseUrl -match "<") {
  throw "M3_PLANNER_BASE_URL still looks like a placeholder. Secret values were not printed."
}

$env:M3_PLANNER_MODE = "openai-compatible"
$env:FEISHU_ADAPTER_ENABLED = "false"
$env:FEISHU_DRY_RUN = "true"
$env:OPENCLAW_AGENT_MODE = "mock"
Remove-Item Env:\DBOS_TEST_CRASH_ONCE_AFTER -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $outDir) {
  Remove-Item -LiteralPath $outDir -Recurse -Force
}

npm run m3:generate -- --answers $answersPath --out $outDir --approve --planner openai-compatible | Out-Host

Assert-True -Condition (Test-Path -LiteralPath $configPath) -Message "cluster.config.json was not generated"

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
Assert-Equal -Actual $config.source.planner -Expected "openai-compatible" -Message "config source planner"
Assert-True -Condition ([bool]$config.source.model) -Message "config source model missing"
Assert-True -Condition (@($config.stages).Count -gt 0) -Message "planner returned no stages"

$configStageAgents = @($config.stages | ForEach-Object { $_.agentId })
Assert-True -Condition ($configStageAgents.Count -gt 0) -Message "config stage agents missing"

$env:AGENT_CLUSTER_CONFIG_PATH = $configPath

npm run dev:stop | Out-Host
npm run dev:start | Out-Host

$body = @{
  prompt = "Use the real-planner generated cluster to run a short mock-mode demo job. Produce a concise final note that names the stage sequence."
  requesterId = "m3-real-provider-smoke"
  maxModelCalls = 20
} | ConvertTo-Json

$created = Invoke-RestMethod -Uri "http://localhost:3000/jobs" -Method Post -ContentType "application/json" -Body $body
$job = Wait-ForTerminalStatus -JobId $created.jobId
Assert-Equal -Actual $job.status -Expected "succeeded" -Message "job terminal status"

$details = Invoke-RestMethod -Uri "http://localhost:3000/jobs/$($created.jobId)/details"
$actualStageAgents = @($details.stages | ForEach-Object { $_.agent_id })

Assert-Equal -Actual $actualStageAgents.Count -Expected $configStageAgents.Count -Message "stage count from real-planner config"
for ($i = 0; $i -lt $configStageAgents.Count; $i++) {
  Assert-Equal -Actual $actualStageAgents[$i] -Expected $configStageAgents[$i] -Message "stage $($i + 1) agent"
}

$clusterPlanEvents = @(
  $details.events | Where-Object {
    $_.event_type -eq "main.pipeline_planned" -and $_.payload.clusterId -eq $config.clusterId
  }
)
Assert-True -Condition ($clusterPlanEvents.Count -gt 0) -Message "real-planner cluster planning event missing"

[pscustomobject]@{
  ok = $true
  clusterConfigPath = $configPath
  clusterId = $config.clusterId
  planner = $config.source.planner
  modelConfigured = $true
  jobId = $created.jobId
  terminalStatus = $job.status
  stageAgents = $actualStageAgents
  checked = @(
    "real_planner_provider_call",
    "generated_cluster_config_validation",
    "load_cluster_config_in_dbos_step",
    "run_demo_job_succeeded"
  )
} | ConvertTo-Json -Depth 4
