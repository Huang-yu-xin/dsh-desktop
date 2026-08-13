# DeepSeek Harness Desktop

The official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI
wrapped in a native Windows desktop app. The app does not reimplement Harness: it starts
the official CLI in the workspace you choose, waits for it to be ready, and loads the
official UI in an Electron window.

## Prerequisites

- Windows x64
- Node.js `^22.19.0 || >=24.0.0` (installed system-wide, so `node`, `npm` and `npx` are on PATH)
- Network access on first run (npx downloads the pinned Harness release once — this can
  take several minutes — then reuses its cache)

The DeepSeek API key is **not** managed by this app — it lives in DeepSeek Harness's own
credentials store (`$DSH_HOME/.credentials.yaml`, configured inside the Harness UI).

## Commands

```sh
npm install        # installs Electron + TypeScript (one-time)
npm run build      # compiles TypeScript and copies renderer assets
npm start          # runs the built app
npm run dev        # build + run
npm run verify     # scripted end-to-end check of the minimal loop
```

Verification scripts (see `scripts/`): `verify-loop.ps1` (minimal loop), and the
real-agent suite `verify-real-agent.ps1 agent|persist` plus `verify-agent.mjs`
(CDP-driven: real session, real read-only task, persistence across restart) and
`verify-recents.mjs` (recent-workspaces flows). The agent suite inherits the
credential env of a running harness on port 3080 — it never reads or stores keys.

## How it works

1. Pick a workspace folder (or pass `--workspace <dir>` for scripted runs).
2. The main process spawns the **pinned** harness release
   (`@deepseek-ai/dsh@0.1.0-rc.6`, see `src/main/config.ts`) via npm's `npx-cli.js`
   under the system Node, with `cwd` set to the workspace and the official arguments
   `dsh web --host 127.0.0.1 --port 0`.
3. Readiness = the official stdout line `dsh web: http://127.0.0.1:<port>` (the port is
   OS-assigned, so there are never port conflicts), followed by an HTTP 200 check.
4. The window then loads `http://127.0.0.1:<port>`.
5. On quit, the harness process tree is terminated with `taskkill /T /F`.

## Recent Workspaces

The startup page lists the 10 most recently opened workspaces
(`userData/recent-workspaces.json`). Each entry keeps only the directory path and a
`lastOpenedAt` timestamp — no credentials, model config, sessions, git or project
data. Entries can be reopened with one click, removed from the list, and folders that
no longer exist are marked `(missing)`. The recents IPC surface is only reachable
from the local shell page, never from the Harness UI.

## Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The preload exposes only five fixed actions (pick folder / start / retry / choose
  another / read state+logs); IPC handlers reject any caller that is not the local shell
  page, so the Harness UI gets no usable Electron surface.
- The harness command line is built from constants in the main process — no shell
  strings ever cross IPC.
- Harness logs are sanitized (credential-like patterns redacted) before reaching the UI.
- Main-frame navigation is restricted to the shell page and the harness origin; new
  windows open in the system browser, never inside the app.

## Known limitations (V1)

- Requires a system Node.js/npm install (not bundled).
- The pinned harness release is `0.1.0-rc.6`; upgrades are a deliberate version bump.
- Harness termination is forceful (`taskkill /F`); no supervisor/watchdog yet.
