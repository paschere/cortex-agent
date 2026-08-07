import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type Entitlement,
  FALLBACK_PLAN,
  METERS,
  type MeterId,
  type Plan,
  type PlanRow,
  type SubscriptionStatus,
  entitlementFor,
  toPlan,
  usagePeriod,
} from './plans';

/**
 * Reading what a workspace has consumed, and deciding whether it may consume
 * more.
 *
 * EVERY READ HERE GOES THROUGH THE SCOPED HANDLE. `usage_events`,
 * `usage_counters`, `organization_subscriptions` and `users` are all registered
 * as `tenant()`, so the workspace filter is applied by the client and cannot be
 * forgotten at a call site — which is the point, because this is the one surface
 * where a missing filter would not show somebody another company's rows, it
 * would silently put another company's consumption on their invoice. `plans` is
 * `shared()` and is the same four rows for everybody.
 *
 * The ONE query in this file that names a workspace by hand is the pending-
 * invitation count, because `ba_invitation` is a `shared` table that carries its
 * own camel-cased `organizationId`. It is filtered explicitly and commented.
 */

const SUBSCRIPTION_COLUMNS = 'plan_code, status, started_at, billing_customer_ref';

/**
 * Run a read that must not take the caller down with it.
 *
 * It catches the rejection AND the synchronous throw, which is not pedantry:
 * `db.from(…)` on a scoped handle throws immediately for an unclassified table
 * or a broken client, and a synchronous throw next to an already-started
 * `Promise.all` sibling leaves that sibling unhandled — a warning in Node today
 * and a crashed process under `--unhandled-rejections=strict`. Every read below
 * goes through here, so no reader in this file can produce one.
 */
