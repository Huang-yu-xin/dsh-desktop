/**
 * Minimal window-state persistence: width, height, x, y, maximized.
 * Stored under Electron userData (never in the workspace, never harness
 * config). Coordinates are validated against the current displays on load;
 * off-screen states fall back to a default position.
 */
import { app, screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 860, maximized: false };
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
/** Pixels of overlap required for the stored bounds to count as visible. */
const VISIBLE_OVERLAP = 80;

function stateFilePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/** Load and validate the stored state; a corrupt file behaves like no file. */
export function loadWindowState(): WindowState {
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFilePath(), 'utf8'));
    if (raw !== null && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const width =
        typeof r.width === 'number' && Number.isFinite(r.width) && r.width >= MIN_WIDTH
          ? Math.round(r.width)
          : DEFAULT_STATE.width;
      const height =
        typeof r.height === 'number' && Number.isFinite(r.height) && r.height >= MIN_HEIGHT
          ? Math.round(r.height)
          : DEFAULT_STATE.height;
      const x = typeof r.x === 'number' && Number.isFinite(r.x) ? Math.round(r.x) : undefined;
      const y = typeof r.y === 'number' && Number.isFinite(r.y) ? Math.round(r.y) : undefined;
      return { width, height, x, y, maximized: r.maximized === true };
    }
  } catch {
    // Fall through to defaults.
  }
  return { ...DEFAULT_STATE, x: undefined, y: undefined };
}

/**
 * Keep the stored position only when the window would visibly overlap at
 * least one current display's work area; otherwise drop the coordinates so
 * the OS/Electron picks a visible default.
 */
export function validatedWindowState(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      state.x! < area.x + area.width - VISIBLE_OVERLAP &&
      state.x! + state.width > area.x + VISIBLE_OVERLAP &&
      state.y! < area.y + area.height - VISIBLE_OVERLAP &&
      state.y! + state.height > area.y + VISIBLE_OVERLAP
    );
  });
  return visible ? state : { width: state.width, height: state.height, maximized: false, x: undefined, y: undefined };
}

/** Persist the current bounds + maximized flag (best effort, never throws). */
export function saveWindowState(win: BrowserWindow): void {
  try {
    const maximized = win.isMaximized();
    const bounds: Rectangle = win.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized,
    };
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
  } catch {
    // Window state is convenience data; failures are ignored.
  }
}
