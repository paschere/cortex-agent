import { beforeEach, describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { isDegraded, isRefused } from './plans';
import {
  checkMeter,
  listUsageEvents,
  readSeats,
  readWorkspacePlan,
  readWorkspaceUsage,
  resetPlansCache,
} from './usage';

/**
 * TWO COMPANIES, ONE METER.
 *
 * `tenancy/__tests__/isolation.test.ts` proves Acme cannot read Globex's
 * documents. This proves the thing that comes after you start charging for them:
 * Acme cannot be charged for Globex's consumption, cannot see it, and cannot
 * have it counted into the decision to refuse Acme service.
 *
 * Since migration 0086 there is a second way to get that wrong and it is worse,
 * because it is silent in both directions. A workspace's ceiling is now its
 * per-person quota times ITS OWN headcount, so a lost filter on `users` or on
 * `organization_seat_periods` would not leak a visible row — it would compute
 * Acme's ceiling, and Acme's invoice, from Globex's payroll.
 *
 * The fixture is adversarial about all of it. Both workspaces are in the same
 * period, both have a conversation with the same title, GLOBEX HAS THE LARGER
 * NUMBERS — so a query that has lost its workspace filter does not come back
 * empty (which a test would catch by accident), it comes back with a plausible,
 * wrong, larger total. Larger consumption would block Acme when it should not;
 * larger headcount would let Acme through when it should be blocked. Both
 * directions are tested.
 *
 * The subject under test is the real `createOrgScopedClient` over a real (if
 * small) PostgREST, and the code exercised is the real reader.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const PERIOD = '2026-08';
const NOW = new Date('2026-08-07T15:00:00Z');

const MSG_ACME_1 = '11110000-0000-4000-8000-000000000001';
const MSG_ACME_2 = '11110000-0000-4000-8000-000000000002';
const MSG_GLOBEX = '22220000-0000-4000-8000-000000000001';
const DOC_ACME = '33330000-0000-4000-8000-000000000001';
const CONV_ACME = '44440000-0000-4000-8000-000000000001';
const CONV_GLOBEX = '44440000-0000-4000-8000-000000000002';

/**
 * The catalogue as migration 0086 § 1 leaves it. Per-person rates, a floor on
 * the bill and — only on the free plan — a ceiling on people.
 */
const PLAN_ROWS = [
  {
    code: 'free',
    name: 'Gratis',
    tagline: '',
    price_cop_per_seat: 0,
    answers_per_seat: 50,
    documents_per_seat: 15,
    billable_seats_minimum: 1,
    seats_maximum: 3,
    grace_ratio: '0.100',
    grace_minimum: 10,
    self_serve: true,
    retainer_cop: null,
    sort_order: 1,
  },
  {
    code: 'team',
    name: 'Equipo',
    tagline: '',
    price_cop_per_seat: 30000,
    answers_per_seat: 150,
    documents_per_seat: 70,
    billable_seats_minimum: 5,
    seats_maximum: null,
    grace_ratio: '0.100',
    grace_minimum: 10,
    self_serve: true,
    retainer_cop: null,
    sort_order: 2,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    tagline: '',
    price_cop_per_seat: 0,
    answers_per_seat: null,
    documents_per_seat: null,
    billable_seats_minimum: 1,
    seats_maximum: null,
    grace_ratio: '0.100',
    grace_minimum: 10,
    self_serve: false,
    retainer_cop: null,
    sort_order: 4,
  },
];

/**
 * Acme: free plan, two people, so a ceiling of 100 answers and 30 documents.
 * Globex: the grandfathered workspace — three people, no limits, and a seat
 * high-water mark of fifty, which is the number that would quietly raise Acme's
 * ceiling to 2.500 if the seat read ever lost its filter.
 */
function fixture(acmeAnswers = 3): Tables {
  return {
    plans: PLAN_ROWS.map((p) => ({ ...p })),

    organization_subscriptions: [
      { organization_id: ACME, plan_code: 'free', status: 'active', started_at: '2026-08-01T00:00:00Z', billing_customer_ref: null, contracted_seats: null },
      // The grandfathered workspace: the plan migration 0085 § 7 wrote for
      // every organization that already existed, repointed at `enterprise` by
      // 0086 § 3 with its limits still null.
      { organization_id: GLOBEX, plan_code: 'enterprise', status: 'active', started_at: '2026-01-01T00:00:00Z', billing_customer_ref: null, contracted_seats: null },
    ],

    // Globex's numbers are deliberately far larger than Acme's, and in the same
    // period. Acme's two free seats allow 100 answers; Globex's 900 would blow
    // straight through them.
    usage_counters: [
      { organization_id: ACME, period: PERIOD, meter: 'answers', used: acmeAnswers, first_at: '2026-08-01T10:00:00Z', last_at: '2026-08-07T10:00:00Z' },
      { organization_id: ACME, period: PERIOD, meter: 'documents', used: 1, first_at: '2026-08-02T10:00:00Z', last_at: '2026-08-02T10:00:00Z' },
      { organization_id: GLOBEX, period: PERIOD, meter: 'answers', used: 900, first_at: '2026-08-01T10:00:00Z', last_at: '2026-08-07T10:00:00Z' },
      { organization_id: GLOBEX, period: PERIOD, meter: 'documents', used: 4000, first_at: '2026-08-01T10:00:00Z', last_at: '2026-08-07T10:00:00Z' },
    ],

    // The high-water marks migration 0086 § 5 keeps by trigger.
    organization_seat_periods: [
      { organization_id: ACME, period: PERIOD, peak_seats: 2, first_at: '2026-08-01T00:00:00Z', last_at: '2026-08-01T00:00:00Z' },
      { organization_id: GLOBEX, period: PERIOD, peak_seats: 50, first_at: '2026-08-01T00:00:00Z', last_at: '2026-08-01T00:00:00Z' },
    ],

    usage_events: [
      { id: 'e1', organization_id: ACME, meter: 'answers', quantity: 1, subject_table: 'messages', subject_id: MSG_ACME_1, source: 'web', occurred_at: '2026-08-07T10:00:00Z', period: PERIOD },
      { id: 'e2', organization_id: ACME, meter: 'answers', quantity: 1, subject_table: 'messages', subject_id: MSG_ACME_2, source: 'web', occurred_at: '2026-08-06T10:00:00Z', period: PERIOD },
      { id: 'e3', organization_id: ACME, meter: 'documents', quantity: 1, subject_table: 'kb_documents', subject_id: DOC_ACME, source: 'upload', occurred_at: '2026-08-02T10:00:00Z', period: PERIOD },
      { id: 'e4', organization_id: GLOBEX, meter: 'answers', quantity: 1, subject_table: 'messages', subject_id: MSG_GLOBEX, source: 'mcp', occurred_at: '2026-08-07T11:00:00Z', period: PERIOD },
    ],

    // Both companies have a conversation called the same thing, so a lost
    // filter on the label lookup produces a believable wrong name.
    conversations: [
      { id: CONV_ACME, organization_id: ACME, title: 'Tarifas de septiembre' },
      { id: CONV_GLOBEX, organization_id: GLOBEX, title: 'Tarifas de septiembre' },
    ],
    messages: [
      { id: MSG_ACME_1, organization_id: ACME, conversation_id: CONV_ACME, role: 'assistant' },
      { id: MSG_ACME_2, organization_id: ACME, conversation_id: CONV_ACME, role: 'assistant' },
      { id: MSG_GLOBEX, organization_id: GLOBEX, conversation_id: CONV_GLOBEX, role: 'assistant' },
    ],
    kb_documents: [
      { id: DOC_ACME, organization_id: ACME, title: 'Contrato Acme 2026' },
      { id: '33330000-0000-4000-8000-000000000009', organization_id: GLOBEX, title: 'Contrato Globex 2026' },
    ],

    users: [
      { id: 'u1', organization_id: ACME, email: 'ana@acme.com' },
      { id: 'u2', organization_id: ACME, email: 'ben@acme.com' },
      { id: 'u3', organization_id: GLOBEX, email: 'carla@globex.com' },
      { id: 'u4', organization_id: GLOBEX, email: 'dan@globex.com' },
      { id: 'u5', organization_id: GLOBEX, email: 'eva@globex.com' },
    ],
    ba_invitation: [
      { id: 'i1', organizationId: ACME, email: 'nuevo@acme.com', status: 'pending' },
      { id: 'i2', organizationId: ACME, email: 'viejo@acme.com', status: 'accepted' },
      { id: 'i3', organizationId: GLOBEX, email: 'otro@globex.com', status: 'pending' },
    ],
  };
}

function scoped(tables: Tables, organizationId: string) {
  return createOrgScopedClient(createFakeSupabase(tables).client, organizationId);
}

/** Put `n` people in Acme's directory, and move its high-water mark to match. */
function acmeHeadcount(tables: Tables, members: number, peak = members): Tables {
  const others = (tables.users ?? []).filter((u) => u.organization_id !== ACME);
  tables.users = [
    ...Array.from({ length: members }, (_, i) => ({
      id: `acme-${i + 1}`,
      organization_id: ACME,
      email: `p${i + 1}@acme.com`,
    })),
    ...others,
  ];
  tables.organization_seat_periods = (tables.organization_seat_periods ?? []).map((r) =>
    r.organization_id === ACME ? { ...r, peak_seats: peak } : r,
  );
  return tables;
}

beforeEach(() => {
  // The catalogue is cached in process across clients on purpose (it is product
  // content). Between tests that is just staleness.
  resetPlansCache();
});

describe("one company never sees another's consumption", () => {
  it('counts only its own, even when the neighbour is much louder', async () => {
    const tables = fixture();
    const acme = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);

    expect(acme.plan.code).toBe('free');
    expect(acme.meters.answers.used).toBe(3);
    expect(acme.meters.documents.used).toBe(1);
    // Globex's 900 answers and 4000 documents are in the same table, in the
    // same period, and contributed nothing.
    expect(acme.meters.answers.state).toBe('ok');
  });

  it("reads its own plan, not the neighbour's", async () => {
    const tables = fixture();
    const globex = await readWorkspaceUsage(scoped(tables, GLOBEX), GLOBEX, NOW);
    expect(globex.plan.code).toBe('enterprise');
    expect(globex.meters.answers.limit).toBeNull();
    expect(globex.meters.answers.used).toBe(900);
    expect(globex.meters.answers.state).toBe('ok');
  });

  it("computes its ceiling from its own headcount, never the neighbour's", async () => {
    const tables = fixture();
    const acme = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);
    // Two people on the free plan: 50 x 2. Globex has three people and a mark of
    // fifty sitting in the same two tables; either would have produced a
    // plausible, wrong, larger number.
    expect(acme.seats.members).toBe(2);
    expect(acme.seats.peak).toBe(2);
    expect(acme.seats.billable).toBe(2);
    expect(acme.meters.answers.limit).toBe(100);
    expect(acme.meters.documents.limit).toBe(30);
  });

  it('would let a blocked workspace through if it borrowed the neighbour\'s seats — it does not', async () => {
    // 111 answers is past 100 + a margin of 10. With Globex's fifty seats it
    // would be 111 of 2.500 and sail through, which is exactly the failure this
    // fixture is shaped to catch.
    const e = await checkMeter(scoped(fixture(111), ACME), 'answers', NOW);
    expect(e.seats).toBe(2);
    expect(e.state).toBe('blocked');
    expect(isRefused(e)).toBe(true);
  });

  it('lists only its own ledger rows, labelled from its own data', async () => {
    const tables = fixture();
    const rows = await listUsageEvents(scoped(tables, ACME), { meter: 'answers', period: PERIOD });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.subjectId)).toEqual([MSG_ACME_1, MSG_ACME_2]);
    expect(rows.every((r) => r.label === 'Tarifas de septiembre')).toBe(true);
    // Newest first — "what did we just spend that on".
    expect(rows[0]?.occurredAt).toBe('2026-08-07T10:00:00Z');
  });

  it("gives a workspace with no consumption an empty list and zero, not the neighbour's", async () => {
    const tables = fixture();
    tables.usage_counters = (tables.usage_counters ?? []).filter((r) => r.organization_id !== ACME);
    tables.usage_events = (tables.usage_events ?? []).filter((r) => r.organization_id !== ACME);

    const acme = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);
    expect(acme.meters.answers.used).toBe(0);
    expect(acme.meters.documents.used).toBe(0);
    expect(await listUsageEvents(scoped(tables, ACME), { meter: 'answers', period: PERIOD })).toEqual([]);
  });
});

