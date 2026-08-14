/**
 * HarnessController owns the DeepSeek Harness subprocess lifecycle and is the
 * ONLY entry point for it (index.ts / renderer / workspace modules never
 * spawn or kill directly).
 *
 * V1.1 reliability model:
 * - all lifecycle operations run through one promise queue, so start/stop/
 *   restart are serialized and idempotent (no double spawn, no races);
 * - `exit` / `close` / `error` are all observed, and expected shutdowns
 *   (quit/restart/back) are distinguished from unexpected exits;
 * - every failure carries a classified reason (kind + message);
 * - after `ready`, a lightweight health monitor polls GET / on the harness
 *   origin only. It NEVER kills a live process: consecutive failures move the
 *   state to `disconnected` and leave the decision to the user.
 * Logs are kept per stream in raw form; sanitization happens at the IPC
 * boundary (see logs.ts).
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import {
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_FAIL_THRESHOLD,
  HTTP_CONFIRM_TIMEOUT_MS,
  HTTP_POLL_INTERVAL_MS,
  MAX_CAPTURED_LOG_CHARS,
  READY_LINE_PATTERN,
  READY_LINE_TIMEOUT_MS,
  STOP_WAIT_TIMEOUT_MS,
} from './config';
import { killProcessTree, spawnHarness } from './process';
import type { KillResult } from './process';
import { resolveHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';

export type HarnessPhase =
  | 'idle'
  | 'starting'
  | 'awaiting-url'
  | 'awaiting-http'
  | 'ready'
  | 'stopping'
  | 'failed'
  | 'disconnected';

/** Who asked for a stop — expected shutdowns are never treated as crashes. */
export type StopReason = 'quit' | 'restart' | 'back' | 'startup-failure-cleanup';

/** Classified failure kinds shown on the lost/error pages. */
export type FailureKind =
  | 'startup-failed'
  | 'process-exited'
  | 'process-error'
  | 'unexpected-exit-code'
  | 'health-check-failed'
  | 'unknown';

export interface HarnessReason {
  kind: FailureKind;
  message: string;
}

export interface HarnessLogs {
  stdout: string;
  stderr: string;
}

export interface HarnessState {
  phase: HarnessPhase;
  workspace: string | null;
  url: string | null;
  pid: number | null;
  reason: HarnessReason | null;
  /** Raw per-stream tails (sanitized before reaching the UI). */
  logs: HarnessLogs;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One GET against the harness origin; resolves true only on HTTP 200. */
function httpGetOk(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.once('error', () => resolve(false));
  });
}

export class HarnessController extends EventEmitter {
  private child: ChildProcess | null = null;
  private phase: HarnessPhase = 'idle';
  private workspace: string | null = null;
  private url: string | null = null;
  private reason: HarnessReason | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readinessTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFailures = 0;
  private httpDeadline = 0;
  private stopRequested = false;
  private exitHandled = false;
  /** Serializes every lifecycle operation; see enqueue(). */
  private queue: Promise<void> = Promise.resolve();

  getState(): HarnessState {
    return {
      phase: this.phase,
      workspace: this.workspace,
      url: this.url,
      pid: this.child?.pid ?? null,
      reason: this.reason,
      logs: this.getLogs(),
    };
  }

  getLogs(): HarnessLogs {
    return { stdout: this.stdoutBuffer, stderr: this.stderrBuffer };
  }

  isRunning(): boolean {
    return (
      this.phase === 'starting' ||
      this.phase === 'awaiting-url' ||
      this.phase === 'awaiting-http' ||
      this.phase === 'ready'
    );
  }

  /** A live process may exist while running OR while merely disconnected. */
  isActive(): boolean {
    return this.isRunning() || this.phase === 'disconnected' || this.phase === 'stopping';
  }

  /** Serialize one lifecycle operation after any in-flight one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Spawn the harness for a workspace and drive it to `ready`.
   * Serialized; a call while another lifecycle operation is in flight waits.
   */
  start(workspace: string): Promise<void> {
    return this.enqueue(() => this.startInternal(workspace));
  }

