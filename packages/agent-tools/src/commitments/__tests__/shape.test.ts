import { describe, expect, it } from 'vitest';
import {
  MissingSourceError,
  addMonths,
  bogotaToday,
  daysUntilDue,
  deriveState,
  nextDueOn,
  noticesOwed,
  sourceColumns,
} from '../shape';

/**
 * The arithmetic, tested at the places it is actually wrong in production.
 *
 * None of this needs a database, and all of it is the sort of thing that looks
 * obviously correct in review and is off by one in the evening.
 */

// ---------------------------------------------------------------------------
// "Hoy" means hoy in Colombia
// ---------------------------------------------------------------------------

describe('the calendar day in Bogotá', () => {
  it('is still yesterday when UTC has already rolled over', () => {
    // 03:30 UTC on the 5th is 22:30 on the 4th in Bogotá. Somebody working
    // late must not be told their deadline "vence hoy" a day early — this is
    // the bug that would fire every single evening.
    expect(bogotaToday(new Date('2026-09-05T03:30:00Z'))).toBe('2026-09-04');
  });

  it('rolls over at 05:00 UTC, which is midnight there', () => {
    expect(bogotaToday(new Date('2026-09-05T04:59:59Z'))).toBe('2026-09-04');
    expect(bogotaToday(new Date('2026-09-05T05:00:00Z'))).toBe('2026-09-05');
  });

  it('does not shift with daylight saving, because Colombia has none', () => {
    // Mid-July and mid-January, the two sides of the northern DST switch.
    expect(bogotaToday(new Date('2026-07-15T04:30:00Z'))).toBe('2026-07-14');
    expect(bogotaToday(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14');
  });

  it('counts whole calendar days between two dates', () => {
    expect(daysUntilDue('2026-09-14', '2026-09-04')).toBe(10);
    expect(daysUntilDue('2026-09-04', '2026-09-04')).toBe(0);
    expect(daysUntilDue('2026-08-30', '2026-09-04')).toBe(-5);
    // Across a month boundary and a leap year.
    expect(daysUntilDue('2028-03-01', '2028-02-28')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Emerald / amber / rose
// ---------------------------------------------------------------------------

describe('what state a commitment is in', () => {
  const soat = { due_on: '2026-09-14', notice_days: 30, state: 'in_force' };

  it('is in force while it is outside its own warning window', () => {
    expect(deriveState(soat, '2026-08-01')).toBe('in_force');
  });

  it('turns amber on the first day of the window, not a day either side', () => {
    expect(deriveState(soat, '2026-08-14')).toBe('in_force');
    expect(deriveState(soat, '2026-08-15')).toBe('due_soon');
  });

  it('is still due_soon on the day itself, and overdue the day after', () => {
    expect(deriveState(soat, '2026-09-14')).toBe('due_soon');
    expect(deriveState(soat, '2026-09-15')).toBe('overdue');
  });

  it('respects a different window per commitment', () => {
    const payment = { due_on: '2026-09-14', notice_days: 3, state: 'in_force' };
    expect(deriveState(payment, '2026-09-10')).toBe('in_force');
    expect(deriveState(payment, '2026-09-11')).toBe('due_soon');
  });

  it('never overrules a decision a person made', () => {
    expect(deriveState({ ...soat, state: 'met' }, '2027-01-01')).toBe('met');
    expect(deriveState({ ...soat, state: 'dropped' }, '2027-01-01')).toBe('dropped');
  });
});

// ---------------------------------------------------------------------------
// Which notices are owed
// ---------------------------------------------------------------------------

describe('which notices are owed today', () => {
  const base = {
    dueOn: '2026-09-14',
    noticeDays: 30,
    escalateAfterDays: 3,
    acknowledged: false,
  } as const;

  it('says nothing at all while the date is far away', () => {
    expect(noticesOwed({ ...base, state: 'in_force', today: '2026-07-01' })).toEqual([]);
  });

  it('warns once it is inside the window', () => {
    expect(noticesOwed({ ...base, state: 'due_soon', today: '2026-08-20' })).toEqual(['ahead']);
  });

  it('says "vence hoy" on the day, and not "ahead" as well', () => {
    expect(noticesOwed({ ...base, state: 'due_soon', today: '2026-09-14' })).toEqual(['due_today']);
  });

  it('reports it lapsed, and escalates once the grace period passes', () => {
    expect(noticesOwed({ ...base, state: 'overdue', today: '2026-09-15' })).toEqual(['overdue']);
    expect(noticesOwed({ ...base, state: 'overdue', today: '2026-09-17' })).toEqual([
      'overdue',
      'escalation',
    ]);
  });

  it('does not escalate over somebody who already answered', () => {
    expect(
      noticesOwed({ ...base, state: 'overdue', today: '2026-09-20', acknowledged: true }),
    ).toEqual(['overdue']);
  });

  it('says nothing about something already closed', () => {
    expect(noticesOwed({ ...base, state: 'met', today: '2026-09-20' })).toEqual([]);
    expect(noticesOwed({ ...base, state: 'dropped', today: '2026-09-20' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

describe('the next occurrence', () => {
  it('advances a stated cadence', () => {
    expect(nextDueOn('2026-09-14', 'monthly')).toBe('2026-10-14');
    expect(nextDueOn('2026-09-14', 'quarterly')).toBe('2026-12-14');
    expect(nextDueOn('2026-09-14', 'yearly')).toBe('2027-09-14');
  });

  it('refuses to invent one for a date a system reported', () => {
    // The whole reason `from_source` exists. RUNT reports next year's SOAT
    // expiry after the renewal; adding 365 days and filing it as read-from-RUNT
    // would be a fabricated date wearing a trustworthy label.
    expect(nextDueOn('2026-09-14', 'from_source')).toBeNull();
    expect(nextDueOn('2026-09-14', 'none')).toBeNull();
  });

  it('clamps to the end of a shorter month instead of rolling over', () => {
    // 31 January + 1 month is 28 February. `setMonth` would say 3 March, and a
    // monthly payment set up on the 31st would walk forward down the calendar.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
  });
});

// ---------------------------------------------------------------------------
// A commitment cannot exist without a source
// ---------------------------------------------------------------------------

describe('the source columns', () => {
  it('files a manual date under the person who stated it, and watches it', () => {
    const cols = sourceColumns({ kind: 'manual', userId: 'user-1' });
    expect(cols.source_kind).toBe('manual');
    expect(cols.source_user_id).toBe('user-1');
    expect(cols.review_state).toBe('confirmed');
  });

  it('files a system date with the system and the moment it was read', () => {
    const cols = sourceColumns({
      kind: 'system',
      system: 'RUNT',
      readAt: '2026-08-02T14:10:00Z',
    });
    expect(cols.source_system).toBe('RUNT');
    expect(cols.source_read_at).toBe('2026-08-02T14:10:00Z');
    expect(cols.review_state).toBe('confirmed');
  });

  it('puts an extracted date into review, never straight into surveillance', () => {
    const cols = sourceColumns({
      kind: 'document',
      documentId: 'doc-1',
      chunkId: 'chunk-1',
      quote: 'El contrato vence el 31 de diciembre de 2026.',
    });
    expect(cols.review_state).toBe('pending');
    expect(cols.confirmed_by).toBeNull();
    expect(cols.confirmed_at).toBeNull();
    expect(cols.source_quote).toContain('31 de diciembre de 2026');
  });

  it('refuses a source that cannot be checked', () => {
    expect(() => sourceColumns({ kind: 'manual', userId: '' })).toThrow(MissingSourceError);
    expect(() => sourceColumns({ kind: 'system', system: 'RUNT', readAt: '' })).toThrow(
      MissingSourceError,
    );
    expect(() => sourceColumns({ kind: 'document', documentId: 'doc-1', quote: 'sí' })).toThrow(
      MissingSourceError,
    );
    expect(() =>
      sourceColumns({ kind: 'document', documentId: '', quote: 'una frase larga' }),
    ).toThrow(MissingSourceError);
  });
});
