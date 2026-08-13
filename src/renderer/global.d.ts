export {};

declare global {
  interface RecentItem {
    path: string;
    lastOpenedAt: number;
    exists: boolean;
  }

  interface DesktopState {
    phase: 'idle' | 'starting' | 'awaiting-url' | 'awaiting-http' | 'ready' | 'stopping' | 'failed';
    workspace: string | null;
    url: string | null;
    error: string | null;
    pid: number | null;
    logTail: string;
    recents: RecentItem[];
  }

  interface Window {
    dshDesktop: {
      pickWorkspace(): Promise<string | { error: string } | null>;
      start(path: string): Promise<{ accepted: boolean; error?: string }>;
      removeRecent(path: string): Promise<void>;
      retry(): Promise<void>;
      chooseAnother(): Promise<void>;
      getState(): Promise<DesktopState>;
      onState(callback: (state: DesktopState) => void): void;
    };
  }
}
