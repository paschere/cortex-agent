/**
 * The one place learning touches an answer — and the fence around it.
 *
 * ---------------------------------------------------------------------------
 * THE GUARANTEE
 * ---------------------------------------------------------------------------
 * A fragment never changes relevance band. `kb/relevance.ts` decides what is
 * strong, what is weak and what is below the floor, against thresholds measured
 * per embedding model. Learning reorders WITHIN a band and does nothing else.
 *
 *   A demoted fragment that is the only strong match is still the only strong
 *   match, and is still prepended.
 *   A preferred fragment that scored below the floor stays dropped, for ever,
 *   however many people liked it.
 *
 * This is what makes the loop safe to run unattended. The worst thing a
 * poisoned or simply mistaken adjustment can do is put one passage that had
 * already earned its place above another that had also earned its place. It
 * cannot resurrect a near-miss, it cannot suppress the only answer, and it
 * cannot make Cortex assert anything at all — a claim about the world has no
 * representation in this module (see migration 0083).
 *
 * ---------------------------------------------------------------------------
 * WHY NO SCORE BIAS
 * ---------------------------------------------------------------------------
 * The obvious design is "add ±0,04 to the blended rank". It is wrong twice.
 * The blended rank's own documentation says its magnitude is meaningless — it
 * is a good ordering and nothing more — so a constant added to it means nothing
 * either, and the right value could only ever be found by fiddling. And a
 * numeric bias is the shape that grows: once the number exists, the first
 * unconvincing result makes somebody double it, and eventually it is large
 * enough to overrule the thresholds, which is precisely the thing that must
 * remain impossible.
 *
 * So the vocabulary is three tiers — first, normal, last — inside a band. It is
 * describable in one Spanish sentence on screen, which is the real test of
 * whether a mechanism is safe to run on its own.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND NO DATABASE
 * ---------------------------------------------------------------------------
 * Nothing here reads anything. The adjustments are an argument, which is also
 * what makes an A/B trivial: run the same question set with the list and with
 * `[]` and the difference is exactly what learning did.
 */

import type { ActiveAdjustment } from './types';

/** How a fragment ranks inside its band once learning has had its say. */
export type LearningTier = 'preferred' | 'normal' | 'demoted';

/**
 * The relevance band a fragment is in, as `kb/relevance.ts` rated it.
 *
 * Passed in rather than computed here. The rating depends on a calibration that
 * belongs to the embedding model that produced the score, and a module that
 * guessed at it would be exactly the kind of re-derivation this codebase keeps
 * refusing to do.
 */
export type RelevanceBand = 'strong' | 'weak' | 'dropped';

const BAND_ORDER: Record<RelevanceBand, number> = { strong: 0, weak: 1, dropped: 2 };
const TIER_ORDER: Record<LearningTier, number> = { preferred: 0, normal: 1, demoted: 2 };

/** `document:chunk` — the identity that survives a re-index. See recorder.ts. */
function keyOf(documentId: string, chunkIndex: number): string {
  return `${documentId}:${chunkIndex}`;
}

/**
 * An index over the active adjustments, built once per retrieval.
 *
 * Whole-document verdicts and per-fragment verdicts are kept apart because they
 * compose: a document marked stale can still hold one fragment somebody keeps
 * copying, and that fragment should not be dragged down with the rest of it.
 * The per-fragment verdict therefore wins where there is one.
 */
export interface LearningIndex {
  readonly fragments: ReadonlyMap<string, LearningTier>;
  readonly staleDocuments: ReadonlySet<string>;
  readonly empty: boolean;
}

export function indexAdjustments(adjustments: readonly ActiveAdjustment[]): LearningIndex {
  const fragments = new Map<string, LearningTier>();
  const staleDocuments = new Set<string>();
  for (const a of adjustments) {
    if (a.kind === 'stale_document') {
      staleDocuments.add(a.documentId);
      continue;
    }
    fragments.set(
      keyOf(a.documentId, a.chunkIndex),
      a.kind === 'prefer_fragment' ? 'preferred' : 'demoted',
    );
  }
  return {
    fragments,
    staleDocuments,
    empty: fragments.size === 0 && staleDocuments.size === 0,
  };
}

/** What learning says about one fragment. `normal` when it has never seen it. */
export function tierFor(
  index: LearningIndex,
  documentId: string,
  chunkIndex: number,
): LearningTier {
  const own = index.fragments.get(keyOf(documentId, chunkIndex));
  if (own) return own;
  return index.staleDocuments.has(documentId) ? 'demoted' : 'normal';
}

export interface RerankOptions<T> {
  /** Which fragment this row is. */
  key: (hit: T) => { documentId: string; chunkIndex: number };
  /** How `kb/relevance.ts` rated it. The band learning may not cross. */
  band: (hit: T) => RelevanceBand;
}

/**
 * Reorder a result set within its relevance bands.
 *
 * Stable: rows the index says nothing about keep the order the database gave
 * them, which is the order the scores put them in. With an empty index this
 * returns the same rows in the same order, so a workspace that has learned
 * nothing gets byte-identical retrieval to the one it had before this module
 * existed. That property is worth more than it looks — it is what makes the
 * change safe to ship to every workspace at once, and what makes an A/B
 * against the quality-evaluation suite mean something.
 */
export function rerankByLearning<T>(
  hits: readonly T[],
  index: LearningIndex,
  opts: RerankOptions<T>,
): T[] {
  if (index.empty || hits.length < 2) return [...hits];

  const decorated = hits.map((hit, position) => {
    const { documentId, chunkIndex } = opts.key(hit);
    return {
      hit,
      position,
      band: BAND_ORDER[opts.band(hit)],
      tier: TIER_ORDER[tierFor(index, documentId, chunkIndex)],
    };
  });

  decorated.sort((a, b) => {
    // The band comes first and nothing below it can outweigh it. This single
    // line is the guarantee at the top of the file.
    if (a.band !== b.band) return a.band - b.band;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.position - b.position;
  });

  return decorated.map((d) => d.hit);
}
