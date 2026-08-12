/**
 * THE CEILING, AND WHY IT SITS EXACTLY HERE.
 *
 * An errand is the first thing in this product that spends money with nobody
 * watching. A chat turn is bounded by a person's patience; an orchestrator run
 * is bounded by one objective and one plan. An errand can decide, on its own,
 * that it needs another leg — and a loop that can extend itself is a loop that
 * needs a wall.
 *
 * ── WHERE THE WALL IS: AT THE LEG BOUNDARY ────────────────────────────────
 *
 * The ceiling is checked BEFORE a leg is launched and never during one, for
 * the same reason the orchestrator only cancels between waves: mid-leg the
 * tokens are already spent. Stopping halfway through a sub-agent's turn buys
 * nothing and throws away what it was about to produce. The leg boundary is
 * the only place where stopping is free, so it is the only place the check
 * lives — and `LEG_RESERVE_TOKENS` is what makes that honest: a leg is not
 * started unless a whole leg's worth of headroom remains, so the ceiling is a
 * ceiling rather than a number the last leg is allowed to sail past.
 *
 * ── TWO CEILINGS, NOT ONE ─────────────────────────────────────────────────
 *
 * Tokens bound the bill. Legs bound the WANDERING — a research errand that has
 * had three goes at a subject and still wants a fourth has not found a harder
 * problem, it has found an unanswerable one, and the honest move is to deliver
 * what it has and say what is missing. Either ceiling stops it. They fail
 * differently and both are cheap to state.
 *
 * ── AND ONE MORE, AT THE DOOR ─────────────────────────────────────────────
 *
 * `MAX_LIVE_ERRANDS` caps how many a workspace can have in flight. Per-errand
 * ceilings bound one errand; only this bounds someone launching twenty in a
 * minute. It also protects the Inngest concurrency budget, which is shared
 * with every other background job in the install.
 *
 * ── WHAT AN ERRAND DOES *NOT* METER ───────────────────────────────────────
 *
 * `usage_events` (0085) counts answers and documents, and it is written by
 * database triggers on `messages` and `kb_documents` — never by application
 * code, deliberately, so it cannot drift or double-charge. An errand inserts
 * into neither table, so it records no usage event, and this module does not
 * try to invent one. What it does instead is refuse to START when the
 * workspace's `answers` meter is already refusing chat turns: a workspace that
 * cannot answer a question has no business commissioning an hour of autonomous
 * research. That check is in the create route, where a session exists.
 */

import type { ErrandKind } from './shape';

/**
 * Tokens one leg is assumed to need. Derived from the orchestrator's own
 * shape rather than guessed: a plan call, up to eight sub-agents at ten tool
 * steps each, and a synthesis. Real runs come in well under this; the number
 * exists to reserve headroom, so overestimating is the safe direction.
 */
export const LEG_RESERVE_TOKENS = 90_000;

/** Floor and ceiling on what a person may set. */
export const MIN_TOKEN_CEILING = 100_000;
export const MAX_TOKEN_CEILING = 1_500_000;
export const MAX_LEG_CEILING = 6;

/**
 * Live errands per workspace. Three, because that is one more than the number
 * anybody can actually keep track of, and because each one can hold an
 * orchestrator run — whose own concurrency limit is five, shared with every
 * scheduled routine and document ingest in the install.
 */
export const MAX_LIVE_ERRANDS = 3;

/** Checks a monitor may perform before it closes itself out. */
export const MAX_MONITOR_CHECKS = 30;

export interface Spend {
  tokensSpent: number;
  tokenCeiling: number;
  legsUsed: number;
  legCeiling: number;
}

export type StopReason = 'tokens' | 'legs';

export type BudgetVerdict = { ok: true; headroom: number } | { ok: false; reason: StopReason };

/**
 * May another leg be launched?
 *
 * Legs first, because "you have had enough goes at this" is a more useful thing
 * to tell somebody than "you ran out of tokens", and when both are true the
 * first is the real reason.
 */
export function canStartLeg(spend: Spend): BudgetVerdict {
  if (spend.legsUsed >= spend.legCeiling) return { ok: false, reason: 'legs' };
  const headroom = spend.tokenCeiling - spend.tokensSpent;
  if (headroom < LEG_RESERVE_TOKENS) return { ok: false, reason: 'tokens' };
  return { ok: true, headroom };
}

/** Fraction of the token ceiling consumed, clamped to 0..1. */
export function spentFraction(spend: Pick<Spend, 'tokensSpent' | 'tokenCeiling'>): number {
  if (spend.tokenCeiling <= 0) return 1;
  return Math.min(1, Math.max(0, spend.tokensSpent / spend.tokenCeiling));
}

/**
 * The sentence an errand closes with when the ceiling is what stopped it.
 *
 * Written to be read by the person who will decide whether to relaunch it, so
 * it says what was spent, what it bought, and what to do — never an apology.
 */
export function exhaustedNote(spend: Spend, reason: StopReason): string {
  const tokens = spend.tokensSpent.toLocaleString('es-CO');
  const ceiling = spend.tokenCeiling.toLocaleString('es-CO');
  if (reason === 'legs') {
    return (
      `Este encargo llegó a su tope de ${spend.legCeiling} ` +
      `${spend.legCeiling === 1 ? 'vuelta' : 'vueltas'} y se cerró con lo que alcanzó a reunir ` +
      `(${tokens} tokens). Tres intentos sin cerrar el tema casi nunca significan que faltaba una ` +
      'vuelta más: suele significar que la pregunta era más ancha de lo que parecía. Vuelve a ' +
      'encargarlo acotado, o súbele el tope si de verdad necesitas que siga.'
    );
  }
  return (
    `Este encargo llegó a su tope de consumo (${tokens} de ${ceiling} tokens) y se cerró con lo ` +
    'que alcanzó a reunir. No falló: paró donde le dijiste que parara. Lo de arriba es real y ' +
    'está con sus fuentes; si quieres que siga, vuelve a encargarlo con un tope más alto.'
  );
}

/** Defaults for a new errand of this kind, clamped into the allowed range. */
export function ceilingsFor(
  kind: ErrandKind,
  defaults: { defaultTokenCeiling: number; defaultLegCeiling: number },
  requested?: { tokenCeiling?: number; legCeiling?: number },
): { tokenCeiling: number; legCeiling: number } {
  const tokenCeiling = clamp(
    requested?.tokenCeiling ?? defaults.defaultTokenCeiling,
    MIN_TOKEN_CEILING,
    MAX_TOKEN_CEILING,
  );
  const legCeiling = clamp(requested?.legCeiling ?? defaults.defaultLegCeiling, 1, MAX_LEG_CEILING);
  // A monitor spends across many looks; anything else is one investigation.
  void kind;
  return { tokenCeiling, legCeiling };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
