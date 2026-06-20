$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $appRoot ".runtime"
$launchLog = Join-Path $runtimeDir "animation-preview-launch.log"
$previewOut = Join-Path $runtimeDir "animation-preview.out.log"
$previewErr = Join-Path $runtimeDir "animation-preview.err.log"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Write-LaunchLog {
  param([string]$Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Encoding UTF8 -Path $launchLog -Value "[$timestamp] $Message"
}

function Send-PreviewFocus {
  param([int]$Port = 48618)

  $client = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $task = $client.ConnectAsync("127.0.0.1", $Port)
    if (-not ($task.Wait(450) -and $client.Connected)) {
      return $false
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("focus")
    $stream = $client.GetStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Dispose()
    return $true
  } catch {
    return $false
  } finally {
    if ($client) {
      $client.Dispose()
    }
  }
}

function Stop-StalePreviewDevServer {
  $listeners = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $processId = [int]$listener.OwningProcess
    if ($processId -le 0) {
      continue
    }

    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $processInfo) {
      continue
    }

    $commandLine = [string]$processInfo.CommandLine
    $belongsToPreview =
      $commandLine -like "*D:\honeycomb\apps\desktop-app*" -or
      $commandLine -like "*vite\bin\vite.js*" -or
      $commandLine -like "*@tauri-apps*"

    if ($belongsToPreview) {
      Write-LaunchLog "Stopping stale preview dev server on 5173: pid=$processId command=$commandLine"
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Show-LaunchFailure {
  param([string]$Reason)

  Add-Type -AssemblyName System.Windows.Forms
  $message = "Honeycomb animation preview did not start." +
    [Environment]::NewLine + [Environment]::NewLine +
    $Reason +
    [Environment]::NewLine + [Environment]::NewLine +
    "Log files:" +
    [Environment]::NewLine +
    $launchLog +
    [Environment]::NewLine +
    $previewOut +
    [Environment]::NewLine +
    $previewErr
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    "Honeycomb Animation Preview Failed",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
}

try {
  Write-LaunchLog "Launcher started."

  if (Send-PreviewFocus) {
    Write-LaunchLog "Focused existing animation preview window."
    exit 0
  }

  Stop-StalePreviewDevServer
  Start-Sleep -Milliseconds 800

  if (Send-PreviewFocus) {
    Write-LaunchLog "Focused animation preview window after stale server cleanup."
    exit 0
  }

  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Write-LaunchLog "Starting animation preview via npm: $npm"

  $process = Start-Process `
    -FilePath $npm `
    -ArgumentList @("--prefix", $appRoot, "run", "animation:preview") `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $previewOut `
    -RedirectStandardError $previewErr `
    -PassThru

  for ($attempt = 0; $attempt -lt 70; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Send-PreviewFocus) {
      Write-LaunchLog "Animation preview started and focused. launcherPid=$($process.Id)"
      exit 0
    }
    if ($process.HasExited) {
      Write-LaunchLog "npm preview process exited early. exitCode=$($process.ExitCode)"
      break
    }
  }

  Show-LaunchFailure "The launcher process exited early, or no preview window opened within 35 seconds."
  exit 1
} catch {
  Write-LaunchLog "Launcher failed: $($_.Exception.Message)"
  Show-LaunchFailure $_.Exception.Message
  exit 1
}
