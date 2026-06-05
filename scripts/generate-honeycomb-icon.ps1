param(
  [string]$OutputPath = "",
  [string]$SourcePath = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) {
  $OutputPath = Join-Path $root "apps\desktop-app\src-tauri\icons\icon.png"
}
if (-not $SourcePath) {
  $SourcePath = Join-Path $root "docs\assets\honeycomb-logo.png"
}

$size = 1024
$bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$sourceImage = [System.Drawing.Image]::FromFile($SourcePath)
$graphics.DrawImage($sourceImage, 0, 0, $size, $size)

$directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$sourceImage.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated honeycomb icon: $OutputPath"
