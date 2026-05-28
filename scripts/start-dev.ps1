$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dockerCli = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$env:Path = "C:\Program Files\Docker\Docker\resources\bin;$env:Path"

if (-not (Test-Path -LiteralPath $dockerCli)) {
  throw "Docker CLI not found at $dockerCli"
}

function Test-DockerReady {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $dockerCli info *> $null
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  return $exitCode -eq 0
}

if (-not (Test-DockerReady)) {
  if (-not (Test-Path -LiteralPath $dockerDesktop)) {
    throw "Docker Desktop not found at $dockerDesktop"
  }

  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden

  $ready = $false
  for ($i = 1; $i -le 100; $i++) {
    Start-Sleep -Seconds 3
    if (Test-DockerReady) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    throw "Docker daemon did not become ready"
  }
}

Set-Location $root
& $dockerCli compose up -d --remove-orphans postgres
if ($LASTEXITCODE -ne 0) {
  throw "docker compose up failed"
}

$postgresReady = $false
for ($i = 1; $i -le 60; $i++) {
  $health = & $dockerCli inspect -f "{{.State.Health.Status}}" agent-openclaw-postgres 2>$null
  if ($LASTEXITCODE -eq 0 -and $health -eq "healthy") {
    $postgresReady = $true
    break
  }
  Start-Sleep -Seconds 2
}

if (-not $postgresReady) {
  throw "Postgres did not become healthy"
}

npm run db:migrate
if ($LASTEXITCODE -ne 0) {
  throw "Database migration failed"
}

New-Item -ItemType Directory -Force -Path ".runtime", "logs" | Out-Null

if (Test-Path ".runtime\pids.json") {
  $pids = Get-Content ".runtime\pids.json" | ConvertFrom-Json
  foreach ($pidValue in @($pids.workerPid, $pids.apiPid)) {
    if ($pidValue) {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
  }
}

$managedProcesses = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match "apps[/\\]dbos-worker[/\\]src[/\\]worker\.ts" -or
  $_.CommandLine -match "apps[/\\]temporal-worker[/\\]src[/\\]worker\.ts" -or
  $_.CommandLine -match "apps[/\\]orchestrator-api[/\\]src[/\\]server\.ts"
}
foreach ($process in $managedProcesses) {
  if ($process.ProcessId -ne $PID) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$port3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $port3000) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
}

$apiCmd = "cd '$root'; npm run dev:api *> '$root\logs\api.log'"

$api = Start-Process -FilePath powershell -WindowStyle Hidden -PassThru -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  $apiCmd
)

@{
  apiPid = $api.Id
} | ConvertTo-Json | Set-Content ".runtime\pids.json"

Start-Sleep -Seconds 5

Write-Output "Dev services started"
Write-Output "API: http://localhost:3000"
Get-Content ".runtime\pids.json"
