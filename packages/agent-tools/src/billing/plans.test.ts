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
  nextPeriodStart,
  usagePeriod,
} from './plans';

/**
 * The limit is a promise about behaviour, so these are tests about behaviour and
 * not about arithmetic. Each one is a sentence the product says out loud
 * somewhere: "a los 80% te avisamos", "pasarte no te corta", "cuando se acaba el
 * margen no empezamos nada nuevo", "un documento nunca se rechaza".
 */

const TEAM: Plan = {
  code: 'team',
  name: 'Equipo',
  tagline: '',
  priceCop: 290_000,
  limits: { answers: 2000, documents: 1000 },
  seatsLimit: 15,
  graceRatio: 0.1,
  graceMinimum: 10,
  selfServe: true,
  sortOrder: 2,
};

/** The plan migration 0085 § 7 puts the already-existing workspace on. */
const CUSTOM: Plan = {
  ...TEAM,
  code: 'custom',
  limits: { answers: null, documents: null },
  seatsLimit: null,
  selfServe: false,
};

describe('the courtesy margin', () => {
  it('is a tenth of the plan on a plan big enough for that to mean something', () => {
    expect(graceFor(TEAM, 'answers')).toBe(200);
  });

  it('never falls below the floor, which is what makes it work on the free plan', () => {
    // 10% of 50 documents is 5 — not enough room to see a banner and act on it.
    expect(graceFor(FALLBACK_PLAN, 'documents')).toBe(10);
  });

  it('is zero when there is no limit to be past', () => {
    expect(graceFor(CUSTOM, 'answers')).toBe(0);
  });
});

describe('the four states', () => {
  it('is ok well below the line', () => {
    expect(entitlementFor(TEAM, 'answers', 1).state).toBe('ok');
    expect(entitlementFor(TEAM, 'answers', 1599).state).toBe('ok');
  });

  it('warns from 80% of the limit, while there is still time to act', () => {
    expect(TEAM.limits.answers! * WARNING_AT).toBe(1600);
    expect(entitlementFor(TEAM, 'answers', 1600).state).toBe('warning');
    expect(entitlementFor(TEAM, 'answers', 1999).state).toBe('warning');
  });

  it('does NOT block at the limit — it opens the margin', () => {
    // This is the half that protects somebody mid-conversation: crossing the
    // line does not end anything.
    const at = entitlementFor(TEAM, 'answers', 2000);
    expect(at.state).toBe('grace');
    expect(isRefused(at)).toBe(false);

    const inside = entitlementFor(TEAM, 'answers', 2200);
    expect(inside.state).toBe('grace');
    expect(isRefused(inside)).toBe(false);
  });

  it('blocks only once the margin is also spent', () => {
    const past = entitlementFor(TEAM, 'answers', 2201);
    expect(past.state).toBe('blocked');
    expect(isRefused(past)).toBe(true);
    expect(past.allowance).toBe(2200);
  });

  it('reports remaining against the limit and a ratio that can exceed 1', () => {
    const e = entitlementFor(TEAM, 'answers', 2400);
    expect(e.remaining).toBe(0);
    expect(e.ratio).toBeCloseTo(1.2);
  });
});

describe('what is blocked and what is degraded', () => {
  it('refuses to start a new answer once answers run out', () => {
    expect(LIMIT_POLICY.answers).toBe('block');
    expect(isRefused(entitlementFor(TEAM, 'answers', 99_999))).toBe(true);
  });

  it('never refuses a document, however far past the allowance', () => {
    // The customer already handed it to us. Losing a contract to a billing rule
    // is not a trade any plan is worth.
    expect(LIMIT_POLICY.documents).toBe('degrade');
    const way = entitlementFor(TEAM, 'documents', 99_999);
    expect(way.state).toBe('blocked');
    expect(isRefused(way)).toBe(false);
    expect(isDegraded(way)).toBe(true);
  });

  it('degrades a document from the moment the limit is crossed, not later', () => {
    expect(isDegraded(entitlementFor(TEAM, 'documents', 1000))).toBe(true);
    expect(isDegraded(entitlementFor(TEAM, 'documents', 999))).toBe(false);
  });
});

describe('the workspace that already existed', () => {
  it('is never warned, never in grace, never blocked, on any meter', () => {
    for (const used of [0, 1, 10_000, 5_000_000]) {
      for (const meter of ['answers', 'documents'] as const) {
        const e = entitlementFor(CUSTOM, meter, used);
        expect(e.state).toBe('ok');
        expect(e.limit).toBeNull();
        expect(e.allowance).toBeNull();
        expect(e.ratio).toBeNull();
        expect(isRefused(e)).toBe(false);
        expect(isDegraded(e)).toBe(false);
      }
    }
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
