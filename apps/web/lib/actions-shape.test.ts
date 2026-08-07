import {
  ACTION_KIND_LABEL,
  ACTION_KINDS,
  ACTION_OUTCOMES,
  KIND_AUDIENCE,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  expiryPhrase,
  shortHash,
} from '@/lib/actions-shape';
import * as tools from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';

/**
 * The browser copy has to agree with the real thing.
 *
 * `lib/actions-shape.ts` exists because importing `@cortex/agent-tools` from a
 * `'use client'` component drags `node:dns` into the browser bundle and breaks
 * the production build — while `typecheck` and `test` stay green, because
 * neither bundles for the browser. So the vocabulary is duplicated, and this
 * test is what keeps the duplication honest: it runs in Node, imports the real
 * module, and fails the moment the two disagree.
 *
 * A drift here is not cosmetic. If the browser thinks `collect_payment` is
 * internal, the card stops warning that the mail is going outside the company.
 */

describe('the browser copy matches the real vocabulary', () => {
  it('has the same kinds, in the same order', () => {
    expect([...ACTION_KINDS]).toEqual([...tools.ACTION_KINDS]);
  });

  it('has the same labels', () => {
    expect(ACTION_KIND_LABEL).toEqual(tools.ACTION_KIND_LABEL);
  });

  it('agrees on who is going to read each one', () => {
    expect(KIND_AUDIENCE).toEqual(tools.KIND_AUDIENCE);
  });

  it('has the same outcomes, labels and tones', () => {
    expect([...ACTION_OUTCOMES]).toEqual([...tools.ACTION_OUTCOMES]);
    expect(OUTCOME_LABEL).toEqual(tools.OUTCOME_LABEL);
    expect(OUTCOME_TONE).toEqual(tools.OUTCOME_TONE);
  });
});

describe('shortHash', () => {
  it('shows enough of the fingerprint to be a specific thing', () => {
    const full = tools.fingerprint({ to: ['a@b.co'], subject: 'S', body: 'B' });
    expect(shortHash(full)).toHaveLength(12);
    expect(full.startsWith(shortHash(full))).toBe(true);
  });

  it('changes when the text changes, which is the whole point of showing it', () => {
    const a = tools.fingerprint({ to: ['a@b.co'], subject: 'S', body: 'B' });
    const b = tools.fingerprint({ to: ['a@b.co'], subject: 'S', body: 'B.' });
    expect(shortHash(a)).not.toBe(shortHash(b));
  });
});

describe('expiryPhrase', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');

  it('counts whole days while there are some', () => {
    expect(expiryPhrase('2026-08-04T12:00:00Z', now)).toBe('vence en 3 días');
    expect(expiryPhrase('2026-08-02T12:00:00Z', now)).toBe('vence en 1 día');
  });

  it('falls back to hours on the last day', () => {
    expect(expiryPhrase('2026-08-01T15:00:00Z', now)).toBe('vence en 3 horas');
  });

  it('says so once it has passed', () => {
    expect(expiryPhrase('2026-07-31T12:00:00Z', now)).toBe('vencida');
  });
});
