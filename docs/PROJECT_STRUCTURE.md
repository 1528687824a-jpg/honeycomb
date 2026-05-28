# Project Structure

This repository is the platform project built around OpenClaw. OpenClaw itself
is an external runtime/product and is not vendored here.

## Source Code

```text
apps/
  dbos-worker/          DBOS workflows and activities.
  orchestrator-api/     HTTP API, Feishu webhook ingress, DBOS launcher.

packages/
  db/                   Postgres business ledger and migrations.
  shared/               Shared constants and TypeScript types.

scripts/
  start-dev.ps1         Local dev stack launcher.
  stop-dev.ps1          Local dev stack shutdown.
  smoke-*.ps1           Local smoke checks for recovery and webhook readiness.
```

## Platform Assets

```text
platform-assets/
  openclaw-agent-templates/
    agents/             Prompt templates for OpenClaw agents.
    config/             Example OpenClaw agent/model config.
  vendor-workarounds/
    openclaw/           Manual, unsupported OpenClaw workarounds.
```

Anything under `platform-assets/openclaw-agent-templates/` is owned by this
platform project. It is copied into or referenced by OpenClaw during setup; it
is not OpenClaw source code.

Anything under `platform-assets/vendor-workarounds/` must stay out of the
default user install path unless a maintainer deliberately opts in.

## Docs

```text
docs/
  PROJECT_STRUCTURE.md
  BOUNDARIES.md
  openclaw-agent-creation.md
  historical/

CONTEXT.md             Current project checkpoint for agents.
SETUP.md               Local setup and verification guide.
```

## Local Runtime Output

The following are intentionally ignored and should not be committed:

```text
.env
.runtime/
data/
logs/
node_modules/
temporal/
```

## Packaging Rule

A future downloadable platform should package this repository's app code,
database migrations, docs, and platform assets. It should not package a mutated
copy of OpenClaw or ClawPanel. Users install or point to OpenClaw as an external
runtime, and the platform talks to it through the adapter boundary.
