/**
 * Central V1 constants. The pinned harness package spec is the one lever that
 * keeps the desktop app on a known DeepSeek Harness release while the package
 * is in Developer Preview: bump it deliberately, never follow `latest`
 * silently. A future version can also swap this for a project-local binary.
 */
export const HARNESS_PACKAGE_SPEC = '@deepseek-ai/dsh@0.1.0-rc.6';

/** Binary the pinned package exports (its package.json `bin.dsh`). */
export const HARNESS_BIN = 'dsh';

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

/** Hard cap on retained harness stdout/stderr (the tail is kept). */
export const MAX_CAPTURED_LOG_CHARS = 262_144;

/** Node range the official CLI documents (repo `engines`). */
export const REQUIRED_NODE_RANGE = '^22.19.0 || >=24.0.0';
