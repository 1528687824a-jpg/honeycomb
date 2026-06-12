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

Set-Location $root
$suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
$runtimeRoot = Join-Path $root ".runtime\openclaw-control-smoke-$suffix"

$controlEnvKeys = @(
  "HONEYCOMB_OPENCLAW_STATUS_COMMAND",
  "HONEYCOMB_OPENCLAW_START_COMMAND",
  "HONEYCOMB_OPENCLAW_RESTART_COMMAND",
  "HONEYCOMB_OPENCLAW_STOP_COMMAND"
)
foreach ($key in $controlEnvKeys) {
  Remove-Item "Env:\$key" -ErrorAction SilentlyContinue
}

$env:FEISHU_ADAPTER_ENABLED = "false"
$env:FEISHU_DRY_RUN = "true"
$env:OPENCLAW_AGENT_MODE = "mock"
$env:HONEYCOMB_OPENCLAW_RUNTIME_DIR = $runtimeRoot
Remove-Item Env:\DBOS_TEST_CRASH_ONCE_AFTER -ErrorAction SilentlyContinue

npm run dev:start | Out-Host

$body = @{ rootPath = $runtimeRoot } | ConvertTo-Json
$start = Invoke-RestMethod `
  -Uri "$apiBaseUrl/openclaw/runtime/start" `
  -Method Post `
  -Headers $apiHeaders `
  -ContentType "application/json" `
  -Body $body

Assert-Equal -Actual $start.configured -Expected $true -Message "start configured"
Assert-Equal -Actual $start.ok -Expected $true -Message "start ok"
Assert-Equal -Actual $start.command -Expected "builtin:openclaw-runtime-start" -Message "start command"
Assert-Equal -Actual $start.message -Expected "runtime_prepared" -Message "start message"
Assert-True -Condition (Test-Path -LiteralPath (Join-Path $runtimeRoot "agents")) -Message "agents directory missing"
Assert-True -Condition (Test-Path -LiteralPath (Join-Path $runtimeRoot "workspace")) -Message "workspace directory missing"
Assert-True -Condition (Test-Path -LiteralPath (Join-Path $runtimeRoot "config")) -Message "config directory missing"

$encodedRoot = [System.Uri]::EscapeDataString($runtimeRoot)
$status = Invoke-RestMethod `
  -Uri "$apiBaseUrl/openclaw/runtime/control?rootPath=$encodedRoot" `
  -Headers $apiHeaders

Assert-Equal -Actual $status.manageable -Expected $true -Message "control manageable"
Assert-Equal -Actual $status.commandMode -Expected "builtin" -Message "control command mode"
Assert-Equal -Actual $status.commands.start -Expected $true -Message "control start command availability"
Assert-Equal -Actual $status.envCommands.start -Expected $false -Message "control env command should be absent"
Assert-Equal -Actual $status.runtime.status -Expected "ready" -Message "runtime status after start"

$restart = Invoke-RestMethod `
  -Uri "$apiBaseUrl/openclaw/runtime/restart" `
  -Method Post `
  -Headers $apiHeaders `
  -ContentType "application/json" `
  -Body $body
Assert-Equal -Actual $restart.ok -Expected $true -Message "restart ok"
Assert-Equal -Actual $restart.command -Expected "builtin:openclaw-runtime-restart" -Message "restart command"

$stop = Invoke-RestMethod `
  -Uri "$apiBaseUrl/openclaw/runtime/stop" `
  -Method Post `
  -Headers $apiHeaders `
  -ContentType "application/json" `
  -Body $body
Assert-Equal -Actual $stop.ok -Expected $true -Message "stop ok"
Assert-Equal -Actual $stop.command -Expected "builtin:openclaw-runtime-stop" -Message "stop command"

[pscustomobject]@{
  ok = $true
  runtimeRoot = $runtimeRoot
  commandMode = $status.commandMode
  checks = @(
    "builtin_runtime_start",
    "runtime_directories_prepared",
    "runtime_control_status_uses_builtin",
    "builtin_runtime_restart",
    "builtin_runtime_stop"
  )
} | ConvertTo-Json -Depth 4
