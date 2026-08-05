/**
 * When is a run dead?
 *
 * A process that dies cannot report that it died, so the only evidence anyone
 * ever gets is SILENCE: the run stops advancing `last_heartbeat_at` and stops
 * appending events. Everything here turns that silence into a decision, in one
 * place, shared by the executor, the sweep and the browser — because a console
 * that draws "Ejecutando" while the sweep is about to close the run would just
 * be a shorter version of the same lie.
 *
 * Deliberately free of server-only imports: the live console imports it too.
 *
 * ── THE THRESHOLDS, AND WHY THESE NUMBERS ─────────────────────────────────
 *
 * A run beats at least every `HEARTBEAT_INTERVAL_MS` while it is doing
 * ANYTHING — every event it appends touches the row, throttled to that interval
 * so the log's write volume does not double — plus once at every Inngest step
 * boundary. So silence is not a proxy for "slow"; it is a proxy for "nothing at
 * all has happened".
 *
 * QUIET_AFTER_MS (3 min) is what the SCREEN reacts to. It is not a verdict, it
 * is a hedge: the interface stops asserting "ejecutando" and starts saying how
 * long it has been since anything happened. Three minutes is longer than any
 * single sub-agent step should take (one model call plus one tool call) and
 * short enough that a person watching a dead run finds out while they are still
 * looking at it.
 *
 * STALE_AFTER_MS (15 min) is what the SWEEP acts on, and it is deliberately
 * five times the screen's hedge, because the two mistakes are not symmetrical:
 * a premature close kills legitimate work and throws away tokens somebody paid
 * for, while a late close costs an already-hedged screen a few more minutes.
 * Fifteen minutes is thirty consecutive missed heartbeats. It covers the
 * longest silences a healthy run can produce — a slow model call inside a
 * sub-agent turn, a tool waiting on somebody else's API, and a run sitting in
 * Inngest's queue waiting for a concurrency slot behind other runs — while
 * bounding the "ejecutando" lie to a quarter of an hour instead of for ever.
 *
 * If you change these: STALE_AFTER_MS must stay comfortably above
 * QUIET_AFTER_MS, and both must stay well above HEARTBEAT_INTERVAL_MS, or the
 * sweep starts eating live runs between beats.
 */

import type { RunStatus } from './types';

/** How often a working run touches `last_heartbeat_at`. See lifecycle.ts. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Silence after which the SCREEN stops claiming the run is working. */
export const QUIET_AFTER_MS = 3 * 60_000;

/** Silence after which the SWEEP declares the run interrupted. */
export const STALE_AFTER_MS = 15 * 60_000;

/** Statuses that mean "something should be happening right now". */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ['planning', 'running'];

export function isLive(status: RunStatus): boolean {
  return LIVE_RUN_STATUSES.includes(status);
}

/** The minimum a run needs to have its liveness judged. */
export interface LivenessInput {
  status: RunStatus;
  lastHeartbeatAt: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
}

/**
 * How long this run has been silent, in ms — or null when the question does not
 * apply (the run already ended, or no timestamp is readable).
 *
 * Falls back to `startedAt`/`createdAt` so a row written before migration 0070
 * still gets an answer instead of looking eternally fresh.
 */
export function silenceMs(run: LivenessInput, now: number): number | null {
  if (!isLive(run.status)) return null;
  const stamp = run.lastHeartbeatAt ?? run.startedAt ?? run.createdAt ?? null;
  if (!stamp) return null;
  const at = new Date(stamp).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

/** The screen's hedge: live, but nothing has happened for a worrying while. */
export function isQuiet(run: LivenessInput, now: number): boolean {
  const silence = silenceMs(run, now);
  return silence !== null && silence >= QUIET_AFTER_MS;
}

/** The sweep's verdict: silent long enough to be declared interrupted. */
export function isStale(run: LivenessInput, now: number): boolean {
  const silence = silenceMs(run, now);
  return silence !== null && silence >= STALE_AFTER_MS;
}

/** The instant before which a live run counts as abandoned. */
export function staleCutoffIso(now: number = Date.now()): string {
  return new Date(now - STALE_AFTER_MS).toISOString();
}

// ---------------------------------------------------------------------------
// What an interrupted run says for itself
// ---------------------------------------------------------------------------
//
// Screen text, so Colombian Spanish. Kept beside the thresholds because these
// strings and those numbers are the same decision seen from two sides, and
// because migration 0070 repeats them in SQL to close the runs that were
// already hanging when it landed.

/** The report an interrupted run ends up with, when it never wrote its own. */
export const INTERRUPTED_SUMMARY = [
  '**Esta ejecución se interrumpió.**',
  '',
  'Dejó de dar señales de vida y no escribió su informe final, así que la damos por muerta. ' +
    'No falló por sí sola y nadie la detuvo: lo más probable es que el proceso que la ejecutaba ' +
    'se haya caído o lo haya reemplazado un despliegue. Lo que alcanzaron a producir los ' +
    'subagentes de arriba se conservó. Vuelve a lanzar el objetivo cuando quieras.',
].join('\n');

/** Console line for the moment the sweep closes a run. */
export const INTERRUPTED_EVENT_MESSAGE =
  'Esta ejecución dejó de dar señales y se dio por interrumpida.';

/** A sub-agent that was working when the run went silent. */
export const INTERRUPTED_TASK_ERROR =
  'Este subagente iba trabajando cuando la ejecución se interrumpió. No alcanzó a entregar su resultado.';

/** A sub-agent whose turn never came. */
export const SKIPPED_TASK_ERROR =
  'La ejecución se interrumpió antes de que a este subagente le llegara el turno.';

/** A sub-agent that was working when a person pressed Detener. */
export const CANCELLED_TASK_ERROR =
  'Detuviste la ejecución mientras este subagente trabajaba, así que no alcanzó a entregar su resultado.';

/** A sub-agent whose turn never came because a person stopped the run. */
export const CANCELLED_PENDING_TASK_ERROR =
  'Detuviste la ejecución antes de que a este subagente le llegara el turno.';
