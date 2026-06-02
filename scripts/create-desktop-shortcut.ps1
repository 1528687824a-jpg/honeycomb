param(
  [string]$ShortcutName = "Agent OpenClaw"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "$ShortcutName.lnk"
$startScript = Join-Path $root "scripts\start-desktop-tryout.ps1"
$iconPath = Join-Path $root "apps\desktop-app\src-tauri\icons\icon.ico"

if (-not (Test-Path -LiteralPath $startScript)) {
  throw "Start script not found: $startScript"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$startScript`""
$shortcut.WorkingDirectory = $root
$shortcut.Description = "Start Agent OpenClaw local backend and desktop app"
if (Test-Path -LiteralPath $iconPath) {
  $shortcut.IconLocation = $iconPath
}
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Output "Created desktop shortcut: $shortcutPath"
