# DeepSeek Harness Desktop

A native Windows desktop app that wraps the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI. It does not reimplement Harness: it starts the official CLI inside the workspace you choose, waits until the service is ready, and loads the unmodified official UI in an Electron window.

> DeepSeek Harness is in Developer Preview, and releases may break compatibility. This app pins one harness release (see [`src/main/config.ts`](src/main/config.ts)) and upgrades it deliberately.

## Features

- **Workspace picker** — select a project folder with the native dialog; it becomes the harness working directory and is never modified by the app.
- **Automatic harness lifecycle** — spawn, readiness detection, page load, and process-tree cleanup on quit are fully automatic; no PowerShell, no manual npx, no browser tab.
- **Dynamic port** — the app launches `dsh web --host 127.0.0.1 --port 0`, so the OS assigns a free port and there are no port conflicts, even with other harness instances running.
- **Official readiness signal** — the app waits for the documented `dsh web: http://…` stdout line, then confirms with an HTTP 200 check before loading the page.
- **Loading and error pages** — staged progress while the harness boots; on failure, a page with the reason, redacted logs, Retry, and Choose Another Workspace.
- **Recent workspaces** — the 10 most recently opened folders with one-click reopen, removal, and `(missing)` marking. Only directory paths and timestamps are stored.
- **Clean shutdown** — quitting terminates the whole harness process tree with `taskkill /T /F`; no orphan `node.exe` or `cmd.exe` processes remain.

## Prerequisites

- Windows x64.
- Node.js `^22.19.0 || >=24.0.0` installed system-wide, so `node`, `npm`, and `npx` are on PATH.
- Network access on first launch: npx downloads the pinned harness release once (several minutes on a cold machine) and then reuses its cache.
- The DeepSeek API key stays inside Harness's own credential store (configured in the Harness UI, stored under `$DSH_HOME/.credentials.yaml`); this app never manages keys.

## Quick start

```sh
npm install   # one-time
npm run dev   # build and launch
```

Click **Open Folder**, choose a project directory, and the official Harness UI opens in the window.

## Commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install development dependencies (Electron, TypeScript) |
| `npm run build` | Compile TypeScript and copy renderer assets into `dist/` |
| `npm start` | Run the built app |
| `npm run dev` | Build, then run |
| `npm run verify` | Run the scripted minimal-loop verification |

## How it works

1. Pick a workspace folder, or pass `--workspace <dir>` for scripted runs.
2. The main process spawns the pinned release `@deepseek-ai/dsh@0.1.0-rc.6` (see [`src/main/config.ts`](src/main/config.ts)) through npm's `npx-cli.js` under the system Node, with the workspace as `cwd` and the fixed arguments `dsh web --host 127.0.0.1 --port 0`.
3. Readiness is the official stdout line `dsh web: http://127.0.0.1:<port>`, followed by an HTTP 200 check; only then does the window load `http://127.0.0.1:<port>`.
4. On quit, the harness process tree is terminated with `taskkill /T /F`.

## Project structure

```
src/
├── main/                  Electron main process
│   ├── config.ts            pinned package spec, fixed argv, timeouts
│   ├── harness.ts           HarnessController state machine (spawn → readiness → stop)
│   ├── process.ts           toolchain lookup, npx spawn, process-tree termination
│   ├── workspace.ts         folder validation and recent-workspace storage
│   └── index.ts             window, navigation guards, IPC handlers, quit flow
├── preload/               the only bridge between renderer and main
└── renderer/              the shell page (Choose / Loading / Error), vanilla TypeScript
scripts/                   build helper and end-to-end verification scripts
```

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- The preload exposes six fixed actions; every IPC handler rejects callers that are not the local shell page, so the Harness UI gets no usable Electron surface.
- The harness command line is assembled from constants in the main process: no shell strings cross IPC and no user input is concatenated into a command.
- Main-frame navigation is restricted to the shell page and the exact harness origin; new windows open in the system browser, never inside the app.
- Harness logs are redacted (credential-like patterns) before reaching the UI.
- Recent-workspace storage contains directory paths and timestamps only; its IPC surface is not exposed to the Harness page.

## Verification

- `scripts/verify-loop.ps1` — scripted end-to-end check of the minimal loop: spawn, readiness line, HTTP 200, page title, load event, clean window close, electron exit, harness pid gone, port closed.
- `scripts/verify-real-agent.ps1 agent|persist` with `scripts/verify-agent.mjs` — drives the real UI over the Chrome DevTools Protocol: creates a session, runs a read-only task (read-only tools, workspace hash snapshot unchanged), then verifies native session persistence across an app restart.
- `scripts/analyze-session.mjs` — parses the official zstd-frame session log format.
- The agent suite inherits the credential environment of a running harness on port 3080; it never reads or stores keys.

## Known limitations

- Requires a system Node.js/npm install (not bundled).
- First launch downloads the full pinned dependency graph; later launches reuse the npx cache.
- The pinned release is `0.1.0-rc.6`; upgrades are deliberate version bumps.
- Termination is forceful (`taskkill /F`): on Windows the harness's graceful-disposal path is unreachable from outside, matching the official behavior.
- Installer/portable packaging is not wired up yet; the distribution investigation documents a recommended plan.

## Not in V1

Rebuilding the Harness UI, custom plugins, auto-update, MCP/skills managers, multi-model routing, multi-harness orchestration, cloud sync, and a bundled Node runtime are intentionally out of scope for V1.

## Documentation

- [English](README.md) · [中文](README.zh.md) — both carry equal authority; [`README.i18n.yaml`](README.i18n.yaml) records their consistency.
