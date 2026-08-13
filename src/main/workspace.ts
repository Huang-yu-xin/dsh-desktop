/**
 * Workspace handling: existence/directory validation (read-only — the app
 * never writes into the workspace) and the --workspace CLI affordance used
 * for scripted verification.
 *
 * Recent-workspace storage lives in the app's own userData directory and
 * contains ONLY directory paths + timestamps. No credentials, model config,
 * session, git or project data ever goes in there.
 */
import { app } from 'electron';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_RECENTS = 10;

export interface RecentWorkspace {
  path: string;
  lastOpenedAt: number;
}

/** A recent entry enriched with its current on-disk existence. */
export interface RecentWorkspaceView extends RecentWorkspace {
  exists: boolean;
}

export type WorkspaceCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Validate a user-supplied folder: it must exist and be a directory.
 * Nothing inside the workspace is created or modified.
 */
export function validateWorkspace(candidate: string): WorkspaceCheck {
  if (candidate.trim() === '') return { ok: false, reason: 'no folder selected' };
  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    return { ok: false, reason: `path does not exist: ${candidate}` };
  }
  if (!stats.isDirectory()) return { ok: false, reason: `not a directory: ${candidate}` };
  return { ok: true, path: candidate };
}

/** Dev/verification affordance: `electron . --workspace <dir>` skips the picker. */
export function workspaceFromArgv(argv: readonly string[]): string | null {
  const idx = argv.indexOf('--workspace');
  const value = idx >= 0 ? argv[idx + 1] : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function recentsFilePath(): string {
  return join(app.getPath('userData'), 'recent-workspaces.json');
}

/**
 * Load the recent list, dropping every malformed entry (wrong types, junk
 * shapes). Never throws — a corrupt file just behaves like an empty list.
 */
export function loadRecents(): RecentWorkspace[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(recentsFilePath(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    const valid: RecentWorkspace[] = [];
    for (const entry of raw) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as RecentWorkspace).path === 'string' &&
        (entry as RecentWorkspace).path.trim() !== '' &&
        typeof (entry as RecentWorkspace).lastOpenedAt === 'number' &&
        Number.isFinite((entry as RecentWorkspace).lastOpenedAt)
      ) {
        valid.push({ path: (entry as RecentWorkspace).path, lastOpenedAt: (entry as RecentWorkspace).lastOpenedAt });
        if (valid.length === MAX_RECENTS) break;
      }
    }
    return valid;
  } catch {
    return [];
  }
}

/** Persist the list (bounded, best effort — never throws). */
export function saveRecents(list: readonly RecentWorkspace[]): void {
  try {
    writeFileSync(recentsFilePath(), JSON.stringify(list.slice(0, MAX_RECENTS), null, 2));
  } catch {
    // Non-fatal: recents are convenience state, not app-critical data.
  }
}

/** Most-recent-first, deduplicated case-insensitively by path. */
export function touchRecent(list: readonly RecentWorkspace[], path: string, at = Date.now()): RecentWorkspace[] {
  const lower = path.toLowerCase();
  return [{ path, lastOpenedAt: at }, ...list.filter((r) => r.path.toLowerCase() !== lower)].slice(0, MAX_RECENTS);
}

export function removeRecentPath(list: readonly RecentWorkspace[], path: string): RecentWorkspace[] {
  const lower = path.toLowerCase();
  return list.filter((r) => r.path.toLowerCase() !== lower);
}

/** The renderer view: each entry plus whether the folder still exists. */
export function recentsWithExistence(list: readonly RecentWorkspace[]): RecentWorkspaceView[] {
  return list.map((r) => {
    let exists = false;
    try {
      exists = statSync(r.path).isDirectory();
    } catch {
      exists = false;
    }
    return { ...r, exists };
  });
}
