function Initialize-HoneycombApiToken {
  param(
    [string]$TokenPath = (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "io.agentopenclaw.desktop\honeycomb-api-token.txt")
  )

  $tokenDir = Split-Path -Parent $TokenPath
  New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null

  if (-not (Test-Path -LiteralPath $TokenPath)) {
    $tokenBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $rng.GetBytes($tokenBytes)
    } finally {
      $rng.Dispose()
    }

    $token = [Convert]::ToBase64String($tokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    Set-Content -LiteralPath $TokenPath -Value $token -Encoding ASCII
  }

  $tokenValue = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
  if (-not $tokenValue) {
    throw "Honeycomb API token is empty: $TokenPath"
  }

  $env:HONEYCOMB_API_TOKEN = $tokenValue
  $env:VITE_HONEYCOMB_API_TOKEN = $tokenValue

  [pscustomobject]@{
    TokenPath = $TokenPath
    Configured = $true
  }
}

function Get-HoneycombApiHeaders {
  if (-not $env:HONEYCOMB_API_TOKEN) {
    Initialize-HoneycombApiToken | Out-Null
  }

  return @{
    Authorization = "Bearer $env:HONEYCOMB_API_TOKEN"
  }
}
