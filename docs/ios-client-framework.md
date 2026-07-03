# Honeycomb iOS Client Framework

Created local scaffold:

```text
D:\honeycomb-ios
```

## Architecture

The iOS app is a remote client. It does not run:

- Docker
- Postgres
- DBOS worker
- WSL/OpenClaw local process execution
- PowerShell launcher commands

Instead, it connects to a Honeycomb backend host over HTTP/HTTPS.

## Current Scaffold

The first iOS scaffold uses Capacitor + React + Vite.

Implemented in the scaffold:

- backend URL setting,
- bearer token setting,
- `/health` check,
- job creation through `POST /jobs`,
- recent job list through `GET /jobs`,
- mobile-safe status display.

Verified on Windows:

```text
cd D:\honeycomb-ios
npm install
npm run build
```

The native iOS project itself must be generated on macOS with Xcode:

```bash
cd /path/to/honeycomb-ios
npm run ios:add
npm run ios:open
```

## Backend Work Required Before Real iOS Release

1. Per-device token issuance/revocation.
2. HTTPS/public ingress deployment path.
3. Short-lived timeline/SSE tickets.
4. Artifact proxy/download policy for expired provider URLs.
5. Mobile capability endpoint so iOS can hide desktop-only actions.
