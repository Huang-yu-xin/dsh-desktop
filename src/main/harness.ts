/**
 * HarnessController owns the DeepSeek Harness subprocess lifecycle:
 * spawn (pinned spec, fixed argv), readiness (official stdout line, then an
 * HTTP 200 confirmation), failure capture, and process-tree termination.
 * Logs are kept here in raw form; sanitization happens at the IPC boundary.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import {
  HTTP_CONFIRM_TIMEOUT_MS,
  HTTP_POLL_INTERVAL_MS,
  MAX_CAPTURED_LOG_CHARS,
  READY_LINE_PATTERN,
  READY_LINE_TIMEOUT_MS,
  REQUIRED_NODE_RANGE,
} from './config';
import { findNodeToolchain, killProcessTree, spawnHarness } from './process';

export type HarnessPhase =
  | 'idle'
  | 'starting'
  | 'awaiting-url'
  | 'awaiting-http'
  | 'ready'
  | 'stopping'
  | 'failed';

export interface HarnessState {
  phase: HarnessPhase;
  workspace: string | null;
  url: string | null;
  error: string | null;
  pid: number | null;
  /** Raw tail of captured stdout/stderr (sanitized before reaching the UI). */
  logTail: string;
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
  private error: string | null = null;
  private logBuffer = '';
  private readinessTimer: NodeJS.Timeout | null = null;
  private httpDeadline = 0;
  private stopRequested = false;

  getState(): HarnessState {
    return {
      phase: this.phase,
      workspace: this.workspace,
      url: this.url,
      error: this.error,
      pid: this.child?.pid ?? null,
      logTail: this.logBuffer,
    };
  }

  isRunning(): boolean {
    return (
      this.phase === 'starting' ||
      this.phase === 'awaiting-url' ||
      this.phase === 'awaiting-http' ||
      this.phase === 'ready'
    );
  }

  /**
   * Spawn the harness for a workspace and drive it to `ready`.
   * Never rejects; every failure lands in the `failed` state.
   */
  async start(workspace: string): Promise<void> {
    if (this.isRunning() || this.phase === 'stopping') return;
    // Enter the running phase first so every failure below can be recorded.
    this.setPhase('starting');
    // A previous failed run may still hold a dying child: make sure it is gone.
    if (this.child !== null && this.child.pid !== undefined && this.child.exitCode === null) {
      await killProcessTree(this.child.pid);
    }
    this.workspace = workspace;
    this.url = null;
    this.error = null;
    this.logBuffer = '';
    this.stopRequested = false;

    const toolchain = findNodeToolchain();
    if (toolchain === null) {
      this.fail(`Node.js/npm not found: install Node.js ${REQUIRED_NODE_RANGE} and make sure "npm" is on PATH`);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnHarness(toolchain, workspace);
    } catch (err) {
      this.fail(`failed to spawn harness: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendLog(chunk);
      this.scanReadiness();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendLog(chunk);
      this.scanReadiness();
    });
    child.once('error', (err) => {
      this.fail(`harness process error: ${err.message}`);
    });
    child.once('exit', (code, signal) => {
      this.onChildExit(code, signal);
    });
    this.emit('spawned', child.pid);
    this.readinessTimer = setTimeout(() => {
      this.fail(`timed out after ${Math.round(READY_LINE_TIMEOUT_MS / 1000)}s waiting for the "dsh web:" readiness line`);
    }, READY_LINE_TIMEOUT_MS);
    this.setPhase('awaiting-url');
  }

  /**
   * Terminate the harness tree (idempotent). Used on quit and on
   * "choose another workspace".
   */
  async stop(): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'stopping') return;
    this.stopRequested = true;
    this.clearTimers();
    const child = this.child;
    this.setPhase('stopping');
    if (child !== null && child.pid !== undefined && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await killProcessTree(child.pid);
      await Promise.race([exited, sleep(5000)]);
    }
    this.child = null;
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

  private appendLog(chunk: Buffer): void {
    this.logBuffer += chunk.toString('utf8');
    if (this.logBuffer.length > MAX_CAPTURED_LOG_CHARS) {
      this.logBuffer = this.logBuffer.slice(-MAX_CAPTURED_LOG_CHARS);
    }
  }

  /** Look for the official `dsh web: http://…` line in everything captured so far. */
  private scanReadiness(): void {
    if (this.phase !== 'awaiting-url') return;
    const match = READY_LINE_PATTERN.exec(this.logBuffer);
    if (match === null) return;
    this.url = match[1] ?? null;
    this.clearTimers();
    this.setPhase('awaiting-http');
    this.httpDeadline = Date.now() + HTTP_CONFIRM_TIMEOUT_MS;
    void this.pollHttp().catch((err: Error) => {
      if (this.phase === 'awaiting-http') this.fail(err.message);
    });
  }

  private async pollHttp(): Promise<void> {
    while (this.phase === 'awaiting-http' && Date.now() < this.httpDeadline) {
      if (this.url !== null && (await httpGetOk(this.url, 2000))) {
        this.setPhase('ready');
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

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopRequested) return;
    if (this.isRunning()) {
      this.fail(`harness process exited unexpectedly (code ${code ?? '?'}, signal ${signal ?? 'none'})`);
    }
  }

  private fail(reason: string): void {
    if (this.phase === 'idle' || this.phase === 'stopping') return;
    this.clearTimers();
    this.error = reason;
    this.setPhase('failed');
    if (this.child !== null && this.child.pid !== undefined && this.child.exitCode === null) {
      void killProcessTree(this.child.pid);
    }
  }
}
