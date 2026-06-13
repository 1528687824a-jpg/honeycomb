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

function Invoke-Json {
  param(
    [string]$Uri,
    [string]$Method,
    [object]$Body
  )

  Invoke-RestMethod `
    -Uri $Uri `
    -Method $Method `
    -Headers $apiHeaders `
    -ContentType "application/json" `
    -Body ($Body | ConvertTo-Json -Depth 10)
}

function Read-ErrorBody {
  param([object]$ErrorRecord)

  if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
    return $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json
  }

  $response = $ErrorRecord.Exception.Response
  if (-not $response) {
    throw $ErrorRecord
  }

  $stream = $response.GetResponseStream()
  if (-not $stream) {
    throw $ErrorRecord
  }

  $reader = [System.IO.StreamReader]::new($stream)
  try {
    return $reader.ReadToEnd() | ConvertFrom-Json
  } finally {
    $reader.Dispose()
  }
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
const chatModels = new Set((process.env.SMOKE_PROVIDER_CHAT_MODELS || "").split(",").filter(Boolean));
const imageModel = process.env.SMOKE_PROVIDER_IMAGE_MODEL;
const videoModel = process.env.SMOKE_PROVIDER_VIDEO_MODEL;

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      resolve(JSON.parse(body || "{}"));
    });
  });
}

function assertAuth(request, response) {
  if (request.headers.authorization !== `Bearer ${expectedKey}`) {
    send(response, 401, { error: { message: "bad_key" } });
    return false;
  }
  return true;
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    send(response, 200, { ok: true });
    return;
  }

  if (request.method !== "POST") {
    send(response, 404, { error: { message: "not_found" } });
    return;
  }

  if (!assertAuth(request, response)) {
    return;
  }

  const parsed = await readBody(request);

  if (request.url === "/v1/chat/completions") {
    if (!chatModels.has(parsed.model)) {
      send(response, 400, { error: { message: "bad_model" } });
      return;
    }
    send(response, 200, {
      choices: [{ message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    });
    return;
  }

  if (request.url === "/v1/images/generations") {
    if (parsed.model !== imageModel) {
      send(response, 400, { error: { message: "The parameter `model` specified in the request is not valid." } });
      return;
    }
    if (!parsed.prompt) {
      send(response, 400, { error: { message: "Missing required parameter: prompt." } });
      return;
    }
    send(response, 200, { data: [{ url: "https://example.invalid/smoke.png" }] });
    return;
  }

  if (request.url === "/v1/contents/generations/tasks") {
    if (parsed.model !== videoModel) {
      send(response, 400, { error: { message: "The parameter `model` specified in the request is not valid." } });
      return;
    }
    if (!parsed.content) {
      send(response, 400, { error: { message: "Missing required parameter: content." } });
      return;
    }
    send(response, 200, { id: "video-task-smoke" });
    return;
  }

  send(response, 404, { error: { message: "not_found" } });
});

server.listen(port, "127.0.0.1");
'@ | Set-Content -LiteralPath $serverPath -Encoding UTF8

  $node = (Get-Command node).Source
  $suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
  $providerId = "agent-config-smoke-provider-$suffix"
  $smokeSecretDir = Join-Path $runtimeDir "agent-model-config-secrets-$suffix"
  $chatModel = "smoke-chat-model-$suffix"
  $imageModel = "seedream-smoke-model-$suffix"
  $videoModel = "seedance-smoke-model-$suffix"
  $apiKey = "sk-agent-model-smoke"
  $env:SMOKE_PROVIDER_PORT = [string]$port
  $env:SMOKE_PROVIDER_API_KEY = $apiKey
  $env:SMOKE_PROVIDER_CHAT_MODELS = $chatModel
  $env:SMOKE_PROVIDER_IMAGE_MODEL = $imageModel
  $env:SMOKE_PROVIDER_VIDEO_MODEL = $videoModel
  $env:HONEYCOMB_SECRET_DIR = $smokeSecretDir
  New-Item -ItemType Directory -Force -Path $smokeSecretDir | Out-Null
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

  npm run dev:start | Out-Host

  $openClawRoot = Join-Path $runtimeDir "agent-model-config-openclaw-$suffix"

  Invoke-Json `
    -Uri "$apiBaseUrl/providers" `
    -Method Post `
    -Body @{
      id = $providerId
      displayName = "Agent config smoke provider"
      baseUrl = "http://127.0.0.1:$port/v1"
      defaultModel = $chatModel
      metadata = @{ smoke = $true }
    } | Out-Null

  $agentSpecs = @(
    @{ id = "agent-config-smoke-research-$suffix"; role = "research"; model = $chatModel; providerId = $providerId; tools = @("web_research") },
    @{ id = "agent-config-smoke-writer-$suffix"; role = "writing"; model = $chatModel; providerId = $providerId; tools = @("drafting") },
    @{ id = "agent-config-smoke-test-$suffix"; role = "review"; model = $chatModel; providerId = $providerId; tools = @("quality_gate") },
    @{ id = "agent-config-smoke-image-$suffix"; role = "image"; model = $imageModel; providerId = $providerId; tools = @("image_generation") },
    @{ id = "agent-config-smoke-video-$suffix"; role = "video"; model = $videoModel; providerId = $providerId; tools = @("video_generation") }
  )

  foreach ($spec in $agentSpecs) {
    $agentBody = @{
      id = $spec.id
      displayName = "Agent Config Smoke $($spec.role)"
      agentRole = $spec.role
      required = $false
      enabled = $true
      tools = $spec.tools
      metadata = @{ openclawAgentId = $spec.id; smoke = $true }
    }
    if ($spec.providerId) {
      $agentBody.providerId = $spec.providerId
    }

    Invoke-Json `
      -Uri "$apiBaseUrl/agents" `
      -Method Post `
      -Body $agentBody | Out-Null

    $saveBody = @{
      model = $spec.model
      apiKey = $apiKey
      openClawRootPath = $openClawRoot
    }
    if ($spec.providerId) {
      $saveBody.providerId = $spec.providerId
    }

    $result = Invoke-Json `
      -Uri "$apiBaseUrl/agents/$($spec.id)/model-config" `
      -Method Post `
      -Body $saveBody

    Assert-Equal -Actual $result.ok -Expected $true -Message "$($spec.role) agent model config response ok"
    Assert-Equal -Actual $result.agent.id -Expected $spec.id -Message "$($spec.role) configured agent id"
    Assert-Equal -Actual $result.agent.model -Expected $spec.model -Message "$($spec.role) agent model"
    Assert-Equal -Actual $result.provider.verificationStatus -Expected "succeeded" -Message "$($spec.role) provider verification"
    Assert-Equal -Actual $result.openclawSync.ok -Expected $true -Message "$($spec.role) openclaw sync ok"
  }

  $mismatchAgentId = "agent-config-smoke-mismatch-$suffix"
  Invoke-Json `
    -Uri "$apiBaseUrl/agents" `
    -Method Post `
    -Body @{
      id = $mismatchAgentId
      displayName = "Agent Config Smoke Mismatch"
      agentRole = "research"
      required = $false
      enabled = $true
      providerId = $providerId
      tools = @("web_research")
      metadata = @{ openclawAgentId = $mismatchAgentId; smoke = $true }
    } | Out-Null

  try {
    Invoke-Json `
      -Uri "$apiBaseUrl/agents/$mismatchAgentId/model-config" `
      -Method Post `
      -Body @{
        model = $imageModel
        apiKey = $apiKey
        providerId = $providerId
        openClawRootPath = $openClawRoot
      } | Out-Null
    throw "research agent accepted an image generation model"
  } catch {
    $errorBody = Read-ErrorBody -ErrorRecord $_
    Assert-Equal -Actual $errorBody.reason -Expected "agent_model_kind_mismatch" -Message "research agent image model mismatch reason"
  }

  $configPath = Join-Path $openClawRoot "agent-model-configs.json"
  Assert-True -Condition (Test-Path -LiteralPath $configPath) -Message "agent model config file missing"
  $agentModelConfigs = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  foreach ($spec in $agentSpecs) {
    $written = $agentModelConfigs.($spec.id)
    Assert-Equal -Actual $written.model -Expected $spec.model -Message "$($spec.role) model in OpenClaw config"
    Assert-Equal -Actual $written.apiKeyConfigured -Expected $true -Message "$($spec.role) key configured in OpenClaw config"
  }

  $secretRoot = if ($env:HONEYCOMB_SECRET_DIR) {
    $env:HONEYCOMB_SECRET_DIR
  } else {
    Join-Path $env:APPDATA "io.agentopenclaw.desktop\honeycomb-secrets"
  }
  $secretPath = Join-Path (Join-Path $secretRoot "providers") "$(Safe-SecretName $providerId).key"
  Assert-True -Condition (Test-Path -LiteralPath $secretPath) -Message "chat provider secret file missing"

  [pscustomobject]@{
    ok = $true
    openClawRoot = $openClawRoot
    checkedAgents = $agentSpecs.id
    checks = @(
      "research_writer_test_chat_models_verified",
      "image_agent_seedream_verified_via_image_generation_api",
      "video_agent_seedance_verified_via_video_generation_api",
      "media_model_rejected_on_non_media_agent",
      "provider_secrets_saved",
      "agent_registry_updated",
      "openclaw_agent_model_config_written"
    )
  } | ConvertTo-Json -Depth 5
} finally {
  if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
  }
  if ($suffix) {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if ($docker) {
      $sql = "delete from agent.agent_configs where id like 'agent-config-smoke-%-$suffix'; delete from agent.model_providers where id = 'agent-config-smoke-provider-$suffix';"
      & $docker.Source exec agent-openclaw-postgres psql -U temporal -d temporal -v ON_ERROR_STOP=1 -c $sql | Out-Null
    }
  }
  Remove-Item Env:\SMOKE_PROVIDER_MODEL -ErrorAction SilentlyContinue
  Remove-Item Env:\SMOKE_PROVIDER_CHAT_MODELS -ErrorAction SilentlyContinue
  Remove-Item Env:\SMOKE_PROVIDER_IMAGE_MODEL -ErrorAction SilentlyContinue
  Remove-Item Env:\SMOKE_PROVIDER_VIDEO_MODEL -ErrorAction SilentlyContinue
  Remove-Item Env:\SMOKE_PROVIDER_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:\SMOKE_PROVIDER_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:\HONEYCOMB_SECRET_DIR -ErrorAction SilentlyContinue
}
