# Desktop Installer Notes

This page tracks the first real Tauri packaging proof for the thin desktop
client under `apps/desktop-app`.

## Status On 2026-06-01

The desktop shell is structurally ready, and the frontend production bundle can
be built. The Windows installer build is blocked on the host because Visual
Studio Build Tools with MSVC and a Windows SDK are not installed.

Observed host probes:

```text
cargo 1.96.0
rustc 1.96.0
WebView2 148.0.3967.96
Windows Rust target stable-x86_64-pc-windows-msvc
```

Blocking probe:

```text
npm --prefix apps/desktop-app exec tauri -- info
  MSVC + Windows SDK: missing

where cl
  not found
```

Attempted packaging command:

```powershell
npm --prefix apps/desktop-app run tauri:build
```

Result:

```text
timed out after 304 seconds
apps/desktop-app/dist was produced
apps/desktop-app/src-tauri/target was not produced
no MSI/NSIS installer artifact was produced
```

The timed-out build also left a temporary Vite dev process running. It was
stopped after the attempt.

## Complete The Build

Install Visual Studio 2022 Build Tools with the Desktop development with C++
workload. The required pieces are:

```text
MSVC v143 C++ build tools
Windows 10 or Windows 11 SDK
```

After installing those host prerequisites, open a fresh terminal and run:

```powershell
npm install --prefix apps/desktop-app
npm --prefix apps/desktop-app run tauri:build
```

Expected installer output area:

```text
apps/desktop-app/src-tauri/target/release/bundle/
```

Exact artifact names depend on Tauri's selected Windows bundler target. With
the current `bundle.targets = "all"` config, expect Windows installer artifacts
such as MSI or NSIS under that bundle directory once the native toolchain is
available.

## Caveats

The v1 desktop app is a thin client. It does not embed Postgres, the API, or
the DBOS worker. Start the local backend first:

```powershell
docker compose up --build
```

Unsigned local Windows installer builds can trigger SmartScreen warnings. Code
signing is a release hardening task, not required for the first local packaging
proof.

`npm run smoke:tauri-shell` validates the repository shell structure and reports
whether the host appears ready for native packaging. It does not replace a real
`tauri:build` run.
