$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dockerCli = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$env:Path = "C:\Program Files\Docker\Docker\resources\bin;$env:Path"

Set-Location $root

if (Test-Path ".runtime\pids.json") {
  $pids = Get-Content ".runtime\pids.json" | ConvertFrom-Json
  foreach ($pidValue in @($pids.workerPid, $pids.apiPid)) {
    if ($pidValue) {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item ".runtime\pids.json" -Force -ErrorAction SilentlyContinue
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

if (Test-Path -LiteralPath $dockerCli) {
  & $dockerCli compose down --remove-orphans
}

Write-Output "Dev services stopped"
