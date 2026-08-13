/**
 * Windows process plumbing: locate the system Node/npm toolchain, spawn the
 * pinned harness package through npm's own npx-cli.js, and terminate the
 * whole process tree with taskkill /T /F.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HARNESS_ARGS, HARNESS_BIN, HARNESS_PACKAGE_SPEC, TASKKILL_TIMEOUT_MS } from './config';

/** The system toolchain the harness runs under (never Electron's own Node). */
export interface NodeToolchain {
  /** Absolute path of the system node.exe. */
  nodePath: string;
  /** Absolute path of npm.cmd (used as a fallback spawn entry). */
  npmCmdPath: string;
  /** Absolute path of npm's npx-cli.js, or null when npm's layout differs. */
  npxCliPath: string | null;
}

/**
 * Resolve Node/npm from PATH (Explorer-launched Electron still inherits the
 * machine PATH, so this works from a packaged app too). Returns null when
 * Node.js/npm is not installed — the caller turns that into a clear error.
 */
export function findNodeToolchain(): NodeToolchain | null {
  const where = spawnSync('where.exe', ['npm'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (where.error !== undefined || where.status !== 0 || typeof where.stdout !== 'string') return null;
  const npmCmd = where.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\.cmd$/i.test(line));
  if (npmCmd === undefined) return null;
  const nodeDir = dirname(npmCmd);
  const nodePath = join(nodeDir, 'node.exe');
  if (!existsSync(nodePath)) return null;
  const npxCliPath = join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return { nodePath, npmCmdPath: npmCmd, npxCliPath: existsSync(npxCliPath) ? npxCliPath : null };
}

/**
 * Spawn the harness with a fixed argv (never built from user/renderer input).
 * Primary path runs npm's npx-cli.js under the system node.exe — no cmd.exe
 * wrapper, so the returned pid is the real node process at the tree root.
 * Fallback spawns npx.cmd directly; our args carry no spaces or quotes, so
 * Node's built-in cmd wrapping stays safe.
 *
 * @param toolchain - resolved system toolchain.
 * @param workspace - the user-chosen directory used as the child's cwd.
 * @returns the spawned process (stdout/stderr piped; stdin ignored; console window hidden).
 */
export function spawnHarness(toolchain: NodeToolchain, workspace: string): ChildProcess {
  const harnessArgs = [HARNESS_BIN, ...HARNESS_ARGS];
  const npxArgs = ['--yes', `--package=${HARNESS_PACKAGE_SPEC}`, '--', ...harnessArgs];
  const options: SpawnOptions = {
    cwd: workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', npm_config_update_notifier: 'false' },
  };
  if (toolchain.npxCliPath !== null) {
    return spawn(toolchain.nodePath, [toolchain.npxCliPath, ...npxArgs], options);
  }
  return spawn(toolchain.npmCmdPath, npxArgs, options);
}

/** Outcome of a tree termination attempt, for controller-side logging. */
export interface KillResult {
  ok: boolean;
  detail: string;
}

/**
 * Terminate a process tree. taskkill /T /F is the verified-clean way on
 * Windows: it kills the target plus every descendant (npx node, cmd shims,
 * the dsh node process and any agents it spawned). The subprocess itself is
 * bounded by a timeout, so a wedged taskkill can never hang the desktop app.
 *
 * @param pid - root process id of the tree.
 */
export function killProcessTree(pid: number, timeoutMs = TASKKILL_TIMEOUT_MS): Promise<KillResult> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = (result: KillResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killer.kill();
      finish({ ok: false, detail: `taskkill timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    killer.once('error', (err) => {
      finish({ ok: false, detail: `taskkill spawn error: ${err.message}` });
    });
    killer.once('exit', (code) => {
      finish(code === 0 ? { ok: true, detail: 'taskkill exit 0' } : { ok: false, detail: `taskkill exit ${code ?? '?'}` });
    });
  });
}
