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
$env:FEISHU_ADAPTER_ENABLED = "false"
$env:FEISHU_DRY_RUN = "true"
$env:OPENCLAW_AGENT_MODE = "mock"
Remove-Item Env:\DBOS_TEST_CRASH_ONCE_AFTER -ErrorAction SilentlyContinue

npm run dev:start | Out-Host

$suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
$providerId = "usage-cost-provider-$suffix"
$model = "usage-cost-model-$suffix"

$provider = Invoke-RestMethod `
  -Uri "$apiBaseUrl/providers" `
  -Method Post `
  -Headers $apiHeaders `
  -ContentType "application/json" `
  -Body (@{
    id = $providerId
    displayName = "Usage cost smoke"
    baseUrl = "https://api.example.invalid/v1"
    defaultModel = $model
    metadata = @{
      pricing = @{
        inputPerMillionUsd = 1.5
        outputPerMillionUsd = 2.5
      }
    }
  } | ConvertTo-Json -Depth 8)

$created = Invoke-RestMethod `
  -Uri "$apiBaseUrl/jobs" `
  -Method Post `
  -Headers $apiHeaders `
  -ContentType "application/json" `
  -Body (@{
    prompt = "Runtime usage cost smoke"
    requesterId = "runtime-usage-cost-smoke"
    startWorkflow = $false
  } | ConvertTo-Json)

$env:SMOKE_JOB_ID = $created.jobId
$env:SMOKE_PROVIDER_ID = $provider.id
$env:SMOKE_MODEL = $model

$insertScript = @'
async function main() {
  const { pool } = await import("./packages/db/src/pool");
  const id = `MC-COST-${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
  await pool.query(
    `insert into agent.model_calls (
      id,
      idempotency_key,
      job_id,
      attempt_no,
      action_type,
      agent_id,
      agent_session_id,
      request_hash,
      status,
      response_payload
    ) values ($1, $2, $3, 1, 'runtime-usage-cost-smoke', 'research-agent', 'usage-cost-session', 'hash', 'succeeded', $4::jsonb)`,
    [
      id,
      `runtime-usage-cost-smoke:${id}`,
      process.env.SMOKE_JOB_ID,
      JSON.stringify({
        result: {
          usage: {
            promptTokens: 1000,
            completionTokens: 2000,
            totalTokens: 3000
          }
        },
        route: {
          providerId: process.env.SMOKE_PROVIDER_ID,
          model: process.env.SMOKE_MODEL
        }
      })
    ]
  );
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'@

$insertScript | npx tsx -

$usage = Invoke-RestMethod `
  -Uri "$apiBaseUrl/runtime/usage" `
  -Headers $apiHeaders

Assert-True -Condition ($usage.summary.tokens.totalTokens -ge 3000) -Message "runtime usage should include inserted tokens"
Assert-True -Condition ($usage.summary.cost.estimatedUsd -ge 0.0065) -Message "runtime usage should include estimated cost"

$providerUsage = @($usage.byProvider) | Where-Object { $_.providerId -eq $provider.id -and $_.model -eq $model } | Select-Object -First 1
Assert-True -Condition ($null -ne $providerUsage) -Message "provider usage row should exist"
Assert-Equal -Actual $providerUsage.promptTokens -Expected 1000 -Message "provider prompt token sum"
Assert-Equal -Actual $providerUsage.completionTokens -Expected 2000 -Message "provider completion token sum"
Assert-Equal -Actual $providerUsage.estimatedUsd -Expected 0.0065 -Message "provider estimated cost"
Assert-Equal -Actual $providerUsage.callsWithCost -Expected 1 -Message "provider cost call count"

[pscustomobject]@{
  ok = $true
  providerId = $provider.id
  model = $model
  jobId = $created.jobId
  estimatedUsd = $providerUsage.estimatedUsd
  summaryEstimatedUsd = $usage.summary.cost.estimatedUsd
  checks = @(
    "provider_pricing_metadata_saved",
    "model_call_usage_inserted",
    "runtime_usage_cost_summary",
    "runtime_usage_by_provider_cost"
  )
} | ConvertTo-Json -Depth 4
