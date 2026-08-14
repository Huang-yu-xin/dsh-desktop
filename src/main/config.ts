/**
 * Central V1 constants. The pinned harness package spec documents the exact
 * release bundled as a production dependency (see package.json); the actual
 * spawn path resolves it locally through src/main/runtime.ts — npm/npx are
 * never used at runtime.
 */
export const HARNESS_PACKAGE_SPEC = '@deepseek-ai/dsh@0.1.0-rc.6';

/** Fixed argument vector: loopback bind + OS-assigned port (no port races). */
export const HARNESS_ARGS: readonly string[] = ['web', '--host', '127.0.0.1', '--port', '0'];

/** Official readiness line printed by `dsh web` once the whole tree is up. */
export const READY_LINE_PATTERN = /dsh web:\s+(http:\/\/[^\s]+)/;

/**
 * How long we wait for the readiness line. Generous on purpose: the first
 * launch downloads the whole pinned package graph into npx's cache (observed
 * to take several minutes on a cold machine); later launches are fast.
 */
export const READY_LINE_TIMEOUT_MS = 600_000;

/** After the readiness line, GET / must answer 200 within this budget. */
export const HTTP_CONFIRM_TIMEOUT_MS = 15_000;

/** Poll interval for the HTTP confirmation loop. */
export const HTTP_POLL_INTERVAL_MS = 500;

/** Hard cap on retained harness stdout/stderr (the tail is kept, per stream). */
export const MAX_CAPTURED_LOG_CHARS = 262_144;

/** Interval between post-ready health checks (GET / on the harness origin). */
export const HEALTH_CHECK_INTERVAL_MS = 5_000;

/** Per-request timeout for one health check. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/** Consecutive failures required before the state becomes `disconnected`. */
export const HEALTH_FAIL_THRESHOLD = 3;

/** Upper bound for waiting on the child to exit after taskkill. */
export const STOP_WAIT_TIMEOUT_MS = 10_000;

/** Upper bound for the taskkill subprocess itself. */
export const TASKKILL_TIMEOUT_MS = 5_000;

/** Hard cap for the whole quit-time stop() before the app exits anyway. */
export const QUIT_STOP_TIMEOUT_MS = 15_000;
