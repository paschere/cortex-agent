import {
  ERRAND_KINDS as CANONICAL_KINDS,
  ERRAND_BOUNDARY_NOTICE as CANONICAL_NOTICE,
  ERRAND_STATES as CANONICAL_STATES,
  type ErrandLegView as CanonicalErrandLegView,
  type ErrandQuestionView as CanonicalErrandQuestionView,
  type ErrandSource as CanonicalErrandSource,
  type ErrandView as CanonicalErrandView,
  ERRAND_KIND_SPECS,
  spentFraction as canonicalSpentFraction,
  isErrandTerminal as canonicalTerminal,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  ERRAND_BOUNDARY_NOTICE,
  ERRAND_KINDS,
  ERRAND_KIND_LABEL,
  ERRAND_STATES,
  type ErrandState,
  type ErrandLegView as MirrorErrandLegView,
  type ErrandQuestionView as MirrorErrandQuestionView,
  type ErrandSource as MirrorErrandSource,
  type ErrandView as MirrorErrandView,
  isErrandTerminal,
  spentFraction,
} from './errands-shape';

/**
 * The browser copy must not drift from the package.
 *
 * `errands-shape.ts` exists because importing `@cortex/agent-tools` from a
 * `'use client'` component drags in `node:dns` and breaks the production build
 * while typecheck and tests stay green. This test runs in Node, where both
 * imports are legal, and is the only thing standing between "a deliberate
 * copy" and "two definitions that disagree".
 *
 * It is the same guard `commitments-shape.test.ts` and `actions-shape.test.ts`
 * apply, and it earns its keep hardest on the boundary notice: that sentence is
 * the promise the product is sold on, and a screen quietly softening it while
 * the code stays strict is the failure nobody would notice.
 */
describe('errand vocabulary mirrored for the client', () => {
  it('lists exactly the kinds the package defines, in the same order', () => {
    expect([...ERRAND_KINDS]).toEqual([...CANONICAL_KINDS]);
  });

  it('lists exactly the states the package defines, in the same order', () => {
    expect([...ERRAND_STATES]).toEqual([...CANONICAL_STATES]);
  });

  it('carries the package’s own label for every kind', () => {
    for (const kind of CANONICAL_KINDS) {
      expect(ERRAND_KIND_LABEL[kind]).toBe(ERRAND_KIND_SPECS[kind].label);
    }
  });

  it('states the no-buying line in exactly the words the package does', () => {
    expect(ERRAND_BOUNDARY_NOTICE).toBe(CANONICAL_NOTICE);
    // And says the three things it must say, so a future rewrite of both
    // copies at once still has to keep the substance.
    for (const promise of ['Nunca compra', 'reserva', 'firma', 'Aprobaciones', 'Acciones']) {
      expect(ERRAND_BOUNDARY_NOTICE).toContain(promise);
    }
  });

  it('agrees about which states are finished', () => {
    for (const state of CANONICAL_STATES) {
      expect(isErrandTerminal(state as ErrandState)).toBe(canonicalTerminal(state));
    }
  });

  it('keeps the wire types assignable from the package’s own row views', () => {
    // A COMPILE-TIME assertion wearing a test's clothes. The package's
    // `toErrandView` produces what the API sends; the mirror declares what the
    // screen reads. If a field is added to one and not the other, or a type
    // narrows, this file stops compiling — which is the only way a type
    // mismatch can fail, since types have no runtime to assert against.
    //
    // Both directions, deliberately. Package → mirror catches a widened row the
    // screen has not been taught about; mirror → package catches a field the
    // screen invented and nothing produces.
    const fromPackage = null as unknown as CanonicalErrandView;
    const asMirror: MirrorErrandView = fromPackage;
    const backAgain: CanonicalErrandView = asMirror;
    expect(backAgain).toBeNull();

    const leg = null as unknown as CanonicalErrandLegView;
    const legAsMirror: MirrorErrandLegView = leg;
    expect(legAsMirror).toBeNull();

    const question = null as unknown as CanonicalErrandQuestionView;
    const questionAsMirror: MirrorErrandQuestionView = question;
    expect(questionAsMirror).toBeNull();

    const source = null as unknown as CanonicalErrandSource;
    const sourceAsMirror: MirrorErrandSource = source;
    expect(sourceAsMirror).toBeNull();
  });

  it('computes the same spend fraction', () => {
    for (const spend of [
      { tokensSpent: 0, tokenCeiling: 400_000 },
      { tokensSpent: 200_000, tokenCeiling: 400_000 },
      { tokensSpent: 900_000, tokenCeiling: 400_000 },
      { tokensSpent: 10, tokenCeiling: 0 },
    ]) {
      expect(spentFraction(spend)).toBe(canonicalSpentFraction(spend));
    }
  });
});
