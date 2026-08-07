import { beforeEach, describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { isDegraded, isRefused } from './plans';
import {
  checkMeter,
  listUsageEvents,
  readSeats,
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
 * The fixture is adversarial in the same way that one is. Both workspaces are in
 * the same period, both have a conversation with the same title, and GLOBEX HAS
 * THE LARGER NUMBERS — so a query that has lost its workspace filter does not
 * come back empty (which a test would catch by accident), it comes back with a
 * plausible, wrong, larger total that would put Acme over its limit. That is the
 * failure this file exists to catch.
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

const PLAN_ROWS = [
  {
    code: 'free',
    name: 'Gratis',
    tagline: '',
    price_cop: 0,
    answers_limit: 150,
    documents_limit: 50,
    seats_limit: 3,
    grace_ratio: '0.100',
    grace_minimum: 10,
    self_serve: true,
    sort_order: 1,
  },
  {
    code: 'custom',
    name: 'A la medida',
    tagline: '',
    price_cop: 0,
    answers_limit: null,
    documents_limit: null,
    seats_limit: null,
    grace_ratio: '0.100',
    grace_minimum: 10,
    self_serve: false,
    sort_order: 4,
  },
];

function fixture(acmeAnswers = 3): Tables {
  return {
    plans: PLAN_ROWS.map((p) => ({ ...p })),

    organization_subscriptions: [
      { organization_id: ACME, plan_code: 'free', status: 'active', started_at: '2026-08-01T00:00:00Z', billing_customer_ref: null },
      // The grandfathered workspace: the plan migration 0085 § 7 wrote for
      // every organization that already existed.
      { organization_id: GLOBEX, plan_code: 'custom', status: 'active', started_at: '2026-01-01T00:00:00Z', billing_customer_ref: null },
    ],

    // Globex's numbers are deliberately far larger than Acme's, and in the same
    // period. Acme's free plan allows 150 answers; Globex's 900 would blow
    // straight through it.
    usage_counters: [
      { organization_id: ACME, period: PERIOD, meter: 'answers', used: acmeAnswers, first_at: '2026-08-01T10:00:00Z', last_at: '2026-08-07T10:00:00Z' },
      { organization_id: ACME, period: PERIOD, meter: 'documents', used: 1, first_at: '2026-08-02T10:00:00Z', last_at: '2026-08-02T10:00:00Z' },
      { organization_id: GLOBEX, period: PERIOD, meter: 'answers', used: 900, first_at: '2026-08-01T10:00:00Z', last_at: '2026-08-07T10:00:00Z' },
      { organization_id: GLOBEX, period: PERIOD, meter: 'documents', used: 4000, first_at: '2026-08-01T10:00:00Z', last_at: '2026-08-07T10:00:00Z' },
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

beforeEach(() => {
  // The catalogue is cached in process across clients on purpose (it is product
  // content). Between tests that is just staleness.
  resetPlansCache();
});

describe('one company never sees another\'s consumption', () => {
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

  it('reads its own plan, not the neighbour\'s', async () => {
    const tables = fixture();
    const globex = await readWorkspaceUsage(scoped(tables, GLOBEX), GLOBEX, NOW);
    expect(globex.plan.code).toBe('custom');
    expect(globex.meters.answers.limit).toBeNull();
    expect(globex.meters.answers.used).toBe(900);
    expect(globex.meters.answers.state).toBe('ok');
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

  it('gives a workspace with no consumption an empty list and zero, not the neighbour\'s', async () => {
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
      used: 148,
      first_at: '2026-07-01T10:00:00Z',
      last_at: '2026-07-31T10:00:00Z',
    });
    const acme = await readWorkspaceUsage(scoped(tables, ACME), ACME, NOW);
    // Last month's 148 would have put this workspace one answer from its limit.
    expect(acme.meters.answers.used).toBe(3);
  });

  it('every ledger row names a subject the customer can open', async () => {
    const rows = await listUsageEvents(scoped(fixture(), ACME), { meter: 'documents', period: PERIOD });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectTable).toBe('kb_documents');
    expect(rows[0]?.subjectId).toBe(DOC_ACME);
    expect(rows[0]?.label).toBe('Contrato Acme 2026');
  });
});

describe('reaching the limit does what the product says it does', () => {
  it('lets somebody cross the line without being cut off', async () => {
    const tables = fixture(150); // exactly at the free plan's limit
    const e = await checkMeter(scoped(tables, ACME), 'answers', NOW);
    expect(e.state).toBe('grace');
    expect(isRefused(e)).toBe(false);
  });

  it('still answers inside the margin', async () => {
    const e = await checkMeter(scoped(fixture(165), ACME), 'answers', NOW);
    expect(e.state).toBe('grace');
    expect(isRefused(e)).toBe(false);
  });

  it('refuses to START a new answer once the margin is spent', async () => {
    const e = await checkMeter(scoped(fixture(166), ACME), 'answers', NOW);
    expect(e.state).toBe('blocked');
    expect(isRefused(e)).toBe(true);
    expect(e.allowance).toBe(165);
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

describe('seats', () => {
  it('counts this workspace\'s people and its own pending invitations', async () => {
    const seats = await readSeats(scoped(fixture(), ACME), ACME, 3);
    expect(seats.members).toBe(2);
    // The accepted invitation is not a second seat for a person already counted.
    expect(seats.pending).toBe(1);
    expect(seats.used).toBe(3);
    expect(seats.full).toBe(true);
  });

  it('does not count the neighbour\'s people or invitations', async () => {
    const seats = await readSeats(scoped(fixture(), GLOBEX), GLOBEX, null);
    expect(seats.members).toBe(3);
    expect(seats.pending).toBe(1);
    expect(seats.full).toBe(false);
  });
});
