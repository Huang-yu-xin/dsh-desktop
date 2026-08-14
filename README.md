# DeepSeek Harness Desktop

**语言 / Language**： [English](#english) · [中文](#中文)

官方 DeepSeek Harness Web UI 的 Windows 原生桌面封装。A native Windows desktop app that wraps the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

---

## English

> DeepSeek Harness is in Developer Preview, and releases may break compatibility. This app pins one harness release (see [`src/main/config.ts`](src/main/config.ts)) and upgrades it deliberately.

### Features

- **Workspace picker** — select a project folder with the native dialog; it becomes the harness working directory and is never modified by the app.
- **Automatic harness lifecycle** — spawn, readiness detection, page load, and process-tree cleanup on quit are fully automatic; no PowerShell, no manual npx, no browser tab.
- **Dynamic port** — the app launches `dsh web --host 127.0.0.1 --port 0`, so the OS assigns a free port and there are no port conflicts, even with other harness instances running.
- **Official readiness signal** — the app waits for the documented `dsh web: http://…` stdout line, then confirms with an HTTP 200 check before loading the page.
- **Loading and error pages** — staged progress while the harness boots; on failure, a page with the reason, redacted logs, Retry, and Choose Another Workspace.
- **Recent workspaces** — the 10 most recently opened folders with one-click reopen, removal, and `(missing)` marking. Only directory paths and timestamps are stored.
- **Clean shutdown** — quitting terminates the whole harness process tree with `taskkill /T /F`; no orphan `node.exe` or `cmd.exe` processes remain.
- **Health monitor (V1.1)** — after the UI is up, a lightweight GET / check runs every 5 s against the harness origin only. Consecutive failures mark the state `disconnected` and show a connection-lost page; the monitor never kills a live process by itself.
- **Crash recovery (V1.1)** — unexpected process exit, process error, and health failures are detected and classified (process exited / process error / health check failed / unexpected exit code); Restart Harness respawns the same workspace on a fresh OS-assigned port, keeping the native session store intact.
- **Back to Workspaces (V1.1)** — returns to the workspace page from a running harness (menu `Harness` → Back to Workspaces, `Ctrl+Shift+B`) and starts another workspace through the normal spawn → readiness → load flow.
- **Window state (V1.1)** — width, height, position, and maximized state persist in userData; off-screen coordinates fall back to a visible position.
- **Logs viewer (V1.1)** — per-stream stdout/stderr tails with Copy Logs; credential-like patterns are redacted before anything reaches the UI.
- **Single instance (V1.1)** — a second launch activates the existing window instead of starting a second backend.
- **Bundled offline runtime (V1.2)** — the pinned Harness release ships inside the app as a production dependency and runs on Electron's own embedded Node (`ELECTRON_RUN_AS_NODE=1`); the packaged app needs no Node.js, npm, or npx, and never touches the npm registry.
- **Windows artifacts (V1.2)** — `win-unpacked`, a portable exe, an NSIS installer, and a zip of the unpacked build (see `release/`).

### Prerequisites

- Windows x64.
- **Packaged app (V1.2): nothing else** — no Node.js, npm, npx, or PowerShell required; the first launch performs no downloads.
- Development builds additionally need Node.js `^22.19.0 || >=24.0.0` (system-wide) and npm.
- The DeepSeek API key stays inside Harness's own credential store (configured in the Harness UI, stored under `$DSH_HOME/.credentials.yaml`); this app never manages keys.

### Quick start

```sh
npm install   # one-time
npm run dev   # build and launch
```

Click **Open Folder**, choose a project directory, and the official Harness UI opens in the window.

### Commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install development dependencies (Electron, TypeScript) |
| `npm run build` | Compile TypeScript and copy renderer assets into `dist/` |
| `npm start` | Run the built app |
| `npm run dev` | Build, then run |
| `npm run verify` | Run the scripted minimal-loop verification |
| `npm run stage` | Assemble the production dependency tree for packaging (`release-stage/`) |
| `npm run dist` | Build, stage, and package Windows artifacts (`release/`) |

Verification scripts under `scripts/`: `verify-v11.ps1` runs the reliability
scenario suite (crash recovery, HTTP disconnect, back-to-workspaces, window
state, logs, single instance, IPC gate, recents — 55 checks), `check-sanitize.mjs`
asserts the log redaction unit cases, `verify-longtask.ps1` runs the ~60 s busy
agent simulation under the health monitor, and `verify-real-agent.ps1
agent|persist` runs the real-agent and session-persistence regressions.

### How it works

1. Pick a workspace folder, or pass `--workspace <dir>` for scripted runs.
2. The main process spawns the pinned release `@deepseek-ai/dsh@0.1.0-rc.6` (see [`src/main/config.ts`](src/main/config.ts)) from the bundled dependency tree through Electron's own embedded Node (`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + `--expose-internals`, required so the official loader can reach Node internals on this runtime), with the workspace as `cwd` and the fixed arguments `dsh web --host 127.0.0.1 --port 0`. npm/npx are never used at runtime; a missing bundled runtime produces a local error page, never a fallback download.
3. Readiness is the official stdout line `dsh web: http://127.0.0.1:<port>`, followed by an HTTP 200 check; only then does the window load `http://127.0.0.1:<port>`.
4. On quit, the harness process tree is terminated with `taskkill /T /F`.
5. While the UI is up, the health monitor polls GET / every 5 s (2 s timeout). Three consecutive failures mark the state `disconnected` — the Desktop shows the connection-lost page with Restart Harness / Show Logs / Back to Workspaces, but never kills the live process itself. Unexpected process exit is detected through `exit`/`close`/`error` and classified into a reason.

### Project structure

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

### Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- The preload exposes six fixed actions; every IPC handler rejects callers that are not the local shell page, so the Harness UI gets no usable Electron surface.
- The harness command line is assembled from constants in the main process: no shell strings cross IPC and no user input is concatenated into a command.
- Main-frame navigation is restricted to the shell page and the exact harness origin; new windows open in the system browser, never inside the app.
- Harness logs are redacted (credential-like patterns) before reaching the UI.
- Recent-workspace storage contains directory paths and timestamps only; its IPC surface is not exposed to the Harness page.

### Verification

- `scripts/verify-loop.ps1` — scripted end-to-end check of the minimal loop: spawn, readiness line, HTTP 200, page title, load event, clean window close, electron exit, harness pid gone, port closed.
- `scripts/verify-real-agent.ps1 agent|persist` with `scripts/verify-agent.mjs` — drives the real UI over the Chrome DevTools Protocol: creates a session, runs a read-only task (read-only tools, workspace hash snapshot unchanged), then verifies native session persistence across an app restart.
- `scripts/analyze-session.mjs` — parses the official zstd-frame session log format.
- The agent suite inherits the credential environment of a running harness on port 3080; it never reads or stores keys.

### Known limitations

- Development builds require a system Node.js/npm install; the packaged app does not.
- The pinned release is `0.1.0-rc.6`; upgrades are deliberate version bumps.
- Termination is forceful (`taskkill /F`): on Windows the harness's graceful-disposal path is unreachable from outside, matching the official behavior.
- The health monitor detects only — it does not auto-recover a recovered HTTP endpoint after `disconnected`; the user restarts via the lost page.
- The portable exe re-extracts its payload on every launch (≈1 minute on a normal machine; antivirus scanning can extend this). The installer and the zip of `win-unpacked` avoid per-launch extraction.
- Artifacts are unsigned: Windows SmartScreen shows "Unknown publisher" until a code-signing certificate is configured for public release.

### Not in V1

Rebuilding the Harness UI, custom plugins, auto-update, MCP/skills managers, multi-model routing, multi-harness orchestration, cloud sync, and a bundled Node runtime are intentionally out of scope for V1.

---

## 中文

> DeepSeek Harness 处于 Developer Preview 阶段，版本之间可能存在破坏性变更。本应用固定使用一个 Harness 版本（见 [`src/main/config.ts`](src/main/config.ts)），升级时由开发者显式变更。

### 功能

- **工作区选择** — 用系统原生对话框选择项目目录；该目录成为 Harness 的工作目录，应用不会修改其中的任何文件。
- **自动化 Harness 生命周期** — 启动、就绪检测、页面加载、退出时的进程树清理全自动；无需打开 PowerShell、手动执行 npx 或开浏览器标签页。
- **动态端口** — 以 `dsh web --host 127.0.0.1 --port 0` 启动，端口由操作系统分配，即使有其他 Harness 实例在运行也零端口冲突。
- **官方就绪信号** — 等待官方文档化的 stdout 行 `dsh web: http://…`，再做一次 HTTP 200 确认，之后才加载页面。
- **加载页与错误页** — 启动过程中分阶段显示进度；失败时展示原因、脱敏日志、Retry 与 Choose Another Workspace。
- **最近工作区** — 保存最近打开的 10 个目录：一键重新打开、可移除、路径失效时标注 `(missing)`；只存目录路径与时间戳。
- **干净退出** — 退出时用 `taskkill /T /F` 终止整个 Harness 进程树，不残留孤儿 `node.exe` 或 `cmd.exe` 进程。
- **健康监控（V1.1）** — UI 就绪后每 5 秒对 Harness origin 做一次轻量 GET / 检查。连续失败进入 `disconnected` 状态并显示连接丢失页；监控**只检测**，绝不会自行杀掉仍然存活的进程。
- **崩溃恢复（V1.1）** — 意外进程退出、进程错误与健康检查失败均被检测并按类别归因（进程退出 / 进程错误 / 健康检查失败 / 意外退出码）；Restart Harness 在同一工作区、新的 OS 分配端口上重启，Harness 原生会话数据完整保留。
- **返回工作区列表（V1.1）** — 运行中可通过菜单 `Harness` → Back to Workspaces（`Ctrl+Shift+B`）返回工作区页，再经完整的 spawn → 就绪 → 加载流程打开另一个工作区。
- **窗口状态（V1.1）** — 尺寸、位置、最大化状态保存在 userData；屏幕外坐标自动回退到可见位置。
- **日志查看器（V1.1）** — stdout/stderr 分路展示，支持 Copy Logs；凭据类模式在进入 UI 前一律脱敏。
- **单实例（V1.1）** — 第二次启动只会激活已有窗口，不会创建第二个后端。
- **内置离线运行时（V1.2）** — 固定版本的 Harness 作为 production dependency 随应用分发，并在 Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`）上运行；打包后的应用不需要 Node.js、npm 或 npx，也从不访问 npm registry。
- **Windows 产物（V1.2）** — `win-unpacked`、portable exe、NSIS 安装器以及 unpacked 构建的 zip 包（见 `release/`）。

### 前置要求

- Windows x64。
- **打包后的应用（V1.2）：无其它要求** — 不需要 Node.js、npm、npx 或 PowerShell；首次启动不进行任何下载。
- 开发构建额外需要系统级 Node.js `^22.19.0 || >=24.0.0` 与 npm。
- DeepSeek API Key 保留在 Harness 自己的凭据存储中（在 Harness UI 内配置，存放于 `$DSH_HOME/.credentials.yaml`）；本应用不管理任何密钥。

### 快速开始

```sh
npm install   # 一次性
npm run dev   # 构建并启动
```

点击 **Open Folder**，选择一个项目目录，官方 Harness UI 即会在窗口中打开。

### 命令

| 命令 | 用途 |
| --- | --- |
| `npm install` | 安装开发依赖（Electron、TypeScript） |
| `npm run build` | 编译 TypeScript 并把渲染层静态资源复制到 `dist/` |
| `npm start` | 运行已构建的应用 |
| `npm run dev` | 构建后运行 |
| `npm run verify` | 运行脚本化的最小闭环验证 |
| `npm run stage` | 组装打包用的 production 依赖树（`release-stage/`） |
| `npm run dist` | 构建、staging 并打包 Windows 产物（`release/`） |

`scripts/` 下的验证脚本：`verify-v11.ps1` 运行可靠性场景套件（崩溃恢复、
HTTP 断连、返回工作区、窗口状态、日志、单实例、IPC 门禁、最近工作区，
共 55 项检查），`check-sanitize.mjs` 断言日志脱敏用例，`verify-longtask.ps1`
在健康监控全程运行时执行约 60 秒的忙碌 Agent 模拟，`verify-real-agent.ps1
agent|persist` 执行真实 Agent 与会话持久化回归。

### 工作原理

1. 选择一个工作区目录（脚本化运行时也可传 `--workspace <dir>`）。
2. 主进程从内置依赖树启动固定版本 `@deepseek-ai/dsh@0.1.0-rc.6`（见 [`src/main/config.ts`](src/main/config.ts)）：以 Electron 自带 Node（`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + `--expose-internals`，后者是该运行时下官方 Loader 触达 Node 内部模块所必需）运行，工作区为 `cwd`，参数固定为 `dsh web --host 127.0.0.1 --port 0`。运行期从不使用 npm/npx；内置运行时缺失时进入本地错误页，绝不回退到下载。
3. 就绪判据是官方 stdout 行 `dsh web: http://127.0.0.1:<port>`，再加一次 HTTP 200 确认；通过后窗口才加载 `http://127.0.0.1:<port>`。
4. 退出时用 `taskkill /T /F` 终止 Harness 进程树。
5. UI 运行期间，健康监控每 5 秒轮询一次 GET /（单次 2 秒超时）。连续三次失败进入 `disconnected` 状态——桌面端显示连接丢失页（Restart Harness / Show Logs / Back to Workspaces），但绝不自行杀掉存活的进程。意外进程退出通过 `exit`/`close`/`error` 监听检测并归类原因。

### 项目结构

```
src/
├── main/                  Electron 主进程
│   ├── config.ts            固定的包版本、固定参数、超时配置
│   ├── harness.ts           HarnessController 状态机（spawn → 就绪 → stop）
│   ├── process.ts           工具链定位、npx 启动、进程树终止
│   ├── workspace.ts         目录校验与最近工作区存储
│   └── index.ts             窗口、导航守卫、IPC 处理器、退出流程
├── preload/               渲染层与主进程之间的唯一桥梁
└── renderer/              壳页面（Choose / Loading / Error），原生 TypeScript
scripts/                   构建辅助与端到端验证脚本
```

### 安全模型

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- preload 只暴露六个固定动作；所有 IPC 处理器都会拒绝非本地壳页面的调用方，Harness UI 因此得不到任何可用的 Electron 能力面。
- Harness 启动命令由主进程中的常量拼装：没有 shell 字符串跨 IPC，也没有用户输入被拼进命令。
- 主框架导航仅允许壳页面与精确的 Harness origin；新窗口一律在系统浏览器中打开，绝不在应用内打开。
- Harness 日志在进入 UI 之前经过脱敏（凭据类模式）。
- 最近工作区存储只含目录路径与时间戳；其 IPC 能力面不向 Harness 页面暴露。

### 验证

- `scripts/verify-loop.ps1` — 最小闭环的脚本化端到端检查：spawn、就绪行、HTTP 200、页面标题、加载事件、窗口干净关闭、electron 退出、harness pid 消失、端口释放。
- `scripts/verify-real-agent.ps1 agent|persist` 配合 `scripts/verify-agent.mjs` — 通过 Chrome DevTools Protocol 驱动真实 UI：创建会话、执行只读任务（仅只读工具，工作区哈希快照不变），并在应用重启后验证原生会话持久化。
- `scripts/analyze-session.mjs` — 解析官方 zstd 帧格式的会话日志。
- Agent 验证套件继承本机 3080 端口上运行中 Harness 的凭据环境；它从不读取或存储密钥。

### 已知限制

- 开发构建需要系统 Node.js/npm；打包后的应用不需要。
- 固定版本为 `0.1.0-rc.6`；升级是显式的版本变更。
- 进程终止是强制的（`taskkill /F`）：Windows 上从外部无法触达 Harness 的优雅释放路径，这与官方行为一致。
- 健康监控只做检测：`disconnected` 后即使 HTTP 恢复也不会自动切回；由用户经丢失页手动重启。
- portable exe 每次启动都要重新解压载荷（正常机器约 1 分钟，杀毒软件扫描会延长）；安装器与 `win-unpacked` 的 zip 包无逐次解压成本。
- 产物未签名：配置代码签名证书前，Windows SmartScreen 会显示"未知发布者"。

### 不属于 V1 的内容

重做 Harness UI、自定义插件、自动更新、MCP/Skills 管理器、多模型路由、多 Harness 编排、云同步、内置 Node 运行时，均有意排除在 V1 范围之外。

[回到顶部 / Back to top](#deepseek-harness-desktop)
