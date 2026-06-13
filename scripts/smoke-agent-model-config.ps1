$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "honeycomb-api-token.ps1")
$apiHeaders = Get-HoneycombApiHeaders
$apiBaseUrl = "http://127.0.0.1:3000"
$runtimeDir = Join-Path $root ".runtime"
$serverPath = Join-Path $runtimeDir "agent-model-config-provider.cjs"
$port = 39431 + (Get-Random -Minimum 0 -Maximum 300)
$serverProcess = $null

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

function Safe-SecretName {
  param([string]$Value)
  return ($Value -replace '[^A-Za-z0-9_.-]', '_')
}

try {
  Set-Location $root
  $env:FEISHU_ADAPTER_ENABLED = "false"
  $env:FEISHU_DRY_RUN = "true"
  $env:OPENCLAW_AGENT_MODE = "mock"
  Remove-Item Env:\DBOS_TEST_CRASH_ONCE_AFTER -ErrorAction SilentlyContinue

  if (-not (Test-Path -LiteralPath $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir | Out-Null
  }

  @'
const http = require("node:http");

const port = Number(process.env.SMOKE_PROVIDER_PORT);
const expectedKey = process.env.SMOKE_PROVIDER_API_KEY;

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not_found" } }));
    return;
  }

  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.headers.authorization !== `Bearer ${expectedKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad_key" } }));
      return;
    }

    const parsed = JSON.parse(body || "{}");
    if (parsed.model !== "deepseek-chat") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad_model" } }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
});

server.listen(port, "127.0.0.1");
'@ | Set-Content -LiteralPath $serverPath -Encoding UTF8

  $node = (Get-Command node).Source
  $env:SMOKE_PROVIDER_PORT = [string]$port
  $env:SMOKE_PROVIDER_API_KEY = "sk-agent-model-smoke"
  $serverProcess = Start-Process -FilePath $node -ArgumentList @($serverPath) -PassThru -WindowStyle Hidden

  $healthUrl = "http://127.0.0.1:$port/health"
  for ($i = 0; $i -lt 50; $i++) {
    try {
      Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 | Out-Null
      break
    } catch {
      Start-Sleep -Milliseconds 100
      if ($i -eq 49) {
        throw "Timed out waiting for fake provider server"
      }
    }
  }

  $previousDeepSeekOverride = $env:HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL
  $env:HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL = "http://127.0.0.1:$port/v1"
  npm run dev:start | Out-Host

  $suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
  $openClawRoot = Join-Path $runtimeDir "agent-model-config-openclaw-$suffix"

  $result = Invoke-RestMethod `
    -Uri "$apiBaseUrl/agents/image-agent/model-config" `
    -Method Post `
    -Headers $apiHeaders `
    -ContentType "application/json" `
    -Body (@{
      model = "deepseek-chat"
      apiKey = "sk-agent-model-smoke"
      openClawRootPath = $openClawRoot
    } | ConvertTo-Json -Depth 8)

  Assert-Equal -Actual $result.ok -Expected $true -Message "agent model config response ok"
  Assert-Equal -Actual $result.agent.id -Expected "image-agent" -Message "configured agent id"
  Assert-Equal -Actual $result.agent.providerId -Expected "provider-deepseek" -Message "agent provider id"
  Assert-Equal -Actual $result.agent.model -Expected "deepseek-chat" -Message "agent model"
  Assert-Equal -Actual $result.provider.verificationStatus -Expected "succeeded" -Message "provider verification"
  Assert-Equal -Actual $result.openclawSync.ok -Expected $true -Message "openclaw sync ok"

  $configPath = Join-Path $openClawRoot "agent-model-configs.json"
  Assert-True -Condition (Test-Path -LiteralPath $configPath) -Message "agent model config file missing"
  $agentModelConfigs = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  Assert-Equal -Actual $agentModelConfigs.'image-agent'.providerId -Expected "provider-deepseek" -Message "image-agent provider in OpenClaw config"
  Assert-Equal -Actual $agentModelConfigs.'image-agent'.model -Expected "deepseek-chat" -Message "image-agent model in OpenClaw config"
  Assert-Equal -Actual $agentModelConfigs.'image-agent'.apiKeyConfigured -Expected $true -Message "image-agent key configured in OpenClaw config"

  $secretRoot = if ($env:HONEYCOMB_SECRET_DIR) {
    $env:HONEYCOMB_SECRET_DIR
  } else {
    Join-Path $env:APPDATA "io.agentopenclaw.desktop\honeycomb-secrets"
  }
  $secretPath = Join-Path (Join-Path $secretRoot "providers") "$(Safe-SecretName "provider-deepseek").key"
  Assert-True -Condition (Test-Path -LiteralPath $secretPath) -Message "provider secret file missing"

  [pscustomobject]@{
    ok = $true
    agentId = $result.agent.id
    providerId = $result.provider.id
    model = $result.agent.model
    openClawRoot = $openClawRoot
    checks = @(
      "fake_openai_compatible_provider_started",
      "image_agent_model_config_verified",
      "provider_secret_saved",
      "agent_registry_updated",
      "openclaw_agent_model_config_written"
    )
  } | ConvertTo-Json -Depth 5
} finally {
  if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
  }
  if ($null -eq $previousDeepSeekOverride) {
    Remove-Item Env:\HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL -ErrorAction SilentlyContinue
  } else {
    $env:HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL = $previousDeepSeekOverride
  }
}
