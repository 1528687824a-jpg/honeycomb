# Honeycomb macOS Desktop Framework

This replaces the earlier iOS direction. The Apple target is macOS desktop,
not iPhone/iPad.

## Local Scaffold

The independent macOS planning folder lives at:

```text
D:\honeycomb-macos
```

The production implementation should stay in the main Honeycomb repo because
the existing desktop app already uses Tauri + React:

```text
D:\honeycomb\apps\desktop-app
```

## Product Position

macOS should run Honeycomb as a desktop product, parallel to Windows:

- local desktop UI through Tauri,
- local Docker/Postgres/worker stack when available,
- local OpenClaw execution without WSL,
- macOS Keychain for local secrets,
- bash/zsh launcher scripts,
- DMG or app bundle packaging.

It is not a remote-only companion client. It should be able to own real task
execution on the Mac.

## Required Backend/Desktop Work

1. Add a platform execution adapter for OpenClaw:
   - Windows keeps `wsl -d ...`;
   - macOS uses local `openclaw` command discovery.
2. Replace Windows-only DPAPI secret storage with a SecretBackend interface:
   - Windows: DPAPI;
   - macOS: Keychain;
   - Linux/headless: libsecret or encrypted file fallback.
3. Add bash/zsh equivalents for dev, tryout, smoke, and repair scripts.
4. Add macOS readiness diagnostics:
   - Docker engine reachable;
   - OpenClaw installed;
   - Keychain access working;
   - required ports available.
5. Add Tauri macOS build notes and later CI build verification.

## Current Backend Slice

The first execution-adapter slice is now in place:

- `OPENCLAW_AGENT_RUNNER=auto` resolves to `wsl` on Windows.
- `OPENCLAW_AGENT_RUNNER=auto` resolves to `native` on macOS/Linux.
- `OPENCLAW_AGENT_RUNNER=native` can explicitly force local `openclaw`.
- `OPENCLAW_AGENT_RUNNER=provider-direct` remains available only as an explicit
  bypass for provider-direct local trials.
- The worker builds one host command before execution, so future macOS
  diagnostics can explain the same runner that the worker will actually use.

## What Was Rolled Back

The previous mobile/iOS backend-token slice was reverted because it solved the
wrong platform problem. Device pairing, mobile tokens, and mobile-only SSE
tickets are no longer the next platform priority.

Remote web or mobile access can still be revisited later, but it should not
drive the Apple desktop architecture.