describe('the count is exact', () => {
  it('is the length of the list the customer can read', async () => {
    const tables = fixture(2);
    const db = scoped(tables, ACME);
    const usage = await readWorkspaceUsage(db, ACME, NOW);
    const rows = await listUsageEvents(db, { meter: 'answers', period: PERIOD });
    const fromLedger = rows.reduce((n, r) => n + r.quantity, 0);

    expect(usage.meters.answers.used).toBe(fromLedger);
  });

  it('ignores other periods entirely', async () => {
    const tables = fixture();
    (tables.usage_counters ?? []).push({
      organization_id: ACME,
      period: '2026-07',
      meter: 'answers',
      used: 98,
      first_at: '2026-07-01T10:00:00Z',
      last_at: '2026-07-31T10:00:00Z',
    });
    // Last month's headcount does not raise this month's ceiling either.
    (tables.organization_seat_periods ?? []).push({
      organization_id: ACME,
      period: '2026-07',
      peak_seats: 40,
      first_at: '2026-07-01T00:00:00Z',
      last_at: '2026-07-31T00:00:00Z',
    });
    const acme = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);
    expect(acme.meters.answers.used).toBe(3);
    expect(acme.seats.peak).toBe(2);
    expect(acme.meters.answers.limit).toBe(100);
  });

  it('every ledger row names a subject the customer can open', async () => {
    const rows = await listUsageEvents(scoped(fixture(), ACME), { meter: 'documents', period: PERIOD });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectTable).toBe('kb_documents');
    expect(rows[0]?.subjectId).toBe(DOC_ACME);
    expect(rows[0]?.label).toBe('Contrato Acme 2026');
  });
});

