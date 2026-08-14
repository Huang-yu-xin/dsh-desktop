/**
 * Electron main entry: window + navigation policy + minimal IPC.
 *
 * Security model:
 * - the shell page is a local file; the harness UI is the only remote page.
 * - IPC handlers are gated: only frames on the local shell page may invoke
 *   them, so the harness page gets no usable Electron surface. Desktop-level
 *   actions that must be reachable while the harness UI is shown (Restart,
 *   Back to Workspaces) live in the native application menu instead — an
 *   Electron chrome layer, not page-side IPC.
 * - the harness spawn argv is built from fixed constants in main; no shell
 *   strings ever cross the IPC boundary.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessController } from './harness';
import type { HarnessState } from './harness';
import { QUIT_STOP_TIMEOUT_MS } from './config';
import { sanitizeLogs } from './logs';
import {
  loadRecents,
  recentsWithExistence,
  removeRecentPath,
  saveRecents,
  touchRecent,
  validateWorkspace,
  workspaceFromArgv,
} from './workspace';
import type { RecentWorkspace } from './workspace';
import { loadWindowState, saveWindowState, validatedWindowState } from './window-state';

// Single-instance protection: a second launch exits immediately and just
// activates the existing window; it never spawns a second backend.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  void startApp();
}

function startApp(): void {
  const harness = new HarnessController();
  let win: BrowserWindow | null = null;
  let currentWorkspace: string | null = null;
  /** Only folders the user picked (or passed via --workspace) may be started. */
  const allowedWorkspaces = new Set<string>();
  let recents: RecentWorkspace[] = loadRecents();
  let shutdownDone = false;

  function appLog(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    try {
      if (!app.isReady()) return;
      const dir = app.getPath('userData');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'dsh-desktop.log'), `${stamped}\n`);
    } catch {
      // Logging must never break the app.
    }
  }

  function localShellFile(): string {
    return join(__dirname, '..', 'renderer', 'index.html');
  }

  function pushState(): void {
    if (win === null || win.isDestroyed()) return;
    const raw = harness.getState();
    // Shell-page UI state (recents, logs) is never pushed to the harness page.
    const onLocalShell = win.webContents.getURL().startsWith('file://');
    const state = {
      ...raw,
      workspace: currentWorkspace ?? raw.workspace,
      logs: { stdout: sanitizeLogs(raw.logs.stdout), stderr: sanitizeLogs(raw.logs.stderr) },
      recents: onLocalShell ? recentsWithExistence(recents) : [],
    };
    win.webContents.send('app:state', state);
  }

  /** Bring the local shell page back (used when the harness fails or is swapped out). */
  function showLocalShell(): void {
    if (win === null || win.isDestroyed()) return;
    if (win.webContents.getURL().startsWith('file://')) return;
    win.loadFile(localShellFile()).catch((err: Error) => appLog(`loadFile failed: ${err.message}`));
  }

  function startHarness(workspace: string): void {
    currentWorkspace = workspace;
    harness.start(workspace).catch((err: Error) => appLog(`harness.start crashed: ${err.message}`));
  }

  /** User-driven: stop the current backend and return to the workspace page. */
  async function backToWorkspaces(): Promise<void> {
    await harness.stop('back');
    allowedWorkspaces.clear();
    currentWorkspace = null;
    showLocalShell();
  }

  harness.on('state', (state: HarnessState) => {
    appLog(
      `state: ${state.phase}` +
        `${state.workspace ? ` workspace=${state.workspace}` : ''}` +
        `${state.pid ? ` pid=${state.pid}` : ''}` +
        `${state.url ? ` url=${state.url}` : ''}` +
        `${state.reason ? ` reason=${state.reason.kind}: ${state.reason.message}` : ''}`,
    );
    if (state.phase === 'ready' && state.url !== null) {
      if (win !== null && !win.isDestroyed()) {
        win.loadURL(state.url).catch((err: Error) => appLog(`loadURL failed: ${err.message}`));
      }
    } else if (state.phase === 'failed' || state.phase === 'disconnected') {
      showLocalShell();
    }
    pushState();
  });

  harness.on('spawned', (pid: number) => {
    appLog(`harness spawned: pid=${pid}`);
  });

  harness.on('log', (line: string) => {
    appLog(`harness log: ${line}`);
  });

  harness.on('health', (event: { ok: boolean; consecutiveFailures: number; recovered: boolean }) => {
    if (event.ok) {
      appLog(`health: ok${event.recovered ? ' (recovered)' : ''}`);
    } else {
      appLog(`health: fail (${event.consecutiveFailures} consecutive)`);
    }
  });

  app.on('second-instance', () => {
    appLog('second-instance: activating existing window');
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  function buildMenu(): void {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Harness',
        submenu: [
          {
            label: 'Restart Harness',
            accelerator: 'CmdOrCtrl+Shift+R',
            click: () => {
              void harness.restart();
            },
          },
          {
            label: 'Back to Workspaces',
            accelerator: 'CmdOrCtrl+Shift+B',
            click: () => {
              void backToWorkspaces();
            },
          },
          { type: 'separator' },
          {
            label: 'Quit',
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
              app.quit();
            },
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function createWindow(): BrowserWindow {
    const state = validatedWindowState(loadWindowState());
    win = new BrowserWindow({
      width: state.width,
      height: state.height,
      x: state.x,
      y: state.y,
      minWidth: 940,
      minHeight: 600,
      title: 'DeepSeek Harness Desktop',
      backgroundColor: '#101216',
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    if (state.maximized) win.maximize();

    // Only the local shell page and the exact harness origin may navigate the
    // main frame. Everything else is blocked (no drive-by navigation).
    win.webContents.on('will-navigate', (event, url) => {
      const harnessUrl = harness.getState().url;
      let allowed = url.startsWith('file://');
      if (!allowed && harnessUrl !== null) {
        try {
          allowed = new URL(url).origin === new URL(harnessUrl).origin;
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        appLog(`blocked navigation: ${url}`);
        event.preventDefault();
      }
    });

    // New windows: never inside the app. http(s) links go to the default browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    win.webContents.on('did-finish-load', () => {
      if (win === null || win.isDestroyed()) return;
      const url = win.webContents.getURL();
      win.webContents
        .executeJavaScript('document.title')
        .then((title: unknown) => {
          appLog(`page loaded: url=${url} title=${String(title)}`);
          const shotPath = process.env.DSH_DESKTOP_SHOT;
          if (shotPath !== undefined && url.startsWith('http')) {
            setTimeout(() => {
              if (win === null || win.isDestroyed()) return;
              win.webContents
                .capturePage()
                .then((image) => {
                  writeFileSync(shotPath, image.toPNG());
                  appLog(`screenshot saved: ${shotPath}`);
                })
                .catch((err: Error) => appLog(`screenshot failed: ${err.message}`));
            }, 4000);
          }
        })
        .catch(() => appLog(`page loaded: url=${url}`));
    });

    win.on('close', () => {
      if (win !== null && !win.isDestroyed()) saveWindowState(win);
    });

    win.on('closed', () => {
      win = null;
    });

    win.loadFile(localShellFile()).catch((err: Error) => appLog(`loadFile failed: ${err.message}`));
    return win;
  }

  /** IPC may only be driven by the local shell page, never by the harness UI. */
  function isLocalSender(event: IpcMainInvokeEvent): boolean {
    return event.senderFrame?.url.startsWith('file://') ?? false;
  }

  ipcMain.handle('app:pick-workspace', async (event) => {
    if (!isLocalSender(event) || win === null) return null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a workspace folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const check = validateWorkspace(result.filePaths[0] ?? '');
    if (!check.ok) return { error: check.reason };
    allowedWorkspaces.add(check.path);
    return check.path;
  });

  ipcMain.handle('app:start', async (event, candidate: unknown) => {
    if (!isLocalSender(event)) throw new Error('app:start rejected: sender is not the local shell page');
    const isRecent =
      typeof candidate === 'string' && recents.some((r) => r.path.toLowerCase() === candidate.toLowerCase());
    if (typeof candidate !== 'string' || !(allowedWorkspaces.has(candidate) || isRecent)) {
      throw new Error('app:start rejected: folder was never selected through the picker');
    }
    const check = validateWorkspace(candidate);
    if (!check.ok) return { accepted: false, error: check.reason };
    recents = touchRecent(recents, check.path);
    saveRecents(recents);
    startHarness(check.path);
    return { accepted: true };
  });

  ipcMain.handle('app:remove-recent', async (event, candidate: unknown) => {
    if (!isLocalSender(event)) throw new Error('app:remove-recent rejected: sender is not the local shell page');
    if (typeof candidate !== 'string') return;
    recents = removeRecentPath(recents, candidate);
    saveRecents(recents);
    pushState();
  });

  ipcMain.handle('app:retry', async (event) => {
    if (!isLocalSender(event)) throw new Error('app:retry rejected: sender is not the local shell page');
    if (currentWorkspace !== null) startHarness(currentWorkspace);
  });

  ipcMain.handle('app:restart', async (event) => {
    if (!isLocalSender(event)) throw new Error('app:restart rejected: sender is not the local shell page');
    await harness.restart();
  });

  ipcMain.handle('app:back-to-workspaces', async (event) => {
    if (!isLocalSender(event)) throw new Error('app:back-to-workspaces rejected: sender is not the local shell page');
    await backToWorkspaces();
  });

  ipcMain.handle('app:choose-another', async (event) => {
    if (!isLocalSender(event)) throw new Error('app:choose-another rejected: sender is not the local shell page');
    await backToWorkspaces();
  });

  ipcMain.handle('app:get-logs', (event) => {
    if (!isLocalSender(event)) throw new Error('app:get-logs rejected: sender is not the local shell page');
    const logs = harness.getLogs();
    return { stdout: sanitizeLogs(logs.stdout), stderr: sanitizeLogs(logs.stderr) };
  });

  ipcMain.handle('app:copy-logs', (event) => {
    if (!isLocalSender(event)) throw new Error('app:copy-logs rejected: sender is not the local shell page');
    const logs = harness.getLogs();
    const text = sanitizeLogs(`[stdout]\n${logs.stdout}\n\n[stderr]\n${logs.stderr}`);
    clipboard.writeText(text);
    appLog(`copy-logs: wrote ${text.length} sanitized chars to the clipboard`);
  });

  ipcMain.handle('app:get-state', (event) => {
    if (!isLocalSender(event)) throw new Error('app:get-state rejected: sender is not the local shell page');
    const raw = harness.getState();
    return {
      ...raw,
      workspace: currentWorkspace ?? raw.workspace,
      logs: { stdout: sanitizeLogs(raw.logs.stdout), stderr: sanitizeLogs(raw.logs.stderr) },
      recents: recentsWithExistence(recents),
    };
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    const fromArgv = workspaceFromArgv(process.argv);
    if (fromArgv !== null) {
      const check = validateWorkspace(fromArgv);
      if (check.ok) {
        allowedWorkspaces.add(check.path);
        recents = touchRecent(recents, check.path);
        saveRecents(recents);
        startHarness(check.path);
      } else {
        appLog(`--workspace invalid: ${check.reason}`);
      }
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    if (harness.isActive()) {
      event.preventDefault();
      appLog('before-quit: stopping harness');
      // The stop itself is bounded (taskkill timeout + exit wait), and this
      // race is a final safety cap so quit can never hang indefinitely.
      Promise.race([harness.stop('quit'), new Promise((resolve) => setTimeout(resolve, QUIT_STOP_TIMEOUT_MS))]).finally(() => {
        shutdownDone = true;
        appLog('harness stopped');
        app.quit();
      });
    } else {
      shutdownDone = true;
    }
  });
}
