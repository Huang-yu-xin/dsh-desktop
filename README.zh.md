# DeepSeek Harness Desktop

一个 Windows 原生桌面应用，封装官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI。它不重做 Harness：在你选择的工作区内启动官方 CLI，等待服务就绪后，把未修改的官方 UI 加载进 Electron 窗口。

> DeepSeek Harness 处于 Developer Preview 阶段，版本之间可能存在破坏性变更。本应用固定使用一个 Harness 版本（见 [`src/main/config.ts`](src/main/config.ts)），升级时由开发者显式变更。

## 功能

- **工作区选择** — 用系统原生对话框选择项目目录；该目录成为 Harness 的工作目录，应用不会修改其中的任何文件。
- **自动化 Harness 生命周期** — 启动、就绪检测、页面加载、退出时的进程树清理全自动；无需打开 PowerShell、手动执行 npx 或开浏览器标签页。
- **动态端口** — 以 `dsh web --host 127.0.0.1 --port 0` 启动，端口由操作系统分配，即使有其他 Harness 实例在运行也零端口冲突。
- **官方就绪信号** — 等待官方文档化的 stdout 行 `dsh web: http://…`，再做一次 HTTP 200 确认，之后才加载页面。
- **加载页与错误页** — 启动过程中分阶段显示进度；失败时展示原因、脱敏日志、Retry 与 Choose Another Workspace。
- **最近工作区** — 保存最近打开的 10 个目录：一键重新打开、可移除、路径失效时标注 `(missing)`；只存目录路径与时间戳。
- **干净退出** — 退出时用 `taskkill /T /F` 终止整个 Harness 进程树，不残留孤儿 `node.exe` 或 `cmd.exe` 进程。

## 前置要求

- Windows x64。
- 系统级安装 Node.js `^22.19.0 || >=24.0.0`，使 `node`、`npm`、`npx` 都在 PATH 中。
- 首次启动需要网络：npx 一次性下载固定版本的 Harness 及其依赖（冷机器上需数分钟），之后复用 npx 缓存。
- DeepSeek API Key 保留在 Harness 自己的凭据存储中（在 Harness UI 内配置，存放于 `$DSH_HOME/.credentials.yaml`）；本应用不管理任何密钥。

## 快速开始

```sh
npm install   # 一次性
npm run dev   # 构建并启动
```

点击 **Open Folder**，选择一个项目目录，官方 Harness UI 即会在窗口中打开。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm install` | 安装开发依赖（Electron、TypeScript） |
| `npm run build` | 编译 TypeScript 并把渲染层静态资源复制到 `dist/` |
| `npm start` | 运行已构建的应用 |
| `npm run dev` | 构建后运行 |
| `npm run verify` | 运行脚本化的最小闭环验证 |

## 工作原理

1. 选择一个工作区目录（脚本化运行时也可传 `--workspace <dir>`）。
2. 主进程以工作区为 `cwd`，通过系统 Node 运行 npm 的 `npx-cli.js`，启动固定版本 `@deepseek-ai/dsh@0.1.0-rc.6`（见 [`src/main/config.ts`](src/main/config.ts)），参数固定为 `dsh web --host 127.0.0.1 --port 0`。
3. 就绪判据是官方 stdout 行 `dsh web: http://127.0.0.1:<port>`，再加一次 HTTP 200 确认；通过后窗口才加载 `http://127.0.0.1:<port>`。
4. 退出时用 `taskkill /T /F` 终止 Harness 进程树。

## 项目结构

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

## 安全模型

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- preload 只暴露六个固定动作；所有 IPC 处理器都会拒绝非本地壳页面的调用方，Harness UI 因此得不到任何可用的 Electron 能力面。
- Harness 启动命令由主进程中的常量拼装：没有 shell 字符串跨 IPC，也没有用户输入被拼进命令。
- 主框架导航仅允许壳页面与精确的 Harness origin；新窗口一律在系统浏览器中打开，绝不在应用内打开。
- Harness 日志在进入 UI 之前经过脱敏（凭据类模式）。
- 最近工作区存储只含目录路径与时间戳；其 IPC 能力面不向 Harness 页面暴露。

## 验证

- `scripts/verify-loop.ps1` — 最小闭环的脚本化端到端检查：spawn、就绪行、HTTP 200、页面标题、加载事件、窗口干净关闭、electron 退出、harness pid 消失、端口释放。
- `scripts/verify-real-agent.ps1 agent|persist` 配合 `scripts/verify-agent.mjs` — 通过 Chrome DevTools Protocol 驱动真实 UI：创建会话、执行只读任务（仅只读工具，工作区哈希快照不变），并在应用重启后验证原生会话持久化。
- `scripts/analyze-session.mjs` — 解析官方 zstd 帧格式的会话日志。
- Agent 验证套件继承本机 3080 端口上运行中 Harness 的凭据环境；它从不读取或存储密钥。

## 已知限制

- 需要目标机安装系统 Node.js/npm（未内置）。
- 首次启动需下载完整依赖图；之后启动复用 npx 缓存。
- 固定版本为 `0.1.0-rc.6`；升级是显式的版本变更。
- 进程终止是强制的（`taskkill /F`）：Windows 上从外部无法触达 Harness 的优雅释放路径，这与官方行为一致。
- 安装包/便携版打包尚未接入；分发调查报告记录了推荐方案。

## 不属于 V1 的内容

重做 Harness UI、自定义插件、自动更新、MCP/Skills 管理器、多模型路由、多 Harness 编排、云同步、内置 Node 运行时，均有意排除在 V1 范围之外。

## 文档

- [English](README.md) · [中文](README.zh.md) — 两种语言同等效力；[`README.i18n.yaml`](README.i18n.yaml) 记录二者的同步状态。