describe('the ceiling is per person, and it moves with the people', () => {
  it('grows the moment somebody joins', async () => {
    const two = await checkMeter(scoped(fixture(), ACME), 'answers', NOW);
    expect(two.limit).toBe(100);

    const three = await checkMeter(scoped(acmeHeadcount(fixture(), 3), ACME), 'answers', NOW);
    expect(three.limit).toBe(150);
  });

  it('DOES NOT SHRINK WHEN SOMEBODY LEAVES, which is the whole reason the mark exists', async () => {
    // Ten people all month on the team plan; 1.400 answers used against 1.500.
    const tables = acmeHeadcount(fixture(1400), 10, 10);
    (tables.organization_subscriptions ?? []).forEach((r) => {
      if (r.organization_id === ACME) r.plan_code = 'team';
    });

    const before = await checkMeter(scoped(tables, ACME), 'answers', NOW);
    expect(before.limit).toBe(1500);
    expect(isRefused(before)).toBe(false);

    // Two people leave on the 14th. The directory is down to eight; the mark
    // recorded before the deletes is still ten. Without it the ceiling would be
    // 1.200 and this workspace — which did nothing at all — would be blocked
    // instantly, retroactively, by a personnel change.
    tables.users = (tables.users ?? []).filter(
      (u) => u.organization_id !== ACME || !['acme-9', 'acme-10'].includes(u.id as string),
    );

    const after = await checkMeter(scoped(tables, ACME), 'answers', NOW);
    expect(after.seats).toBe(10);
    expect(after.limit).toBe(1500);
    expect(after.state).toBe('warning');
    expect(isRefused(after)).toBe(false);
  });
});

