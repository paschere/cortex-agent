import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PLAN,
  LIMIT_POLICY,
  type Plan,
  WARNING_AT,
  entitlementFor,
  graceFor,
  isDegraded,
  isRefused,
  limitFor,
  monthlyChargeCop,
  nextPeriodStart,
  seatBasisFor,
  usagePeriod,
} from './plans';

/**
 * The limit is a promise about behaviour, so these are tests about behaviour and
 * not about arithmetic. Each one is a sentence the product says out loud
 * somewhere: "a los 80% te avisamos", "pasarte no te corta", "cuando se acaba el
 * margen no empezamos nada nuevo", "un documento nunca se rechaza", "si alguien
 * sale a mitad de mes no se les cae el cupo".
 *
 * The plan figures below are the ones on apps/web/app/_landing/Landing.tsx and in
 * migration 0086 § 1. They are written out rather than imported so that a change
 * to either has to be made here too, deliberately, by somebody who read them.
 */

/** Equipo: $30.000 per person, from 5 people, 150 answers and 70 documents each. */
const TEAM: Plan = {
  code: 'team',
  name: 'Equipo',
  tagline: '',
  priceCopPerSeat: 30_000,
  perSeat: { answers: 150, documents: 70 },
  billableSeatsMinimum: 5,
  seatsMaximum: null,
  graceRatio: 0.1,
  graceMinimum: 10,
  selfServe: true,
  sortOrder: 2,
};

/** Empresa: $24.000 per person, from 25 people, 250 answers and 150 documents each. */
const BUSINESS: Plan = {
  ...TEAM,
  code: 'business',
  name: 'Empresa',
  priceCopPerSeat: 24_000,
  perSeat: { answers: 250, documents: 150 },
  billableSeatsMinimum: 25,
  sortOrder: 3,
};

/** The plan the already-existing workspace is on: 0085 § 7, renamed by 0086 § 3. */
const ENTERPRISE: Plan = {
  ...TEAM,
  code: 'enterprise',
  name: 'Enterprise',
  priceCopPerSeat: 0,
  perSeat: { answers: null, documents: null },
  billableSeatsMinimum: 1,
  seatsMaximum: null,
  selfServe: false,
};

/** A workspace of `members` people with no history and nothing contracted. */
const team = (members: number, extra: { peak?: number; contracted?: number | null } = {}) =>
  seatBasisFor(TEAM, { members, ...extra });

describe('the ceiling is a rate times a headcount', () => {
  it('multiplies what one person brings by the people who are billed for', () => {
    expect(limitFor(TEAM, 'answers', team(15))).toBe(2250);
    expect(limitFor(TEAM, 'documents', team(15))).toBe(1050);
  });

  it('moves with the headcount, which is the whole point of a per-person price', () => {
    expect(limitFor(TEAM, 'answers', team(5))).toBe(750);
    expect(limitFor(TEAM, 'answers', team(10))).toBe(1500);
    expect(limitFor(TEAM, 'answers', team(40))).toBe(6000);
  });

  it('is the same arithmetic the pricing page shows for the bill', () => {
    // "15 personas × $30.000 = $450.000 al mes" and "30 × $24.000 = $720.000".
    expect(monthlyChargeCop(TEAM, team(15))).toBe(450_000);
    expect(monthlyChargeCop(BUSINESS, seatBasisFor(BUSINESS, { members: 30 }))).toBe(720_000);
  });

  it('stays unlimited for the grandfathered workspace, at any headcount', () => {
    for (const members of [1, 15, 4000]) {
      const seats = seatBasisFor(ENTERPRISE, { members });
      expect(limitFor(ENTERPRISE, 'answers', seats)).toBeNull();
      expect(limitFor(ENTERPRISE, 'documents', seats)).toBeNull();
    }
  });
});

