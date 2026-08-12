/**
 * Everything this process needs to know, read once and validated loudly.
 *
 * Same reasoning as services/whatsapp/src/config.ts: a service that boots with
 * a missing variable and only finds out when the first errand fails is the
 * worst failure mode for something that runs unattended. A missing required
 * value stops the process with a sentence naming it.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // Not thrown as an Error: this is the last thing anybody reads in the
    // Railway deploy log, and a stack trace above it helps nobody.
    console.error(
      [
        '',
        `[cortex-browser] ${name} is not set, so this service cannot start.`,
        '  BROWSER_SERVICE_TOKEN   the shared secret, same value as in Cortex',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface Config {
  serviceToken: string;
  port: number;
  /** Ceiling on one whole errand. */
  runTimeoutMs: number;
  /** Ceiling on one step inside it. */
  stepTimeoutMs: number;
  /**
   * How long an interactive session (the reasoned baseline, and the benchmark)
   * may sit idle before it is swept. A leaked context is a leaked Chromium
   * tab, and a handful of those is the whole container's memory.
   */
  sessionIdleMs: number;
  /** Hard cap on concurrent contexts, so a burst cannot exhaust the box. */
  maxConcurrent: number;
  /** Viewport every run gets, so a flow taught on one shape replays on it. */
  viewportWidth: number;
  viewportHeight: number;
  userAgent: string | null;
}

export function loadConfig(): Config {
  return {
    serviceToken: required('BROWSER_SERVICE_TOKEN'),
    port: number('PORT', 3300),
    runTimeoutMs: number('BROWSER_RUN_TIMEOUT_MS', 180_000),
    stepTimeoutMs: number('BROWSER_STEP_TIMEOUT_MS', 20_000),
    sessionIdleMs: number('BROWSER_SESSION_IDLE_MS', 5 * 60_000),
    maxConcurrent: number('BROWSER_MAX_CONCURRENT', 3),
    // A fixed desktop viewport, and fixed matters more than the numbers. Many
    // portals collapse a form into a hamburger below ~900px, which changes
    // which controls exist; a flow taught at one width and replayed at another
    // would fail for a reason nobody could see in the step list.
    viewportWidth: number('BROWSER_VIEWPORT_WIDTH', 1366),
    viewportHeight: number('BROWSER_VIEWPORT_HEIGHT', 900),
    userAgent: process.env.BROWSER_USER_AGENT?.trim() || null,
  };
}
