/**
 * Preload: the ONLY bridge between the renderer and the main process.
 * Exposes a small, fixed surface (no Node, no shell, no arbitrary commands).
 * Main-side sender checks additionally reject any caller that is not the
 * local shell page.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

interface DesktopState {
  phase: string;
  workspace: string | null;
  url: string | null;
  pid: number | null;
  reason: { kind: string; message: string } | null;
  logs: { stdout: string; stderr: string };
  recents: { path: string; lastOpenedAt: number; exists: boolean }[];
}

contextBridge.exposeInMainWorld('dshDesktop', {
  pickWorkspace: (): Promise<string | { error: string } | null> => ipcRenderer.invoke('app:pick-workspace'),
  start: (path: string): Promise<{ accepted: boolean; error?: string }> => ipcRenderer.invoke('app:start', path),
  removeRecent: (path: string): Promise<void> => ipcRenderer.invoke('app:remove-recent', path),
  retry: (): Promise<void> => ipcRenderer.invoke('app:retry'),
  restart: (): Promise<void> => ipcRenderer.invoke('app:restart'),
  backToWorkspaces: (): Promise<void> => ipcRenderer.invoke('app:back-to-workspaces'),
  chooseAnother: (): Promise<void> => ipcRenderer.invoke('app:choose-another'),
  getLogs: (): Promise<{ stdout: string; stderr: string }> => ipcRenderer.invoke('app:get-logs'),
  copyLogs: (): Promise<void> => ipcRenderer.invoke('app:copy-logs'),
  getState: (): Promise<DesktopState> => ipcRenderer.invoke('app:get-state'),
  onState: (callback: (state: DesktopState) => void): void => {
    ipcRenderer.on('app:state', (_event: IpcRendererEvent, state: DesktopState) => {
      callback(state);
    });
  },
});