describe('the billable minimum is a floor on the bill, not a gate on the plan', () => {
  it('does not stop a team of eight from being on a plan that starts at five', () => {
    const eight = team(8);
    expect(eight.billable).toBe(8);
    expect(limitFor(TEAM, 'answers', eight)).toBe(1200);
    expect(monthlyChargeCop(TEAM, eight)).toBe(240_000);
    // Nothing anywhere refuses them: the only hard ceiling is seatsMaximum, and
    // Equipo does not have one.
    expect(TEAM.seatsMaximum).toBeNull();
  });

  it('charges a team of three for five — and gives them five seats of quota', () => {
    // You get exactly what you are charged for. A floor that took the money and
    // withheld the quota would be a worse deal than the one on the page.
    const three = team(3);
    expect(three.billable).toBe(5);
    expect(monthlyChargeCop(TEAM, three)).toBe(150_000);
    expect(limitFor(TEAM, 'answers', three)).toBe(750);
  });

  it('never lowers the basis below the people who are actually there', () => {
    // Empresa starts at 25; a 40-person workspace is billed for 40, not 25.
    const forty = seatBasisFor(BUSINESS, { members: 40 });
    expect(forty.billable).toBe(40);
    expect(monthlyChargeCop(BUSINESS, forty)).toBe(960_000);
  });
});

describe('the ceiling may rise mid-month and may never fall', () => {
  it('rises the moment somebody joins', () => {
    expect(limitFor(TEAM, 'answers', team(10, { peak: 10 }))).toBe(1500);
    expect(limitFor(TEAM, 'answers', team(11, { peak: 11 }))).toBe(1650);
  });

  it('does NOT fall when somebody leaves, so consumption cannot go over retroactively', () => {
    // Ten people all month; the workspace has used 1.400 of its 1.500.
    const before = team(10, { peak: 10 });
    expect(entitlementFor(TEAM, 'answers', 1400, before).state).toBe('warning');

    // Two leave on the 14th. Today's headcount is eight, but the month's mark is
    // still ten — otherwise the ceiling would drop to 1.200 and a workspace that
    // did nothing at all would be blocked by a personnel change.
    const after = team(8, { peak: 10 });
    expect(after.billable).toBe(10);
    const e = entitlementFor(TEAM, 'answers', 1400, after);
    expect(e.limit).toBe(1500);
    expect(e.state).toBe('warning');
    expect(isRefused(e)).toBe(false);
  });

  it('comes back down next period, when the mark resets with the invoice', () => {
    // A new period starts with no high-water mark of its own.
    const nextMonth = team(8, { peak: 0 });
    expect(nextMonth.billable).toBe(8);
    expect(limitFor(TEAM, 'answers', nextMonth)).toBe(1200);
    expect(monthlyChargeCop(TEAM, nextMonth)).toBe(240_000);
  });

  it('counts contracted seats as one more floor, never as a ceiling', () => {
    expect(team(3, { contracted: 12 }).billable).toBe(12);
    // Outgrowing the contract is not a refusal: they have twenty people and are
    // entitled to — and owe for — twenty.
    expect(team(20, { contracted: 12 }).billable).toBe(20);
  });
});

describe('the courtesy margin', () => {
  it('is a tenth of the EFFECTIVE ceiling, not of the per-person rate', () => {
    // 150 x 15 = 2.250, so the margin is 225 — a tenth of what this workspace
    // actually has, which is the number the banner has to be proportionate to.
    expect(graceFor(TEAM, 'answers', team(15))).toBe(225);
  });

  it('never falls below the floor, which is what makes it work on one seat', () => {
    // A tenth of one free seat's 15 documents is 2 — not enough room to see a
    // banner and act on it.
    const alone = seatBasisFor(FALLBACK_PLAN, { members: 1 });
    expect(graceFor(FALLBACK_PLAN, 'documents', alone)).toBe(10);
  });

  it('is zero when there is no limit to be past', () => {
    expect(graceFor(ENTERPRISE, 'answers', seatBasisFor(ENTERPRISE, { members: 9 }))).toBe(0);
  });
});

