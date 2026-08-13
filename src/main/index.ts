/**
 * Electron main entry: window + navigation policy + minimal IPC.
 *
 * Security model:
 * - the shell page is a local file; the harness UI is the only remote page.
 * - IPC handlers are gated: only frames on the local shell page may invoke
 *   them, so the harness page gets no usable Electron surface.
 * - the harness spawn argv is built from fixed constants in main; no shell
 *   strings ever cross the IPC boundary.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessController } from './harness';
import type { HarnessState } from './harness';
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

/** Strip obvious credential material before logs reach the renderer. */
function sanitizeLogs(text: string): string {
  return text
    .replace(
      /\b(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|API_KEY|AUTH_TOKEN|BEARER)\b\s*[=:]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED-KEY]');
}

function localShellFile(): string {
  return join(__dirname, '..', 'renderer', 'index.html');
}

function pushState(): void {
  if (win === null || win.isDestroyed()) return;
  const raw = harness.getState();
  // Recent workspaces are shell-page UI state: never push them to the
  // harness page (it gets state events but not this configuration surface).
  const onLocalShell = win.webContents.getURL().startsWith('file://');
  const state = {
    ...raw,
    workspace: currentWorkspace ?? raw.workspace,
    logTail: sanitizeLogs(raw.logTail),
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

harness.on('state', (state: HarnessState) => {
  appLog(
    `state: ${state.phase}` +
      `${state.workspace ? ` workspace=${state.workspace}` : ''}` +
      `${state.url ? ` url=${state.url}` : ''}` +
      `${state.error ? ` error=${state.error}` : ''}`,
  );
  if (state.phase === 'ready' && state.url !== null) {
    if (win !== null && !win.isDestroyed()) {
      win.loadURL(state.url).catch((err: Error) => appLog(`loadURL failed: ${err.message}`));
    }
  } else if (state.phase === 'failed') {
    showLocalShell();
  }
  pushState();
});

harness.on('spawned', (pid: number) => {
  appLog(`harness spawned: pid=${pid}`);
});

function createWindow(): BrowserWindow {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
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
  win.setMenuBarVisibility(false);

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

ipcMain.handle('app:choose-another', async (event) => {
  if (!isLocalSender(event)) throw new Error('app:choose-another rejected: sender is not the local shell page');
  await harness.stop();
  allowedWorkspaces.clear();
  currentWorkspace = null;
  showLocalShell();
});

ipcMain.handle('app:get-state', (event) => {
  if (!isLocalSender(event)) throw new Error('app:get-state rejected: sender is not the local shell page');
  const raw = harness.getState();
  return {
    ...raw,
    workspace: currentWorkspace ?? raw.workspace,
    logTail: sanitizeLogs(raw.logTail),
    recents: recentsWithExistence(recents),
  };
});

app.whenReady().then(() => {
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
  if (harness.isRunning()) {
    event.preventDefault();
    appLog('before-quit: stopping harness');
    harness.stop().finally(() => {
      shutdownDone = true;
      appLog('harness stopped');
      app.quit();
    });
  } else {
    shutdownDone = true;
  }
});
