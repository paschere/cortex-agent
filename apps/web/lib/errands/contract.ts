/**
 * THE ERRAND CONTRACT: what the HTTP surface, the worker and the sweep agree on.
 *
 * ── ONE EVENT, NOT A PHASE PER EVENT ──────────────────────────────────────
 *
 * There is a single event, `errand/advance`, and it carries no instruction —
 * only which errand to look at and on whose behalf. The worker re-reads the
 * rows and works out for itself what the errand needs next
 * (lib/errands/engine.ts `decideNext`).
 *
 * That is deliberate and it is the difference between a durable machine and a
 * fragile one. An event that said "now assess leg 2" would be a decision made
 * at send time and acted on at receive time, with a redeploy, a crash and an
 * unknown delay in between — and the moment those two disagree the errand does
 * the wrong thing to the wrong leg. An event that says "look again" cannot be
 * stale, cannot be applied twice to any effect, and can be re-sent by anybody
 * (the sweep, a person answering a question, the worker itself) without
 * anybody having to know what state the errand was in.
 *
 * ── NO SESSION OUT HERE ───────────────────────────────────────────────────
 *
 * The workspace and the person ride on the event, exactly as the orchestrator's
 * `run.started` does, because a background function has no session to ask. Both
 * are also on the errand row; the event carries them so the very first read is
 * already scoped, and so an id from another workspace simply finds nothing.
 */

/** Sent to move an errand one step. Idempotent by design — see above. */
export const EVENT_ERRAND_ADVANCE = 'errand/advance' as const;

export interface ErrandAdvanceEvent {
  errandId: string;
  /** The workspace every database handle in the worker is pinned to. */
  organizationId: string;
  /**
   * Whose grants and tool denials the legs inherit. Read off the errand row
   * when absent — an errand outlives the request that created it, and the
   * sweep sends this event without one.
   */
  userId?: string | null;
  /** Free-text, for the Inngest timeline only. Never read as an instruction. */
  because?: string;
}
