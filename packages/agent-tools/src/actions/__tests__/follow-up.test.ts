import { describe, expect, it } from 'vitest';
import type { CommitmentRow } from '../../commitments/shape';
import { draftCollectionNotice, draftOwnerReminder, longDate } from '../draft';
import { addressOf, findReply, silenceIsFinal } from '../follow-up';
import { planOwnerReminders } from '../sweep';

/**
 * Closing the loop, and the wording that opens it.
 *
 * The reply detector is the one piece of this feature that can lie in a way
 * nobody notices: a false positive marks a cobro as answered when nobody
 * answered, and the invoice quietly stops being chased. So both of its
 * conditions are pinned here — the clock and the sender — because either one on
 * its own gets it exactly wrong.
 */

const SENT_AT = new Date('2026-08-01T15:00:00.000Z');
const US = 'ana@coltrans.co';

describe('findReply', () => {
  it('sees a genuine reply from the other side', () => {
    const verdict = findReply(
      [
        { from: `Ana <${US}>`, date: 'Sat, 1 Aug 2026 15:00:00 -0500' },
        { from: 'Cartera Coltrans <pagos@cliente.co>', date: 'Mon, 3 Aug 2026 09:12:00 -0500' },
      ],
      { executedAt: SENT_AT, ourAddresses: [US] },
    );
    expect(verdict.replied).toBe(true);
    expect(verdict.note).toContain('pagos@cliente.co');
  });

  it('does not count our own message as an answer to itself', () => {
    // Without the sender check every action closes itself the instant it is
    // sent, and the queue reports a 100% response rate forever.
    const verdict = findReply(
      [{ from: `"Ana Gómez" <${US.toUpperCase()}>`, date: 'Mon, 3 Aug 2026 09:12:00 -0500' }],
      { executedAt: SENT_AT, ourAddresses: [US] },
    );
    expect(verdict.replied).toBe(false);
  });

  it('does not count the client\'s ORIGINAL email as a reply to our answer', () => {
    // Without the clock, every reply_to_client action closes on the message it
    // was written to answer.
    const verdict = findReply(
      [
        { from: 'Cliente <pagos@cliente.co>', date: 'Fri, 31 Jul 2026 08:00:00 -0500' },
        { from: `Ana <${US}>`, date: 'Sat, 1 Aug 2026 15:00:00 -0500' },
      ],
      { executedAt: SENT_AT, ourAddresses: [US] },
    );
    expect(verdict.replied).toBe(false);
  });

  it('treats an unreadable date as not-a-reply', () => {
    // The cheap mistake is leaving a loop open one sweep longer. The expensive
    // one is telling somebody a client answered when they did not.
    const verdict = findReply([{ from: 'Cliente <pagos@cliente.co>', date: 'not a date' }], {
      executedAt: SENT_AT,
      ourAddresses: [US],
    });
    expect(verdict.replied).toBe(false);
  });
});

describe('addressOf', () => {
  it('pulls the address out of a display-name header', () => {
    expect(addressOf('"Ana Gómez" <ANA@Coltrans.co>')).toBe('ana@coltrans.co');
  });
  it('accepts a bare address', () => {
    expect(addressOf('ana@coltrans.co')).toBe('ana@coltrans.co');
  });
  it('returns null for something that is not one', () => {
    expect(addressOf('undisclosed recipients')).toBeNull();
    expect(addressOf(null)).toBeNull();
  });
});

