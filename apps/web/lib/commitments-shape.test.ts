import {
  COMMITMENT_KINDS as CANONICAL_KINDS,
  DEFAULT_NOTICE_DAYS as CANONICAL_NOTICE_DAYS,
  KIND_LABEL as CANONICAL_LABEL,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { COMMITMENT_KINDS, DEFAULT_NOTICE_DAYS, KIND_LABEL } from './commitments-shape';

/**
 * `commitments-shape.ts` restates three values the browser needs, because
 * importing them from the package drags a Node builtin into the client bundle.
 * This test is the other half of that bargain: it runs in Node, so it may import
 * the real module, and it fails the moment the two disagree.
 *
 * Without it the copy is a silent fork — someone adds a kind to the package, the
 * new-commitment dialog never offers it, and nothing anywhere goes red.
 */
describe('commitment vocabulary mirrored for the client', () => {
  it('lists exactly the kinds the package defines, in the same order', () => {
    expect([...COMMITMENT_KINDS]).toEqual([...CANONICAL_KINDS]);
  });

  it('carries the same default notice window for every kind', () => {
    expect(DEFAULT_NOTICE_DAYS).toEqual(CANONICAL_NOTICE_DAYS);
  });

  it('carries the same Spanish label for every kind', () => {
    expect(KIND_LABEL).toEqual(CANONICAL_LABEL);
  });
});