  /** Terminate the harness tree (serialized, idempotent). */
  stop(reason: StopReason): Promise<void> {
    return this.enqueue(() => this.stopInternal(reason));
  }

  /** stop + start on the same workspace; a user-driven recovery action. */
  restart(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.workspace;
      if (current === null) return;
      await this.stopInternal('restart');
      await this.startInternal(current);
    });
  }

  private async startInternal(workspace: string): Promise<void> {
    if (this.isRunning() || this.phase === 'stopping') return;
    // Enter the running phase first so every failure below can be recorded.
    this.setPhase('starting');
    // A previous failed run may still hold a dying child: make sure it is gone.
    if (this.child !== null && this.child.pid !== undefined && this.child.exitCode === null) {
      const kill = await killProcessTree(this.child.pid);
      if (!kill.ok) this.emit('log', `cleanup kill: ${kill.detail}`);
    }
    this.workspace = workspace;
    this.url = null;
    this.reason = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stopRequested = false;
    this.exitHandled = false;
    this.healthFailures = 0;

    let runtime: HarnessRuntime;
    try {
      runtime = resolveHarnessRuntime();
      this.emit('log', `bundled harness runtime: ${runtime.binPath} (dsh ${runtime.version ?? 'unknown'})`);
    } catch (err) {
      this.fail('startup-failed', err instanceof Error ? err.message : String(err));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnHarness(runtime, workspace);
    } catch (err) {
      this.fail('startup-failed', `failed to spawn harness: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendLog('stdout', chunk);
      this.scanReadiness();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendLog('stderr', chunk);
      this.scanReadiness();
    });
    child.once('error', (err) => {
      this.fail('process-error', `harness process error: ${err.message}`);
    });
    child.once('exit', (code, signal) => {
      this.onChildExit(code, signal);
    });
    child.once('close', (code, signal) => {
      // 'exit' is authoritative; 'close' is a fallback for odd paths where
      // exit was not observed (both may fire — handled exactly once).
      if (!this.exitHandled) this.onChildExit(code, signal);
    });
    this.emit('spawned', child.pid);
    this.readinessTimer = setTimeout(() => {
      this.fail(
        'startup-failed',
        `timed out after ${Math.round(READY_LINE_TIMEOUT_MS / 1000)}s waiting for the "dsh web:" readiness line`,
      );
    }, READY_LINE_TIMEOUT_MS);
    this.setPhase('awaiting-url');
  }

  private async stopInternal(reason: StopReason): Promise<void> {
    if (this.phase === 'idle') return;
    if (this.phase === 'stopping') return;
    this.stopRequested = true;
    this.clearTimers();
    this.stopHealthMonitor();
    const child = this.child;
    this.setPhase('stopping');
    if (child !== null && child.pid !== undefined && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const kill: KillResult = await killProcessTree(child.pid);
      this.emit('log', `stop (${reason}): ${kill.detail}`);
      if (!kill.ok) {
        this.emit('log', `stop (${reason}): taskkill failed, falling back to child.kill`);
        try {
          child.kill();
        } catch {
          // Last resort already attempted; the exit-wait below still caps us.
        }
      }
      await Promise.race([exited, sleep(STOP_WAIT_TIMEOUT_MS)]);
      if (child.exitCode === null && child.signalCode === null) {
        this.emit('log', `stop (${reason}): child did not exit within ${STOP_WAIT_TIMEOUT_MS}ms`);
      }
    }
    this.child = null;
    this.workspace = null;
    this.url = null;
    this.reason = null;
    this.setPhase('idle');
  }

  private setPhase(phase: HarnessPhase): void {
    this.phase = phase;
    this.emit('state', this.getState());
  }

  private clearTimers(): void {
    if (this.readinessTimer !== null) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = null;
    }
  }

  private appendLog(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const buffer = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    this[buffer] += chunk.toString('utf8');
    if (this[buffer].length > MAX_CAPTURED_LOG_CHARS) {
      this[buffer] = this[buffer].slice(-MAX_CAPTURED_LOG_CHARS);
    }
  }

  /** Look for the official `dsh web: http://…` line in everything captured so far. */
  private scanReadiness(): void {
    if (this.phase !== 'awaiting-url') return;
    const match = READY_LINE_PATTERN.exec(this.stdoutBuffer);
    if (match === null) return;
    this.url = match[1] ?? null;
    this.clearTimers();
    this.setPhase('awaiting-http');
    this.httpDeadline = Date.now() + HTTP_CONFIRM_TIMEOUT_MS;
    void this.pollHttp().catch((err: Error) => {
      if (this.phase === 'awaiting-http') this.fail('startup-failed', err.message);
    });
  }

  private async pollHttp(): Promise<void> {
    while (this.phase === 'awaiting-http' && Date.now() < this.httpDeadline) {
      if (this.url !== null && (await httpGetOk(this.url, 2000))) {
        this.setPhase('ready');
        this.startHealthMonitor();
        return;
      }
      await sleep(HTTP_POLL_INTERVAL_MS);
    }
    if (this.phase === 'awaiting-http') {
      throw new Error(
        `harness printed its readiness line but GET ${this.url ?? '(unknown)'} never returned 200 within ${Math.round(HTTP_CONFIRM_TIMEOUT_MS / 1000)}s`,
      );
    }
  }

  // ── post-ready health monitor ────────────────────────────────────────────
  // Detection only: consecutive GET / failures on the harness origin move the
  // state to `disconnected`. A live process is NEVER killed here — only the
  // user (restart / back / quit) can trigger stop().

  private startHealthMonitor(): void {
    this.stopHealthMonitor();
    this.healthFailures = 0;
    const tick = (): void => {
      if (this.phase !== 'ready') return;
      const url = this.url;
      if (url === null) return;
      void httpGetOk(url, HEALTH_CHECK_TIMEOUT_MS).then((ok) => {
        if (this.phase !== 'ready') return;
        if (ok) {
          const recovered = this.healthFailures > 0;
          this.healthFailures = 0;
          this.emit('health', { ok: true, consecutiveFailures: 0, recovered });
        } else {
          this.healthFailures += 1;
          this.emit('health', { ok: false, consecutiveFailures: this.healthFailures, recovered: false });
          if (this.healthFailures >= HEALTH_FAIL_THRESHOLD && this.child !== null && this.child.exitCode === null) {
            this.reason = {
              kind: 'health-check-failed',
              message:
                `health check failed ${this.healthFailures} times in a row (GET ${url}) while the harness process is still alive`,
            };
            this.setPhase('disconnected');
            return;
          }
        }
        if (this.phase === 'ready') this.healthTimer = setTimeout(tick, HEALTH_CHECK_INTERVAL_MS);
      });
    };
    this.healthTimer = setTimeout(tick, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer !== null) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // ── child lifecycle ──────────────────────────────────────────────────────

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitHandled = true;
    if (this.stopRequested || this.phase === 'stopping' || this.phase === 'idle') return;
    if (this.phase === 'failed' || this.phase === 'disconnected') return;
    if (!this.isRunning()) return;
    const codeText = code ?? '?';
    const signalText = signal ?? 'none';
    const duringStartup = this.phase === 'starting' || this.phase === 'awaiting-url' || this.phase === 'awaiting-http';
    if (duringStartup && code !== null && code !== 0) {
      this.fail('unexpected-exit-code', `harness exited with code ${codeText} before becoming ready (signal ${signalText})`);
      return;
    }
    this.fail('process-exited', `harness process exited unexpectedly (code ${codeText}, signal ${signalText})`);
  }

  private fail(kind: FailureKind, message: string): void {
    if (this.phase === 'idle' || this.phase === 'stopping') return;
    this.clearTimers();
    this.stopHealthMonitor();
    this.reason = { kind, message };
    this.setPhase('failed');
    if (this.child !== null && this.child.pid !== undefined && this.child.exitCode === null) {
      void killProcessTree(this.child.pid).then((kill) => {
        if (!kill.ok) this.emit('log', `failure cleanup kill: ${kill.detail}`);
      });
    }
  }
}