describe('silenceIsFinal', () => {
  it('is false while the window is still open', () => {
    expect(silenceIsFinal('2026-08-01T15:00:00Z', new Date('2026-08-05T15:00:00Z'))).toBe(false);
  });
  it('is true once ten days have passed', () => {
    expect(silenceIsFinal('2026-08-01T15:00:00Z', new Date('2026-08-12T15:00:00Z'))).toBe(true);
  });
  it('is false for something that never ran', () => {
    expect(silenceIsFinal(null, new Date())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

function commitment(over: Partial<CommitmentRow> = {}): CommitmentRow {
  return {
    id: 'c1',
    title: 'Factura 4471',
    detail: null,
    kind: 'payment',
    counterparty: 'Coltrans',
    amount_cop: 12_400_000,
    due_on: '2026-06-15',
    notice_days: 3,
    state: 'overdue',
    met_at: null,
    met_by: null,
    met_note: null,
    dropped_at: null,
    dropped_reason: null,
    owner_user_id: 'u1',
    escalate_to_user_id: null,
    escalate_after_days: 3,
    source_kind: 'manual',
    source_system: null,
    source_read_at: null,
    source_user_id: 'u1',
    source_document_id: null,
    source_chunk_id: null,
    source_quote: null,
    review_state: 'confirmed',
    confirmed_at: null,
    confirmed_by: null,
    vehicle_id: null,
    recurrence: 'none',
    series_id: 's1',
    previous_commitment_id: null,
    calendar_event_id: null,
    calendar_id: null,
    calendar_user_id: null,
    calendar_synced_due_on: null,
    calendar_error: null,
    created_by: 'u1',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    source_user_name: 'Ana Gómez',
    ...over,
  };
}

describe('the drafted text', () => {
  it('counts the days of arrears rather than asserting a remembered number', () => {
    // 15 June to 1 August is 47 days. Every figure in a cobro is a claim about
    // money, and this is the one the recipient checks first.
    const draft = draftCollectionNotice(commitment(), '2026-08-01');
    expect(draft.body).toContain('47 días de mora');
    expect(draft.body).toContain(longDate('2026-06-15'));
    expect(draft.body).toContain('$12.400.000 COP');
  });

  it('addresses a client as usted and a colleague as tú', () => {
    const toClient = draftCollectionNotice(commitment(), '2026-08-01');
    expect(toClient.body).toContain('Le agradecemos');
    expect(toClient.body).not.toMatch(/\b(tienes|puedes)\b/);

    const toColleague = draftOwnerReminder(commitment(), '2026-08-01', 'Ana');
    expect(toColleague.body).toContain('Hola Ana,');
    expect(toColleague.body).toMatch(/\bquieres\b/);
  });

  it('cites where the date came from, in the reminder', () => {
    const draft = draftOwnerReminder(
      commitment({
        kind: 'soat',
        title: 'SOAT WNK123',
        due_on: '2026-08-10',
        amount_cop: null,
        source_kind: 'system',
        source_system: 'RUNT',
        source_read_at: '2026-07-20T10:00:00Z',
        source_user_id: null,
        vehicle_plate: 'WNK123',
      }),
      '2026-08-01',
      'Ana',
    );
    expect(draft.subject).toContain('SOAT');
    expect(draft.subject).toContain('WNK123');
    expect(draft.body).toContain('vence en 9 días');
    expect(draft.body).toContain('RUNT');
  });

  it('omits the amount rather than inventing one', () => {
    const draft = draftCollectionNotice(commitment({ amount_cop: null }), '2026-08-01');
    expect(draft.body).not.toContain('COP');
    expect(draft.body).toContain('47 días de mora');
  });
});

describe('planOwnerReminders', () => {
  const today = '2026-08-01';

  it('offers what is lapsing or lapsed, and nothing that is simply in force', () => {
    const plan = planOwnerReminders({
      commitments: [
        commitment({ id: 'overdue', due_on: '2026-07-01' }),
        commitment({ id: 'soon', due_on: '2026-08-02' }),
        // Four months out, with a three-day notice window: not news.
        commitment({ id: 'later', due_on: '2026-12-01' }),
      ],
      today,
      recentOriginIds: new Set(),
    });
    expect(plan.map((c) => c.commitment.id)).toEqual(['overdue', 'soon']);
  });

  it('leaves alone anything already acted on recently', () => {
    const plan = planOwnerReminders({
      commitments: [commitment({ id: 'overdue', due_on: '2026-07-01' })],
      today,
      recentOriginIds: new Set(['overdue']),
    });
    expect(plan).toHaveLength(0);
  });

  it('skips a commitment nobody answers for', () => {
    const plan = planOwnerReminders({
      commitments: [commitment({ id: 'orphan', due_on: '2026-07-01', owner_user_id: null })],
      today,
      recentOriginIds: new Set(),
    });
    expect(plan).toHaveLength(0);
  });

  it('puts the most urgent first, so a capped run keeps what already lapsed', () => {
    const plan = planOwnerReminders({
      commitments: [
        commitment({ id: 'b', due_on: '2026-08-02' }),
        commitment({ id: 'a', due_on: '2026-06-01' }),
      ],
      today,
      recentOriginIds: new Set(),
    });
    expect(plan.map((c) => c.commitment.id)).toEqual(['a', 'b']);
  });
});
