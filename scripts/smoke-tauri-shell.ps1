$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root "apps\desktop-app"
$tauriConfigPath = Join-Path $appDir "src-tauri\tauri.conf.json"
$viteConfigPath = Join-Path $appDir "vite.config.ts"
$cargoManifestPath = Join-Path $appDir "src-tauri\Cargo.toml"

function Assert-Path {
  param(
    [string]$Path,
    [string]$Message
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw $Message
  }
}

function Test-CommandExists {
  param([string]$Command)

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $commandInfo = Get-Command $Command
  $ErrorActionPreference = $previousPreference
  return $null -ne $commandInfo
}

function Get-VswherePath {
  $candidatePaths = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
  )

  foreach ($candidatePath in $candidatePaths) {
    if (Test-Path -LiteralPath $candidatePath) {
      return $candidatePath
    }
  }

  return $null
}

function Test-WindowsNativePackagingToolchain {
  if (Test-CommandExists -Command "cl") {
    return [pscustomobject]@{
      available = $true
      source = "path"
      msvc = $true
      windowsSdk = $true
    }
  }

  $vswherePath = Get-VswherePath
  $vsInstallPath = $null
  if ($vswherePath) {
    $vsInstallPath = & $vswherePath -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
  }

  $hasMsvcTools = $false
  if ($vsInstallPath) {
    $clPath = Get-ChildItem -Path (Join-Path $vsInstallPath "VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
    $hasMsvcTools = $null -ne $clPath
  }

  $windowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $rcPath = Get-ChildItem -Path (Join-Path $windowsKitsRoot "*\x64\rc.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
  $hasWindowsSdk = $null -ne $rcPath

  return [pscustomobject]@{
    available = $hasMsvcTools -and $hasWindowsSdk
    source = if ($vsInstallPath) { "vswhere" } else { "missing" }
    msvc = $hasMsvcTools
    windowsSdk = $hasWindowsSdk
  }
}

Set-Location $root

Assert-Path -Path (Join-Path $appDir "package.json") -Message "desktop package.json missing"
Assert-Path -Path (Join-Path $appDir "index.html") -Message "desktop index.html missing"
Assert-Path -Path (Join-Path $appDir "src\main.tsx") -Message "desktop React entry missing"
Assert-Path -Path (Join-Path $appDir "src\api.ts") -Message "desktop API client missing"
Assert-Path -Path $viteConfigPath -Message "desktop Vite config missing"
Assert-Path -Path $tauriConfigPath -Message "Tauri config missing"
Assert-Path -Path $cargoManifestPath -Message "Cargo.toml missing"
Assert-Path -Path (Join-Path $appDir "src-tauri\src\main.rs") -Message "Tauri main.rs missing"

$packageJson = Get-Content -Raw -LiteralPath (Join-Path $appDir "package.json") | ConvertFrom-Json
$tauriConfig = Get-Content -Raw -LiteralPath $tauriConfigPath | ConvertFrom-Json
$viteConfig = Get-Content -Raw -LiteralPath $viteConfigPath
$cargoManifest = Get-Content -Raw -LiteralPath $cargoManifestPath

if ($packageJson.scripts."tauri:dev" -ne "tauri dev") {
  throw "tauri:dev script missing"
}

if ($packageJson.scripts."tauri:build" -ne "tauri build") {
  throw "tauri:build script missing"
}

if ($tauriConfig.productName -ne "Agent OpenClaw") {
  throw "Unexpected Tauri productName"
}

if ($tauriConfig.identifier -ne "io.agentopenclaw.desktop") {
  throw "Unexpected Tauri identifier"
}

if ($tauriConfig.build.devUrl -ne "http://localhost:5173") {
  throw "Unexpected Tauri devUrl"
}

if ($tauriConfig.build.frontendDist -ne "../dist") {
  throw "Unexpected Tauri frontendDist"
}

if (-not $viteConfig.Contains('host: "127.0.0.1"')) {
  throw "Unexpected Vite dev server host"
}

if (-not $viteConfig.Contains('port: 5173')) {
  throw "Unexpected Vite dev server port"
}

if (-not $viteConfig.Contains('strictPort: true')) {
  throw "Vite strictPort must stay enabled"
}

if (-not $cargoManifest.Contains('name = "agent-openclaw"')) {
  throw "Unexpected Cargo package name"
}

if (-not $cargoManifest.Contains('tauri = { version = "2"')) {
  throw "Tauri v2 dependency missing from Cargo manifest"
}

$hasCargo = Test-CommandExists -Command "cargo"
$hasRustc = Test-CommandExists -Command "rustc"
$isWindowsHost = $env:OS -eq "Windows_NT"
$windowsToolchain = if ($isWindowsHost) { Test-WindowsNativePackagingToolchain } else { $null }
$hasNativePackagingToolchain = if ($isWindowsHost) { $windowsToolchain.available } else { $true }
$nativePackagingToolchain = if (-not $isWindowsHost) {
  "not_required_for_this_host"
} elseif ($hasNativePackagingToolchain) {
  "available"
} else {
  "missing_msvc_or_windows_sdk"
}
$packagingRunnable = $hasCargo -and $hasRustc -and $hasNativePackagingToolchain

[pscustomobject]@{
  ok = $true
  appDir = $appDir
  tauriConfig = $tauriConfigPath
  rustToolchain = if ($hasCargo -and $hasRustc) { "available" } else { "missing" }
  buildRunnable = $packagingRunnable
  nativePackagingToolchain = $nativePackagingToolchain
  packagingRunnable = $packagingRunnable
  nativePackagingDetails = if ($isWindowsHost) { $windowsToolchain } else { $null }
  checked = @(
    "react_shell_files",
    "api_client",
    "vite_dev_server_config",
    "tauri_config",
    "desktop_package_scripts",
    "cargo_manifest",
    "rust_toolchain_probe",
    "native_packaging_toolchain_probe"
  )
} | ConvertTo-Json -Depth 4
