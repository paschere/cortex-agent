/**
 * The retrieval thresholds, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once already: green locally, red in the deploy.
 *
 * `commitments-shape.ts` documents the same wall and solves it the same way.
 * Types are fine to import (they erase); values are not.
 *
 * WHAT NEEDS THEM IN THE BROWSER. The memory bench draws every retrieved
 * fragment on one rail with these two thresholds engraved on it as fixed ticks,
 * so you can see which fragments cleared the bar and by how much. The ticks have
 * to sit at the real numbers or the whole instrument is a lie.
 *
 * These are copies, and copies drift. `kb-relevance-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree.
 */

/** A passage that answers the question. Raw cosine, not the blended score. */
export const STRONG_MATCH = 0.55;

/** Below this a passage is not offered as a citation at all. */
export const WEAK_FLOOR = 0.45;

/**
 * The top of the rail. Not a threshold — a drawing decision.
 *
 * Cosine similarity between a question and a passage that answers it lands
 * between 0.55 and 0.70 in practice (see the measurement in relevance.ts), and
 * a rail drawn to 1.0 would squash every real result into its bottom two
 * thirds and make the thresholds indistinguishable. 0.80 keeps the interesting
 * band legible while leaving headroom above the best score ever measured.
 */
export const RAIL_CEILING = 0.8;

/** What a fragment's rating is called on screen, in the reader's language. */
export type FragmentVerdict = 'strong' | 'weak' | 'dropped';

export const VERDICT_LABEL: Record<FragmentVerdict, string> = {
  strong: 'Responde',
  weak: 'Apenas relacionado',
  dropped: 'No llegó',
};

/**
 * Where a score sits on the rail, 0–1, clamped.
 *
 * Null cosine means the semantic arm never ran for that row — keyword-only
 * retrieval — and there is no honest position for it on a cosine rail, so the
 * bench draws no bar at all rather than a bar at zero, which would read as a
 * measured certain miss.
 */
export function railPosition(cosine: number | null): number | null {
  if (cosine === null || !Number.isFinite(cosine)) return null;
  return Math.max(0, Math.min(1, cosine / RAIL_CEILING));
}

/** The same cut relevance.ts makes, so the rail and the verdict never disagree. */
export function verdictOf(cosine: number | null, keyword: number): FragmentVerdict {
  if (cosine === null) return keyword > 0 ? 'weak' : 'dropped';
  if (cosine >= STRONG_MATCH) return 'strong';
  if (cosine >= WEAK_FLOOR) return 'weak';
  return 'dropped';
}
