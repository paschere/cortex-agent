import {
  STRONG_MATCH as CANONICAL_STRONG,
  WEAK_FLOOR as CANONICAL_WEAK,
  rateHit,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  RAIL_CEILING,
  STRONG_MATCH,
  WEAK_FLOOR,
  railPosition,
  verdictOf,
} from './kb-relevance-shape';

/**
 * `kb-relevance-shape.ts` restates the two retrieval thresholds for the browser,
 * because importing them from the package drags a Node builtin into the client
 * bundle. This test is the other half of that bargain: it runs in Node, so it
 * may import the real module, and it fails the moment the two disagree.
 *
 * Without it the copy is a silent fork — somebody retunes the floor after a new
 * embedding model, and the bench keeps drawing its tick at the old number while
 * reporting verdicts from the new one. Every fragment on screen would then be
 * measured against a line that is no longer where the line is.
 */
describe('retrieval thresholds mirrored for the client', () => {
  it('carries the same strong-match cut as the package', () => {
    expect(STRONG_MATCH).toBe(CANONICAL_STRONG);
  });

  it('carries the same weak floor as the package', () => {
    expect(WEAK_FLOOR).toBe(CANONICAL_WEAK);
  });

  it('leaves the rail ceiling above the strong cut, or the rail cannot be read', () => {
    expect(RAIL_CEILING).toBeGreaterThan(STRONG_MATCH);
  });

  /**
   * The verdict the bench prints has to be the verdict the retrieval actually
   * made, not a second opinion computed from the same number by hand. Checked
   * across the band rather than at the two boundaries, because an off-by-one on
   * a `>=` is exactly the kind of drift that looks right in a screenshot.
   */
  it('agrees with rateHit over the whole score band', () => {
    for (let cosine = 0; cosine <= 0.8001; cosine += 0.01) {
      const rounded = Math.round(cosine * 1000) / 1000;
      const canonical = rateHit({ semanticScore: rounded, keywordScore: 0 });
      const mine = verdictOf(rounded, 0);
      expect(mine).toBe(canonical ?? 'dropped');
    }
  });

  it('agrees with rateHit when the semantic arm did not run', () => {
    expect(verdictOf(null, 0.2)).toBe(rateHit({ semanticScore: null, keywordScore: 0.2 }));
    expect(verdictOf(null, 0)).toBe('dropped');
    expect(rateHit({ semanticScore: null, keywordScore: 0 })).toBeNull();
  });

  it('places a score on the rail, clamped, and refuses to place an unmeasured one', () => {
    expect(railPosition(0)).toBe(0);
    expect(railPosition(RAIL_CEILING)).toBe(1);
    expect(railPosition(2)).toBe(1);
    expect(railPosition(null)).toBeNull();
    expect(railPosition(Number.NaN)).toBeNull();
  });
});