describe('the billable minimum is a floor on the bill, not a gate on the plan', () => {
  it('lets a team of eight use Equipo, and bills them for eight', async () => {
    const tables = acmeHeadcount(fixture(), 8);
    (tables.organization_subscriptions ?? []).forEach((r) => {
      if (r.organization_id === ACME) r.plan_code = 'team';
    });
    const usage = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);

    expect(usage.plan.code).toBe('team');
    expect(usage.seats.billable).toBe(8);
    expect(usage.seats.chargeCop).toBe(240_000);
    expect(usage.meters.answers.limit).toBe(1200);
    // Nothing refuses them: Equipo has no ceiling on people at all.
    expect(usage.seats.maximum).toBeNull();
    expect(usage.seats.full).toBe(false);
  });

  it('charges a team of three for five and gives them five seats of quota', async () => {
    const tables = acmeHeadcount(fixture(), 3);
    (tables.organization_subscriptions ?? []).forEach((r) => {
      if (r.organization_id === ACME) r.plan_code = 'team';
    });
    const usage = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);

    expect(usage.seats.members).toBe(3);
    expect(usage.seats.billable).toBe(5);
    expect(usage.seats.chargeCop).toBe(150_000);
    expect(usage.meters.answers.limit).toBe(750);
  });

  it('treats contracted seats as another floor, and never as a ceiling', async () => {
    const tables = acmeHeadcount(fixture(), 8);
    (tables.organization_subscriptions ?? []).forEach((r) => {
      if (r.organization_id === ACME) {
        r.plan_code = 'team';
        r.contracted_seats = 12;
      }
    });
    const usage = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);
    expect(usage.contractedSeats).toBe(12);
    expect(usage.seats.billable).toBe(12);
    expect(usage.meters.answers.limit).toBe(1800);
    expect(usage.seats.full).toBe(false);
  });
});

