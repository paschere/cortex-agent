import { describe, expect, it } from 'vitest';
import {
  ActionIntegrityError,
  type ActionRow,
  assertExecutable,
  canonicalJson,
  fingerprint,
  isApprovable,
} from '../shape';

/**
 * The two functions the whole feature rests on, tested without a database.
 *
 * If `fingerprint` is not stable, every approval is refused for no reason and
 * people learn to ignore the warning. If `assertExecutable` is not strict,
 * something goes out that nobody agreed to. Both failures are silent in
 * ordinary use, which is why they are pinned here rather than left to the
 * integration path to notice.
 */

const PAYLOAD = {
  to: ['cartera@coltrans.co'],
  subject: 'Cartera pendiente — Factura 4471',
  body: 'Buen día,\n\nLa factura 4471 venció hace 47 días.',
};

function row(over: Partial<ActionRow> = {}): ActionRow {
  const input = (over.tool_input ?? PAYLOAD) as ActionRow['tool_input'];
  return {
    id: 'a1',
    user_id: 'u1',
    agent_id: 'ag1',
    conversation_id: null,
    kind: 'collect_payment',
    tool_id: 'gmail.send_message',
    tool_input: input,
    content_hash: fingerprint(input),
    recipient: 'cartera@coltrans.co',
    subject: PAYLOAD.subject,
    origin_kind: 'commitment',
    origin_id: 'c1',
    rationale: 'Coltrans lleva 47 días de mora.',
    client_id: null,
    state: 'approved',
    expires_at: '2099-01-01T00:00:00.000Z',
    decided_at: '2026-08-01T12:00:00.000Z',
    decided_by: 'u1',
    decided_via: 'web',
    dismissed_reason: null,
    executed_at: null,
    execution_status: null,
    execution_error: null,
    execution_result: null,
    thread_id: null,
    outcome: 'none',
    outcome_at: null,
    outcome_note: null,
    edited_count: 0,
    created_at: '2026-08-01T11:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    ...over,
  };
}

describe('fingerprint', () => {
  it('does not depend on the order the keys were written in', () => {
    // The failure this prevents: the same payload round-tripped through two
    // code paths (the tool's zod parse, a JSON column, the API body) comes back
    // with its keys in a different order. If that changed the fingerprint,
    // every approval would be refused as "the text changed" when nothing did —
    // and a warning that cries wolf on the send screen is worse than none.
    const a = { to: ['x@y.co'], subject: 'S', body: 'B' };
    const b = { body: 'B', subject: 'S', to: ['x@y.co'] };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('sorts keys at every depth, not just the top', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('does not reorder arrays, because order is meaning in a recipient list', () => {
    expect(fingerprint({ to: ['a@x.co', 'b@x.co'] })).not.toBe(
      fingerprint({ to: ['b@x.co', 'a@x.co'] }),
    );
  });

  it('survives a JSON round trip, which is what the database does to it', () => {
    const once = fingerprint(PAYLOAD);
    expect(fingerprint(JSON.parse(JSON.stringify(PAYLOAD)))).toBe(once);
  });

  it('changes when a single character of the body changes', () => {
    const edited = { ...PAYLOAD, body: `${PAYLOAD.body}.` };
    expect(fingerprint(edited)).not.toBe(fingerprint(PAYLOAD));
  });

  it('changes when the recipient changes, even if the text does not', () => {
    const redirected = { ...PAYLOAD, to: ['otro@empresa.co'] };
    expect(fingerprint(redirected)).not.toBe(fingerprint(PAYLOAD));
  });
});

describe('assertExecutable', () => {
  it('accepts the ordinary case: approved, unrun, and the hash that was approved', () => {
    const r = row();
    expect(() => assertExecutable(r, r.content_hash)).not.toThrow();
  });

  it('refuses an action nobody approved', () => {
    const r = row({ state: 'proposed', decided_at: null, decided_by: null });
    expect(() => assertExecutable(r, r.content_hash)).toThrow(ActionIntegrityError);
  });

  it('refuses an action that was discarded', () => {
    const r = row({ state: 'dismissed' });
    expect(() => assertExecutable(r, r.content_hash)).toThrow(/dismissed/);
  });

  it('refuses to run the same approval twice', () => {
    const r = row({ executed_at: '2026-08-01T12:00:05.000Z' });
    expect(() => assertExecutable(r, r.content_hash)).toThrow(/already ran/);
  });

  it('refuses when the approver signed off on different text', () => {
    const r = row();
    const otherText = fingerprint({ ...PAYLOAD, body: 'Otra cosa' });
    expect(() => assertExecutable(r, otherText)).toThrow(/approved against/);
  });

  it('refuses a row whose stored hash does not describe its stored content', () => {
    // Only reachable if the database trigger were bypassed or the hash forged.
    // It must still be refused rather than assumed away: this is the one check
    // standing between a tampered row and somebody's signature on an email.
    const r = row({ content_hash: 'f'.repeat(64) });
    expect(() => assertExecutable(r, 'f'.repeat(64))).toThrow(/fingerprint mismatch/);
  });

  it('says something a person can act on, in Spanish', () => {
    const r = row({ state: 'proposed', decided_at: null, decided_by: null });
    try {
      assertExecutable(r, r.content_hash);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ActionIntegrityError).spanish).toMatch(/no se ejecutó nada/i);
    }
  });
});

describe('isApprovable', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');

  it('is true for an open proposal inside its window', () => {
    expect(isApprovable({ state: 'proposed', expires_at: '2026-08-05T00:00:00Z' }, now)).toBe(true);
  });

  it('is false once the window has passed — expiry revokes, it never executes', () => {
    expect(isApprovable({ state: 'proposed', expires_at: '2026-07-30T00:00:00Z' }, now)).toBe(false);
  });

  it('is false for anything already decided', () => {
    expect(isApprovable({ state: 'approved', expires_at: '2026-08-05T00:00:00Z' }, now)).toBe(false);
  });
});
