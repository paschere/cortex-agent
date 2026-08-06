import {
  STRONG_MATCH as CANONICAL_STRONG,
  WEAK_FLOOR as CANONICAL_WEAK,
  DEFAULT_CALIBRATION,
  rateHit,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CUTS,
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
 * measured against a line that is no longer where the line is. That is not
 * hypothetical: the floor moved from 0,45 to 0,34 when the corpus was re-run
 * against the model actually in production, and this file is what makes the
 * browser move with it.
 */
describe('retrieval thresholds mirrored for the client', () => {
  it('carries the same strong-match cut as the package', () => {
    expect(STRONG_MATCH).toBe(CANONICAL_STRONG);
  });

  it('carries the same weak floor as the package', () => {
    expect(WEAK_FLOOR).toBe(CANONICAL_WEAK);
  });

  /**
   * The constants above are the DEFAULT MODEL's cuts, and the package derives
   * them from its calibration table rather than restating them. If the mirror
   * ever drifts from the calibration itself, the two assertions above could
   * still pass while the bench drew ticks for a model nobody is running.
   */
  it('mirrors the calibration of the model this deployment actually embeds with', () => {
    expect(DEFAULT_CUTS.strongMatch).toBe(DEFAULT_CALIBRATION.strongMatch);
    expect(DEFAULT_CUTS.weakFloor).toBe(DEFAULT_CALIBRATION.weakFloor);
    expect(DEFAULT_CUTS.railCeiling).toBe(DEFAULT_CALIBRATION.railCeiling);
    expect(DEFAULT_CALIBRATION.measured).toBe(true);
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
      const canonical = rateHit({ semanticScore: rounded, keywordScore: 0 }, DEFAULT_CALIBRATION);
      const mine = verdictOf(rounded, 0);
      expect(mine).toBe(canonical ?? 'dropped');
    }
  });

  it('agrees with rateHit when the semantic arm did not run', () => {
    expect(verdictOf(null, 0.2)).toBe(
      rateHit({ semanticScore: null, keywordScore: 0.2 }, DEFAULT_CALIBRATION),
    );
    expect(verdictOf(null, 0)).toBe('dropped');
    expect(rateHit({ semanticScore: null, keywordScore: 0 }, DEFAULT_CALIBRATION)).toBeNull();
  });

  /**
   * The bench draws whichever cuts the probe was really judged with, so the
   * rail has to honour a scale it was handed rather than the module constants.
   */
  it('draws a rail from the cuts it is given, not from its own copy', () => {
    const other = { strongMatch: 0.53, weakFloor: 0.48, railCeiling: 0.85 };
    expect(verdictOf(0.5, 0, other)).toBe('weak');
    expect(verdictOf(0.5, 0)).toBe('strong');
    expect(railPosition(0.85, other.railCeiling)).toBe(1);
  });

  it('places a score on the rail, clamped, and refuses to place an unmeasured one', () => {
    expect(railPosition(0)).toBe(0);
    expect(railPosition(RAIL_CEILING)).toBe(1);
    expect(railPosition(2)).toBe(1);
    expect(railPosition(null)).toBeNull();
    expect(railPosition(Number.NaN)).toBeNull();
  });
});
