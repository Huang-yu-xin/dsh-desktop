export {};

declare global {
  interface RecentItem {
    path: string;
    lastOpenedAt: number;
    exists: boolean;
  }

  interface DesktopReason {
    kind:
      | 'startup-failed'
      | 'process-exited'
      | 'process-error'
      | 'unexpected-exit-code'
      | 'health-check-failed'
      | 'unknown';
    message: string;
  }

  interface DesktopLogs {
    stdout: string;
    stderr: string;
  }

  interface DesktopState {
    phase: 'idle' | 'starting' | 'awaiting-url' | 'awaiting-http' | 'ready' | 'stopping' | 'failed' | 'disconnected';
    workspace: string | null;
    url: string | null;
    pid: number | null;
    reason: DesktopReason | null;
    logs: DesktopLogs;
    recents: RecentItem[];
  }

  interface Window {
    dshDesktop: {
      pickWorkspace(): Promise<string | { error: string } | null>;
      start(path: string): Promise<{ accepted: boolean; error?: string }>;
      removeRecent(path: string): Promise<void>;
      retry(): Promise<void>;
      restart(): Promise<void>;
      backToWorkspaces(): Promise<void>;
      chooseAnother(): Promise<void>;
      getLogs(): Promise<DesktopLogs>;
      copyLogs(): Promise<void>;
      getState(): Promise<DesktopState>;
      onState(callback: (state: DesktopState) => void): void;
    };
  }
}
