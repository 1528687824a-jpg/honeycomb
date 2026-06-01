# M3 Real Provider Operator Guide

This guide helps an operator run the M3 config-generation pipeline against a
real OpenAI-compatible chat-completions provider, then prove the generated
cluster can execute a mock-mode job through DBOS.

The smoke does not print secret values.

## What The Smoke Proves

```text
provider API key works
provider returns a planner JSON object
planner roles map to the local role catalog
cluster.config.json is generated
orchestrator loads that generated cluster
mock-mode DBOS job executes the generated stage sequence
```

This is the current highest-value alpha gate for M3. The fake-provider smoke
already proves plumbing. This smoke proves a real planner can generate a
runnable cluster.

## Required Variables

Set these in the current shell or local `.env`:

```text
M3_PLANNER_MODE=openai-compatible
M3_PLANNER_BASE_URL=<provider base URL>
M3_PLANNER_MODEL=<provider model or endpoint id>
M3_PLANNER_API_KEY=<secret>
```

Optional:

```text
M3_PLANNER_TEMPERATURE=0.2
M3_PLANNER_TIMEOUT_SECONDS=60
```

`M3_PLANNER_BASE_URL` should be the provider base path. The generator appends
`/chat/completions` unless the value already ends with `/chat/completions`.

## Provider Templates

PowerShell, OpenAI:

```powershell
$env:M3_PLANNER_MODE='openai-compatible'
$env:M3_PLANNER_BASE_URL='https://api.openai.com/v1'
$env:M3_PLANNER_MODEL='<openai-model-id>'
$env:M3_PLANNER_API_KEY='<secret>'
```

PowerShell, DeepSeek:

```powershell
$env:M3_PLANNER_MODE='openai-compatible'
$env:M3_PLANNER_BASE_URL='https://api.deepseek.com'
$env:M3_PLANNER_MODEL='<deepseek-model-id>'
$env:M3_PLANNER_API_KEY='<secret>'
```

PowerShell, Volcengine Ark:

```powershell
$env:M3_PLANNER_MODE='openai-compatible'
$env:M3_PLANNER_BASE_URL='https://ark.cn-beijing.volces.com/api/v3'
$env:M3_PLANNER_MODEL='<ark-model-or-endpoint-id>'
$env:M3_PLANNER_API_KEY='<secret>'
```

Bash:

```bash
export M3_PLANNER_MODE='openai-compatible'
export M3_PLANNER_BASE_URL='https://api.openai.com/v1'
export M3_PLANNER_MODEL='<model-id>'
export M3_PLANNER_API_KEY='<secret>'
```

Use the exact model or endpoint id from the provider console. For Ark, that may
be a provisioned endpoint id rather than a generic model family name.

## Run It

From the repo root:

```powershell
npm run smoke:m3-real-provider
```

Expected success shape:

```json
{
  "ok": true,
  "clusterConfigPath": ".../.runtime/m3-real-provider-e2e/cluster.config.json",
  "planner": "openai-compatible",
  "modelConfigured": true,
  "jobId": "JOB-...",
  "terminalStatus": "succeeded",
  "checked": [
    "real_planner_provider_call",
    "generated_cluster_config_validation",
    "load_cluster_config_in_dbos_step",
    "run_demo_job_succeeded"
  ]
}
```

Generated output stays local:

```text
.runtime/m3-real-provider-e2e/cluster.config.json
.runtime/m3-real-provider-e2e/preview.md
.runtime/m3-real-provider-e2e/agents/*/AGENTS.md
```

Do not commit generated output unless it is intentionally promoted to an
example with secrets removed.

## Fast Preflight

Run the CI-safe fake-provider proof first when you are unsure whether a failure
is local code or provider configuration:

```powershell
npm run smoke:m3-real-planner
```

If this passes but `smoke:m3-real-provider` fails, focus on provider URL, key,
model id, quota, or provider response shape.

## Failure Triage