describe('reaching the limit does what the product says it does', () => {
  it('lets somebody cross the line without being cut off', async () => {
    // Two free seats: 50 x 2 = 100.
    const e = await checkMeter(scoped(fixture(100), ACME), 'answers', NOW);
    expect(e.state).toBe('grace');
    expect(isRefused(e)).toBe(false);
  });

  it('still answers inside the margin', async () => {
    const e = await checkMeter(scoped(fixture(110), ACME), 'answers', NOW);
    expect(e.state).toBe('grace');
    expect(isRefused(e)).toBe(false);
  });

  it('refuses to START a new answer once the margin is spent', async () => {
    const e = await checkMeter(scoped(fixture(111), ACME), 'answers', NOW);
    expect(e.state).toBe('blocked');
    expect(isRefused(e)).toBe(true);
    expect(e.allowance).toBe(110);
  });

  it('never refuses a document — it degrades it', async () => {
    const tables = fixture();
    tables.usage_counters = (tables.usage_counters ?? []).map((r) =>
      r.organization_id === ACME && r.meter === 'documents' ? { ...r, used: 5000 } : r,
    );
    const e = await checkMeter(scoped(tables, ACME), 'documents', NOW);
    expect(isRefused(e)).toBe(false);
    expect(isDegraded(e)).toBe(true);
  });

  it('never blocks the grandfathered workspace, whatever it consumes', async () => {
    const tables = fixture();
    tables.usage_counters = (tables.usage_counters ?? []).map((r) =>
      r.organization_id === GLOBEX ? { ...r, used: 9_000_000 } : r,
    );
    const e = await checkMeter(scoped(tables, GLOBEX), 'answers', NOW);
    expect(e.state).toBe('ok');
    expect(isRefused(e)).toBe(false);
  });

  it('fails open: an unreadable meter must never become an unusable product', async () => {
    // A metering outage must not become a product outage. Nothing is lost when
    // this happens: the ledger is written by a database trigger and does not go
    // through this code path at all, so every answer given during the outage was
    // still recorded — it was only briefly ungated.
    const broken = createOrgScopedClient(
      {
        from: () => {
          throw new Error('database on fire');
        },
      } as never,
      ACME,
    );
    const e = await checkMeter(broken, 'answers', NOW);
    expect(isRefused(e)).toBe(false);
    expect(e.state).toBe('ok');
  });
});

