/**
 * Windows process plumbing for the B1 runtime: spawn the pinned harness
 * through Electron's embedded Node (ELECTRON_RUN_AS_NODE=1, no npm/npx/no
 * system Node), and terminate the whole process tree with taskkill /T /F.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { HARNESS_ARGS, TASKKILL_TIMEOUT_MS } from './config';
import { harnessEnv } from './runtime';
import type { HarnessRuntime } from './runtime';

/**
 * Spawn the harness with a fixed argv (never built from user/renderer input)
 * under Electron's own Node runtime. The executable is the Electron binary
 * itself; ELECTRON_RUN_AS_NODE switches it into plain Node mode.
 *
 * `--expose-internals` is required by the official dsh loader on this
 * runtime: under system Node its node-addon-require-builtin addon can reach
 * Node internals, but Electron's Node mode lacks the embedder symbol that
 * addon needs. With the flag, the loader's own createRequire path resolves
 * `internal/modules/esm/loader` exactly as designed.
 *
 * @param runtime - resolved bundled runtime (executable + bin path).
 * @param workspace - the user-chosen directory used as the child's cwd.
 * @returns the spawned process (stdout/stderr piped; stdin ignored; console window hidden).
 */
export function spawnHarness(runtime: HarnessRuntime, workspace: string): ChildProcess {
  const options: SpawnOptions = {
    cwd: workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...harnessEnv() },
  };
  return spawn(runtime.executablePath, ['--expose-internals', runtime.binPath, ...HARNESS_ARGS], options);
}

/** Outcome of a tree termination attempt, for controller-side logging. */
export interface KillResult {
  ok: boolean;
  detail: string;
}

/**
 * Terminate a process tree. taskkill /T /F is the verified-clean way on
 * Windows: it kills the target plus every descendant. The subprocess itself
 * is bounded by a timeout, so a wedged taskkill can never hang the desktop.
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