```text
Missing required M3 real planner environment variables:
  Cause:
    One or more of M3_PLANNER_BASE_URL, M3_PLANNER_MODEL, M3_PLANNER_API_KEY is
    missing from both the shell and local .env.
  Fix:
    Set all three required variables. Keep keys local and do not paste them
    into chat, docs, or issues.

M3_PLANNER_BASE_URL still looks like a placeholder:
  Cause:
    The value is still api.example.com or contains angle-bracket placeholder
    text.
  Fix:
    Replace it with the real provider base URL.

401 / 403 / invalid api key:
  Cause:
    Wrong key, wrong provider account, disabled key, or the key does not belong
    to the base URL you configured.
  Fix:
    Regenerate or copy the provider key again. Verify the provider dashboard
    shows the same region/account as the base URL.

404 / route not found:
  Cause:
    Base URL has the wrong prefix or already includes an incompatible suffix.
    The generator appends /chat/completions when needed.
  Fix:
    Use the provider base path, for example https://api.openai.com/v1 or
    https://ark.cn-beijing.volces.com/api/v3.

model not found / endpoint not found:
  Cause:
    M3_PLANNER_MODEL does not match a model id or endpoint id enabled in the
    provider account.
  Fix:
    Copy the exact id from the provider console. For Ark, check whether the
    provider expects an endpoint id.

quota / rate limit:
  Cause:
    The provider account has no balance, insufficient quota, or a temporary
    rate limit.
  Fix:
    Add quota, wait, or use a cheaper/smaller planner model. Then rerun the
    smoke.

Planner response did not contain a JSON object:
  Cause:
    The provider returned prose or a tool-call shape instead of extractable
    JSON in choices[0].message.content.
  Fix:
    Lower temperature, try a stronger instruction-following model, or inspect
    .runtime/m3-real-provider-e2e/preview.md and the local error output. Do not
    paste full provider payloads into public docs.

Planner response must include at least one stage:
  Cause:
    The provider returned a top-level object without stages[] or returned an
    empty stage list.
  Fix:
    Rerun with lower temperature or a different model. The planner contract is
    documented in docs/m3-real-planner-known-issues.md.

Planner response stages[n].role is unsupported:
  Cause:
    The provider invented a role such as planner, editor, reviewer, seo, or
    social.
  Fix:
    For v1, rerun or use a model that follows the role catalog. Do not add a
    role until the runtime has matching prompts and stage semantics.

Job reaches failed or waiting_for_human after cluster generation:
  Cause:
    The provider call worked, but the generated cluster shape produced a job
    sequence that did not pass local mock-mode execution.
  Fix:
    Inspect GET /jobs/<jobId>/details and timeline locally. Compare the
    generated stageAgents with cluster.config.json.

Timed out waiting for JOB-...:
  Cause:
    API/worker did not finish the demo job before the smoke timeout.
  Fix:
    Check the dev stack logs, confirm Postgres is healthy, and rerun after
    stopping stale local services with npm run dev:stop.
```

## Expected Planner Contract

The real provider should return one JSON object that can be parsed from
`choices[0].message.content`:

```json
{
  "clusterId": "content-studio-demo",
  "name": "Content Studio Demo",
  "description": "Turn an idea into research, writing, and an image brief.",
  "defaultRoutingMode": "supervisor_pipeline",
  "stages": [
    {
      "role": "research",
      "name": "Research",
      "acceptanceCriteria": ["Find key facts and constraints."]
    },
    {
      "role": "writing",
      "name": "Draft",
      "acceptanceCriteria": ["Write a concise final article."]
    }
  ]
}
```

Accepted roles:

```text
research
writing
image
video
```

Accepted routing modes:

```text
supervisor_pipeline
pipeline
classic_master_slave
master_slave_discussion
```

## Secret Handling

```text
Do not commit .env.
Do not paste M3_PLANNER_API_KEY into chat, docs, issues, or context files.
Do not paste provider authorization headers.
If a key may have leaked, rotate it before continuing.
```

Safe to share:

```text
provider name
base URL without query strings
model id
high-level error category
job id
cluster id
stage role list
```

Not safe to share:

```text
API key
Authorization header
full raw provider response if it contains account metadata or request ids you
consider sensitive
```

## References

```text
OpenAI Chat Completions API:
  https://platform.openai.com/docs/api-reference/chat/create

DeepSeek first API call / OpenAI-compatible base URL:
  https://api-docs.deepseek.com/

Volcengine Ark OpenAI SDK compatibility:
  https://www.volcengine.com/docs/82379/1330626

Volcengine Ark Chat API:
  https://www.volcengine.com/docs/82379/1302010
```
