# OpenClaw Agent Templates

These files are prompt/config templates for the Feishu + OpenClaw + DBOS pipeline.

This directory is **not** OpenClaw or ClawPanel product source code. It is a
set of template assets owned by this platform project. OpenClaw remains an
external runtime that the platform calls through its CLI/adapter boundary.

Feishu is the visible message bus. Sub-agents may post handoff messages in the group, but users should start new jobs through `main-agent`.

Current required agent IDs:

```text
main-agent
research-agent
writer-agent
image-agent
video-agent
test-agent
```