async function safeRead<T>(run: () => PromiseLike<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

/**
 * The plan catalogue, cached in process.
 *
 * Safe to share across tenants precisely because it is not tenant data: four
 * rows of product content that only a migration changes. Caching it takes the
 * gate on the chat route down to two parallel reads, which matters because the
 * gate runs before every single answer.
 */
const PLANS_TTL_MS = 5 * 60_000;
let plansCache: { at: number; plans: Plan[] } | null = null;

/** Test seam: forget the cached catalogue. */
export function resetPlansCache(): void {
  plansCache = null;
}

export async function listPlans(db: SupabaseClient): Promise<Plan[]> {
  if (plansCache && Date.now() - plansCache.at < PLANS_TTL_MS) return plansCache.plans;
  const { data, error } = await safeRead(
    () =>
      db
        .from('plans')
        .select(
          'code, name, tagline, price_cop, answers_limit, documents_limit, seats_limit, grace_ratio, grace_minimum, self_serve, sort_order',
        )
        .order('sort_order', { ascending: true }),
    { data: null, error: { message: 'plans unreadable' } } as { data: unknown[] | null; error: unknown },
  );
  if (error || !data || data.length === 0) return [FALLBACK_PLAN];
  const plans = (data as unknown as PlanRow[]).map(toPlan);
  plansCache = { at: Date.now(), plans };
  return plans;
}

export interface WorkspacePlan {
  plan: Plan;
  status: SubscriptionStatus;
  startedAt: string | null;
  /** True when a payment gateway has ever been attached. Always false today. */
  billingAttached: boolean;
}

/**
 * Which plan this workspace is on.
 *
 * A missing subscription row falls back to the free plan rather than to no
 * limits — see FALLBACK_PLAN for why the anomaly must not be the generous one.
 * A `plan_code` the catalogue does not know does the same, so deleting a plan
 * row can never accidentally uncap everybody who was on it.
 */
export async function readWorkspacePlan(db: SupabaseClient): Promise<WorkspacePlan> {
  const [plans, subscription] = await Promise.all([
    listPlans(db),
    safeRead(
      () => db.from('organization_subscriptions').select(SUBSCRIPTION_COLUMNS).maybeSingle(),
      { data: null } as { data: unknown },
    ),
  ]);

  const row = subscription.data as
    | { plan_code?: string; status?: string; started_at?: string; billing_customer_ref?: string }
    | null
    | undefined;

  const plan = plans.find((p) => p.code === row?.plan_code) ?? FALLBACK_PLAN;
  const status = (row?.status ?? 'active') as SubscriptionStatus;

  return {
    plan,
    status: status === 'past_due' || status === 'canceled' ? status : 'active',
    startedAt: row?.started_at ?? null,
    billingAttached: Boolean(row?.billing_customer_ref),
  };
}

/** What the counter table says this workspace has used this period. */
export async function readCounters(
  db: SupabaseClient,
  period: string,
): Promise<Record<MeterId, number>> {
  const zero = { answers: 0, documents: 0 } as Record<MeterId, number>;
  const { data, error } = await safeRead(
    () => db.from('usage_counters').select('meter, used').eq('period', period),
    { data: null, error: { message: 'counters unreadable' } } as {
      data: unknown[] | null;
      error: unknown;
    },
  );
  if (error || !data) return zero;
  for (const row of data as Array<{ meter: string; used: number | null }>) {
    if (row.meter === 'answers' || row.meter === 'documents') {
      zero[row.meter] = row.used ?? 0;
    }
  }
  return zero;
}

export interface WorkspaceUsage extends WorkspacePlan {
  period: string;
  meters: Record<MeterId, Entitlement>;
  seats: SeatUsage;
}

export interface SeatUsage {
  /** People with a directory row in this workspace. */
  members: number;
  /** Invitations sent and not yet accepted. They hold a seat. */
  pending: number;
  used: number;
  limit: number | null;
  /** True when one more person cannot be invited. */
  full: boolean;
}

/**
 * Seats, counted live rather than metered.
 *
 * A seat is not consumed, it is occupied — so there is no ledger for it and no
 * period. Pending invitations count, because the alternative is a workspace that
 * invites twenty people onto a three-seat plan and discovers the problem when
 * they all arrive.
 */
export async function readSeats(
  db: SupabaseClient,
  organizationId: string,
  limit: number | null,
): Promise<SeatUsage> {
  const empty = { count: 0, error: null } as { count: number | null; error: unknown };
  const [members, invitations] = await Promise.all([
    // `users` is the per-workspace directory (migration 0064 § 3) and is a
    // tenant table, so the scoped handle filters it.
    safeRead(() => db.from('users').select('id', { count: 'exact', head: true }), empty),
    // `ba_invitation` is `shared`: it carries better-auth's own camel-cased
    // organizationId and the scoped handle passes it through untouched, so this
    // is one of the few filters in the product written by hand. It is written
    // from the id the handle itself is pinned to, never from user input.
    safeRead(
      () =>
        db
          .from('ba_invitation')
          .select('id', { count: 'exact', head: true })
          .eq('organizationId', organizationId)
          .eq('status', 'pending'),
      empty,
    ),
  ]);

  const memberCount = members.count ?? 0;
  const pendingCount = invitations.error ? 0 : (invitations.count ?? 0);
  const used = memberCount + pendingCount;

  return {
    members: memberCount,
    pending: pendingCount,
    used,
    limit,
    full: limit !== null && used >= limit,
  };
}

/** Everything the plan screen shows, in one call. */
export async function readWorkspaceUsage(
  db: SupabaseClient,
  organizationId: string,
  at: Date = new Date(),
): Promise<WorkspaceUsage> {
  const period = usagePeriod(at);
  const workspacePlan = await readWorkspacePlan(db);
  const [counters, seats] = await Promise.all([
    readCounters(db, period),
    readSeats(db, organizationId, workspacePlan.plan.seatsLimit),
  ]);

  const meters = {} as Record<MeterId, Entitlement>;
  for (const meter of METERS) {
    meters[meter] = entitlementFor(workspacePlan.plan, meter, counters[meter]);
  }

  return { ...workspacePlan, period, meters, seats };
}

/**
 * Where one meter stands. The gate.
 *
 * Two parallel reads and a cached catalogue lookup. It runs before every answer,
 * which is why it does not go through `readWorkspaceUsage` — the seat count is
 * two more queries and no turn has ever been refused because of it.
 *
 * FAILS OPEN, ON PURPOSE. If the counter or the subscription cannot be read, the
 * caller gets an unlimited entitlement and the turn proceeds. A metering outage
 * must not become a product outage: the cost of being wrong here is a handful of
 * uncharged answers, and the ledger — which is written by a trigger and does not
 * depend on this code path at all — still recorded every one of them, so nothing
 * is lost, only briefly ungated.
 */
export async function checkMeter(
  db: SupabaseClient,
  meter: MeterId,
  at: Date = new Date(),
): Promise<Entitlement> {
  try {
    const period = usagePeriod(at);
    const [workspacePlan, counters] = await Promise.all([
      readWorkspacePlan(db),
      readCounters(db, period),
    ]);
    return entitlementFor(workspacePlan.plan, meter, counters[meter]);
  } catch {
    return entitlementFor(
      { ...FALLBACK_PLAN, limits: { answers: null, documents: null }, seatsLimit: null },
      meter,
      0,
    );
  }
}

export interface UsageEventRow {
  id: string;
  meter: MeterId;
  quantity: number;
  subjectTable: string;
  subjectId: string;
  source: string | null;
  occurredAt: string;
  /** What the row is, in words: a conversation title, a document name. */
  label: string | null;
}

/**
 * The list under the number.
 *
 * This is the auditability promise made concrete: the figure a workspace is
 * charged is not an assertion, it is the length of this list, and every entry
 * names a message or a document the customer can open. Newest first, because
 * "what did we just spend that on" is the question people actually arrive with.
 *
 * The labels are a second and third query rather than a PostgREST embed:
 * `usage_events.subject_id` is a plain uuid with no foreign key (see 0085 § 4 on
 * why the ledger deliberately has none), so there is no relationship for an
 * embed to follow. Both label queries go through the scoped handle over tenant
 * tables, so a label can only ever come from this workspace.
 */
export async function listUsageEvents(
  db: SupabaseClient,
  { meter, period, limit = 100 }: { meter: MeterId; period: string; limit?: number },
): Promise<UsageEventRow[]> {
  const { data, error } = await safeRead(
    () =>
      db
        .from('usage_events')
        .select('id, meter, quantity, subject_table, subject_id, source, occurred_at')
        .eq('meter', meter)
        .eq('period', period)
        .order('occurred_at', { ascending: false })
        .limit(limit),
    { data: null, error: { message: 'ledger unreadable' } } as {
      data: unknown[] | null;
      error: unknown;
    },
  );
  if (error || !data) return [];

  const rows = data as Array<{
    id: string;
    meter: string;
    quantity: number | null;
    subject_table: string;
    subject_id: string;
    source: string | null;
    occurred_at: string;
  }>;
  const ids = rows.map((r) => r.subject_id);
  const labels = ids.length === 0 ? new Map<string, string>() : await labelsFor(db, meter, ids);

  return rows.map((r) => ({
    id: r.id,
    meter: r.meter as MeterId,
    quantity: r.quantity ?? 1,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    source: r.source,
    occurredAt: r.occurred_at,
    label: labels.get(r.subject_id) ?? null,
  }));
}

async function labelsFor(
  db: SupabaseClient,
  meter: MeterId,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    if (meter === 'documents') {
      const { data } = await db.from('kb_documents').select('id, title').in('id', ids);
      for (const row of (data ?? []) as Array<{ id: string; title: string | null }>) {
        if (row.title) out.set(row.id, row.title);
      }
      return out;
    }

    // An answer is labelled by the conversation it belongs to, not by its own
    // text: the point of the list is "which conversations did we pay for", and
    // quoting the assistant's prose into a billing screen would put the
    // company's own content somewhere it does not need to be.
    const { data: messages } = await db
      .from('messages')
      .select('id, conversation_id')
      .in('id', ids);
    const rows = (messages ?? []) as Array<{ id: string; conversation_id: string }>;
    const conversationIds = [...new Set(rows.map((m) => m.conversation_id))];
    if (conversationIds.length === 0) return out;

    const { data: conversations } = await db
      .from('conversations')
      .select('id, title')
      .in('id', conversationIds);
    const titles = new Map(
      ((conversations ?? []) as Array<{ id: string; title: string | null }>).map((c) => [
        c.id,
        c.title,
      ]),
    );
    for (const message of rows) {
      const title = titles.get(message.conversation_id);
      if (title) out.set(message.id, title);
    }
    return out;
  } catch {
    // A missing label costs a row its name, never the list its numbers.
    return out;
  }
}

/**
 * The earliest metered moment this workspace has, or null.
 *
 * Shown on the plan screen next to the totals. Without it "0 respuestas" is
 * ambiguous between "we did not use it" and "the meter only started on Tuesday",
 * and since the ledger is deliberately not backfilled (0085), the second is the
 * true answer for everybody for the first month.
 */
export async function meteringSince(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await safeRead(
    () =>
      db
        .from('usage_counters')
        .select('first_at')
        .order('first_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
    { data: null, error: { message: 'unreadable' } } as { data: unknown; error: unknown },
  );
  if (error || !data) return null;
  return (data as { first_at?: string }).first_at ?? null;
}