describe('the four states', () => {
  const FIFTEEN = team(15); // 150 x 15 = 2.250 answers, margin 225

  it('is ok well below the line', () => {
    expect(entitlementFor(TEAM, 'answers', 1, FIFTEEN).state).toBe('ok');
    expect(entitlementFor(TEAM, 'answers', 1799, FIFTEEN).state).toBe('ok');
  });

  it('warns from 80% of the limit, while there is still time to act', () => {
    expect(2250 * WARNING_AT).toBe(1800);
    expect(entitlementFor(TEAM, 'answers', 1800, FIFTEEN).state).toBe('warning');
    expect(entitlementFor(TEAM, 'answers', 2249, FIFTEEN).state).toBe('warning');
  });

  it('does NOT block at the limit — it opens the margin', () => {
    // This is the half that protects somebody mid-conversation: crossing the
    // line does not end anything.
    const at = entitlementFor(TEAM, 'answers', 2250, FIFTEEN);
    expect(at.state).toBe('grace');
    expect(isRefused(at)).toBe(false);

    const inside = entitlementFor(TEAM, 'answers', 2475, FIFTEEN);
    expect(inside.state).toBe('grace');
    expect(isRefused(inside)).toBe(false);
  });

  it('blocks only once the margin is also spent', () => {
    const past = entitlementFor(TEAM, 'answers', 2476, FIFTEEN);
    expect(past.state).toBe('blocked');
    expect(isRefused(past)).toBe(true);
    expect(past.allowance).toBe(2475);
  });

  it('reports remaining against the limit and a ratio that can exceed 1', () => {
    const e = entitlementFor(TEAM, 'answers', 2700, FIFTEEN);
    expect(e.remaining).toBe(0);
    expect(e.ratio).toBeCloseTo(1.2);
  });

  it('carries the multiplication with it, so a screen can show its own working', () => {
    const e = entitlementFor(TEAM, 'answers', 100, FIFTEEN);
    expect(e.perSeat).toBe(150);
    expect(e.seats).toBe(15);
    expect(e.limit).toBe(150 * 15);
  });
});

describe('what is blocked and what is degraded', () => {
  const FIFTEEN = team(15);

  it('refuses to start a new answer once answers run out', () => {
    expect(LIMIT_POLICY.answers).toBe('block');
    expect(isRefused(entitlementFor(TEAM, 'answers', 99_999, FIFTEEN))).toBe(true);
  });

  it('never refuses a document, however far past the allowance', () => {
    // The customer already handed it to us. Losing a contract to a billing rule
    // is not a trade any plan is worth.
    expect(LIMIT_POLICY.documents).toBe('degrade');
    const way = entitlementFor(TEAM, 'documents', 99_999, FIFTEEN);
    expect(way.state).toBe('blocked');
    expect(isRefused(way)).toBe(false);
    expect(isDegraded(way)).toBe(true);
  });

  it('degrades a document from the moment the limit is crossed, not later', () => {
    // 70 x 15 = 1.050.
    expect(isDegraded(entitlementFor(TEAM, 'documents', 1050, FIFTEEN))).toBe(true);
    expect(isDegraded(entitlementFor(TEAM, 'documents', 1049, FIFTEEN))).toBe(false);
  });
});

describe('the workspace that already existed', () => {
  it('is never warned, never in grace, never blocked, on any meter, at any size', () => {
    for (const members of [1, 12, 500]) {
      const seats = seatBasisFor(ENTERPRISE, { members });
      for (const used of [0, 1, 10_000, 5_000_000]) {
        for (const meter of ['answers', 'documents'] as const) {
          const e = entitlementFor(ENTERPRISE, meter, used, seats);
          expect(e.state).toBe('ok');
          expect(e.limit).toBeNull();
          expect(e.perSeat).toBeNull();
          expect(e.allowance).toBeNull();
          expect(e.ratio).toBeNull();
          expect(isRefused(e)).toBe(false);
          expect(isDegraded(e)).toBe(false);
        }
      }
    }
  });

  it('has no ceiling on people either, so nobody can be refused an invitation', () => {
    expect(ENTERPRISE.seatsMaximum).toBeNull();
  });
});

describe('the billing period', () => {
  it('is YYYY-MM, which is what public.usage_period_of() writes', () => {
    expect(usagePeriod(new Date('2026-08-07T15:00:00Z'))).toBe('2026-08');
    expect(usagePeriod(new Date('2026-01-15T15:00:00Z'))).toBe('2026-01');
  });

  it('is measured in Bogotá, so late on the last night belongs to that month', () => {
    // 2026-09-01T02:00Z is 2026-08-31 21:00 in Bogotá. The person was still
    // living in August, and so is their consumption.
    expect(usagePeriod(new Date('2026-09-01T02:00:00Z'))).toBe('2026-08');
    // And the reverse: 20:00Z on the last day is already the 31st locally.
    expect(usagePeriod(new Date('2026-08-31T20:00:00Z'))).toBe('2026-08');
  });

  it('rolls into the next year', () => {
    expect(usagePeriod(new Date('2027-01-01T06:00:00Z'))).toBe('2027-01');
    expect(nextPeriodStart('2026-12').toISOString()).toBe('2027-01-01T05:00:00.000Z');
    expect(nextPeriodStart('2026-08').toISOString()).toBe('2026-09-01T05:00:00.000Z');
  });
});
