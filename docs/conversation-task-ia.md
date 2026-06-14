# Honeycomb Conversation And Task IA

Status: first desktop UI pass implemented locally.

Reference:
https://github.com/qingchencloud/clawpanel/blob/main/docs/hermes-agent.md

## Decision

Honeycomb should separate work intake from work monitoring.

- Conversations are where users choose a local project location, create a
  project-scoped conversation, and talk to the panel agent.
- Tasks are where users inspect task progress, sub-agent status, task history,
  and the selected job timeline.
- The dashboard stays a runtime overview and should route new work toward
  Conversations, not directly into Tasks.

This matches the Hermes reference pattern: persistent left navigation, a
conversation surface for live interaction, separate session/log/usage pages for
operational review, and visible gateway/runtime state.

## Current Desktop Change

Implemented in:

- `apps/desktop-app/src/main.tsx`
- `apps/desktop-app/src/styles.css`
- `scripts/smoke-desktop-ui.ts`

Current behavior:

- Left navigation now has a `Conversations` entry before `Jobs`.
- Dashboard primary action opens `Conversations`.
- The conversation page has:
  - project path input backed by the existing supervisor workbench config;
  - a conversation list skeleton;
  - a Codex-like conversation canvas;
  - panel-agent context copy;
  - message composer and call-limit control;
  - routing/agent handoff panel.
- Sending from Conversations still creates a normal backend job, then the app
  opens the Tasks page so the user can monitor it.
- The Tasks page no longer owns the new-task composer. It now shows:
  - selected job progress;
  - sub-agent status cards;
  - running/total/latest job summary;
  - job list, filters, and selected timeline.

## Product Model

Target structure:

```text
Honeycomb
├─ Dashboard
│  └─ runtime health, latest job, next action
├─ Conversations
│  ├─ project picker / project path
│  ├─ project conversation list
│  ├─ panel-agent conversation
│  └─ send message -> create/continue task
├─ Tasks
│  ├─ active task process
│  ├─ sub-agent states
│  ├─ task list and filters
│  └─ selected task timeline/artifacts
├─ Approvals
├─ Agents
├─ Models
└─ Memory
```

## Docker Desktop Startup

The current Windows launcher starts the desktop app first, then ensures the
Docker-backed backend is available.

Current path in `scripts/launch-desktop-app.ps1`:

- launch the Tauri desktop executable;
- check whether the authenticated API is already healthy;
- if not healthy or images are stale, probe `docker info`;
- when Docker is not ready, start `com.docker.service` and `Docker Desktop.exe`;
- run `docker compose up -d --build`.

So Docker Desktop opens because Honeycomb currently depends on the local Docker
Compose stack for `orchestrator-api`, `dbos-worker`, and Postgres.

Future UX options:

- UI-only startup mode: open Honeycomb without starting Docker until the user
  sends a task or opens runtime pages.
- Lazy backend startup: start Docker only when a feature needs the backend.
- Explicit startup preference: "start backend automatically" vs "ask first".
- Native/bundled backend mode later, so everyday desktop launch does not require
  Docker Desktop.

## Next Implementation Steps

- Persist real projects and conversations instead of using a single local draft.
- Add a folder picker command in the Tauri layer for choosing project paths.
- Link conversation messages to created jobs.
- Stream task progress back into the conversation panel while keeping Tasks as
  the full operations view.
- Add an app preference for lazy Docker/backend startup.