describe('the workspace that already existed loses nothing', () => {
  it('keeps its null limits and its unlimited seats through the reader', async () => {
    const usage = await readWorkspaceUsage(scoped(fixture(), GLOBEX), GLOBEX, NOW);

    expect(usage.plan.code).toBe('enterprise');
    expect(usage.plan.perSeat.answers).toBeNull();
    expect(usage.plan.perSeat.documents).toBeNull();
    expect(usage.meters.answers.limit).toBeNull();
    expect(usage.meters.documents.limit).toBeNull();
    expect(usage.meters.answers.state).toBe('ok');
    expect(usage.meters.documents.state).toBe('ok');
    expect(usage.seats.maximum).toBeNull();
    expect(usage.seats.full).toBe(false);
    expect(usage.status).toBe('active');
    // No quota times any headcount is still no quota, and no price times any
    // headcount is still nothing owed.
    expect(usage.seats.chargeCop).toBe(0);
  });

  it('is NOT downgraded to the free plan when the catalogue itself cannot be read', async () => {
    // The deploy window this protects: 0086 lands, a build that still asks for
    // the old columns is briefly live, and the price list comes back empty. The
    // old behaviour was to treat that as "you are on the free plan" — which
    // would have put the one workspace in production on 50 answers a person and
    // blocked it within the day, for a reason nobody would have looked for.
    const tables = fixture();
    tables.plans = [];

    const { plan } = await readWorkspacePlan(scoped(tables, GLOBEX));
    expect(plan.code).not.toBe('free');
    expect(plan.perSeat.answers).toBeNull();

    const e = await checkMeter(scoped(tables, GLOBEX), 'answers', NOW);
    expect(e.limit).toBeNull();
    expect(e.state).toBe('ok');
    expect(isRefused(e)).toBe(false);
  });
});

describe('seats', () => {
  it("counts this workspace's people and its own pending invitations", async () => {
    const tables = fixture();
    const { plan, contractedSeats } = await readWorkspacePlan(scoped(tables, ACME));
    const seats = await readSeats(scoped(tables, ACME), ACME, plan, contractedSeats, NOW);

    expect(seats.members).toBe(2);
    // The accepted invitation is not a second seat for a person already counted.
    expect(seats.pending).toBe(1);
    expect(seats.used).toBe(3);
    // Free is the one plan with a ceiling on people, and this workspace is at it.
    expect(seats.maximum).toBe(3);
    expect(seats.full).toBe(true);
  });

  it('does not let a pending invitation buy a month of quota', async () => {
    // Three places occupied, two people. The quota is for the two who are here;
    // an invitation nobody accepts must not raise the ceiling for a person who
    // never arrived.
    const tables = fixture();
    const { plan, contractedSeats } = await readWorkspacePlan(scoped(tables, ACME));
    const seats = await readSeats(scoped(tables, ACME), ACME, plan, contractedSeats, NOW);
    expect(seats.used).toBe(3);
    expect(seats.billable).toBe(2);
  });

  it("does not count the neighbour's people or invitations", async () => {
    const tables = fixture();
    const { plan, contractedSeats } = await readWorkspacePlan(scoped(tables, GLOBEX));
    const seats = await readSeats(scoped(tables, GLOBEX), GLOBEX, plan, contractedSeats, NOW);

    expect(seats.members).toBe(3);
    expect(seats.pending).toBe(1);
    expect(seats.maximum).toBeNull();
    expect(seats.full).toBe(false);
  });
});
