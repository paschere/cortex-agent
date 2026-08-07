import type { EvalTier } from '@cortex/agent-tools';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVAL_TIERS, type EvalTierName, delta, pct, toneFor } from './evaluation-shape';

/**
 * `evaluation-shape.ts` restates for the browser what the package already knows,
 * because importing a value from `@cortex/agent-tools` in a client component
 * drags `node:dns` into the bundle and fails the production build while
 * typecheck and test stay green. This test is the other half of that bargain: it
 * runs in Node, so it may import the real module, and it fails the moment the
 * copy forks.
 *
 * The tier list is checked structurally AND at the type level. A structural
 * check alone would pass on the day somebody adds a fourth tier to the package
 * and the screen silently stops labelling it.
 */
describe('evaluation vocabulary mirrored for the client', () => {
  it('lists exactly the tiers the package defines', () => {
    expectTypeOf<EvalTierName>().toEqualTypeOf<EvalTier>();
    expect([...EVAL_TIERS].sort()).toEqual(['answers', 'live', 'offline']);
  });
});

describe('how the numbers are written', () => {
  it('rounds a ratio to a whole percentage', () => {
    expect(pct(1)).toBe('100%');
    expect(pct(0.9166)).toBe('92%');
    expect(pct(0)).toBe('0%');
  });

  it('says nothing when there is nothing to compare against', () => {
    // "no cambió" and "no hay línea base" look identical in a column of
    // numbers, and only one of them is information.
    expect(delta(undefined, 0.9)).toBeNull();
    expect(delta(0.9, 0.9)).toBeNull();
  });

  it('signs a change and gives it in points, not in percent of a percent', () => {
    expect(delta(0.8, 0.9)).toBe('+10 pts');
    expect(delta(0.9, 0.8)).toBe('−10 pts');
    expect(delta(0, 2, false)).toBe('+2');
  });

  it('knows which way each number is supposed to move', () => {
    // A rising count of discarded-correct-fragments is bad; a rising grounding
    // ratio is good. One sign, two meanings — which is why direction is an
    // argument and not inferred.
    expect(toneFor('up', 0.8, 0.9)).toBe('good');
    expect(toneFor('down', 0, 2)).toBe('bad');
    expect(toneFor('down', 2, 0)).toBe('good');
    expect(toneFor('up', 0.9, 0.9)).toBe('flat');
  });
});
