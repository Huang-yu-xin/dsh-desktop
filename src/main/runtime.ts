/**
 * B1 runtime resolution: the harness runs on Electron's own embedded Node
 * (process.execPath + ELECTRON_RUN_AS_NODE=1) against the bundled
 * @deepseek-ai/dsh production dependency. No system Node, npm, or npx is
 * ever involved — in dev OR in the packaged app.
 *
 * DEV      node_modules root = <project>/node_modules
 * PACKAGED node_modules root = <resources>/dsh-runtime/node_modules
 *          (a complete production tree staged by scripts/stage-runtime.cjs
 *          with the official npm resolver and shipped via extraResources;
 *          an external Node-mode child process cannot read app.asar, and
 *          electron-builder's own dependency collector mis-prunes the graph)
 */
import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HarnessRuntime {
  /** The Node-mode executable: the Electron binary itself. */
  executablePath: string;
  /** Absolute path of the official dsh CLI entry (lib/bin.js). */
  binPath: string;
  /** The node_modules root the DSH tree resolves from. */
  nodeModulesRoot: string;
  /** The pinned DSH version read from its package.json (or null). */
  version: string | null;
}

/** Raised when the bundled runtime is missing or incomplete. */
export class HarnessRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessRuntimeUnavailableError';
  }
}

/** Environment overrides applied to every harness child process. */
export function harnessEnv(): Record<string, string> {
  return { ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
}

/**
 * Resolve the bundled harness runtime. Throws a typed error when the
 * packaged/development tree does not carry the pinned DSH package — the
 * caller turns that into the local error page (never an npm/npx fallback).
 */
export function resolveHarnessRuntime(): HarnessRuntime {
  const executablePath = process.execPath;
  const nodeModulesRoot = app.isPackaged
    ? join(process.resourcesPath, 'dsh-runtime', 'node_modules')
    : join(__dirname, '..', '..', 'node_modules');
  const binPath = join(nodeModulesRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(binPath)) {
    throw new HarnessRuntimeUnavailableError(
      `bundled DeepSeek Harness runtime not found (expected ${binPath})`,
    );
  }
  let version: string | null = null;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(nodeModulesRoot, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    );
    version = typeof (manifest as { version?: unknown }).version === 'string'
      ? (manifest as { version: string }).version
      : null;
  } catch {
    version = null;
  }
  return { executablePath, binPath, nodeModulesRoot, version };
}
