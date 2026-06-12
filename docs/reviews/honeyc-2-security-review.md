# HONEYC~2 Security Review Closure

Date: 2026-06-12

Source context: external review file `HONEYC~2.MD`.

## Review Findings

The review identified six local-security gaps that had to be closed before
remote/iOS exposure or broader tool access:

1. S1: Local API routes lacked unified authentication and development ports
   could be exposed beyond localhost.
2. S2: Workspace APIs trusted client-provided roots, allowing arbitrary local
   file reads.
3. S3: Docker Postgres used weak defaults and published `5432` broadly.
4. S4: Provider and agent API keys were stored as plaintext local files or UI
   state.
5. S5: Tool approvals could remain valid too long and trusted client-provided
   decision actors.
6. S6: Web fetch had a DNS rebinding check/connect time-of-check gap.

## Closure Status

Closed for the Windows-local baseline in commits:

- `325bc08 Add local API security baseline`
- `e07a9ce Close Honeycomb local security review gaps`

Implemented controls:

- Non-health API routes require a local Honeycomb bearer token.
- Docker API and Postgres ports bind to `127.0.0.1`.
- Workspace filesystem APIs require a registered root and first registration is
  approval-gated.
- Provider and agent API keys are stored through a local secret boundary; Windows
  uses DPAPI, and legacy plaintext is migrated on read.
- Tool approvals get a default expiry and are checked again before consumption.
- API approval decisions record the desktop approval boundary, not arbitrary
  client-provided `decidedBy`.
- Web fetch resolves and pins the connect IP for each request and redirect.

## Remaining Follow-Ups

- macOS/Linux keychain integration before cross-platform releases.
- Signed or per-device approval identity before remote/mobile approvals.
- Broader unit tests around approvals, workspace registration, auth, and MCP
  policies.
- Continue splitting large server and desktop files into smaller tested modules.
