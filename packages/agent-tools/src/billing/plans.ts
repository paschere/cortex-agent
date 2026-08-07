/**
 * What a workspace is allowed to consume, and what happens when it stops being
 * allowed.
 *
 * Everything in this file is PURE — no database, no clock it does not accept as
 * an argument, no I/O. That is deliberate: the decision to refuse somebody
 * service is the one decision in this product that a customer will argue with,
 * and it should be reproducible from four numbers on a screen rather than
 * inferable from a stack trace. `plans.test.ts` walks every state boundary.
 *
 * ===========================================================================
 * THE UNIT
 * ===========================================================================
 * Two meters, both in units a person says out loud:
 *
 *   answers    one every time Cortex answers somebody, on any surface.
 *   documents  one every time something enters Brain Knowledge.
 *
 * Not tokens. Nobody has ever decided to buy 4.2 million of them. Not a single
 * blended credit either — that is a token wearing a friendlier name, because the
 * customer would have to learn an exchange rate to predict their own bill.
 * Transcription is not a third meter: an hour of audio is one document, which is
 * how the person who uploaded it thinks about it.
 *
 * The counting itself is not done here or anywhere in TypeScript. It is done by
 * database triggers on the tables that already record the work (migration 0085
 * § 9), so no code path can produce an answer without producing its receipt.
 *
 * ===========================================================================
 * WHAT HAPPENS AT THE LIMIT
 * ===========================================================================
 * The two obvious answers are both wrong. Cutting somebody off mid-conversation
 * is a product that betrays you at the worst possible moment — the moment you
 * were relying on it. Never cutting anybody off is a price list nobody has to
 * read. So the rule is neither, and it is one sentence:
 *
 *   NOTHING IS EVER INTERRUPTED. THINGS STOP BEING STARTED.
 *
 * Concretely, in three steps:
 *
 *   1. At 80% (`WARNING_AT`) the state becomes `warning`. Nothing changes except
 *      that the product says so, in the places somebody will see it, while there
 *      is still time to do something about it.
 *
 *   2. At 100% the state becomes `grace` — and the product KEEPS WORKING. The
 *      workspace gets a courtesy margin on top of its limit (`graceFor`: 10% of
 *      the plan, never fewer than 10 answers). This is the half that protects
 *      the person mid-conversation: crossing the line in the middle of asking
 *      something does not end the conversation, it puts a banner on the screen
 *      and sends the owner one email. You cannot walk into the wall by accident.
 *
 *   3. Past limit + margin the state becomes `blocked`, and what is blocked is
 *      the START of new work. A turn already streaming always finishes: the gate
 *      runs before the model is called and never during, so there is no code
 *      path that can truncate an answer somebody is reading.
 *
 * ===========================================================================
 * BLOCKED VERSUS DEGRADED, WHICH IS NOT THE SAME DECISION
 * ===========================================================================
 * `LIMIT_POLICY` says which meter does which, and the split is not arbitrary:
 *
 *   answers   -> block.  An answer is a thing we have not done yet. Declining to
 *                start one costs the customer nothing they already had, and it
 *                is the meter that maps to the money.
 *
 *   documents -> degrade. A document is a thing the customer has ALREADY HANDED
 *                US. Refusing it would mean losing their contract to a billing
 *                rule, which no plan is worth. So an over-limit upload is stored
 *                and stays readable and keyword-searchable; what it does not get
 *                is an embedding, so it is absent from semantic retrieval until
 *                there is room. The existing kb-reindex-embeddings drain picks
 *                it up on its next pass once the plan changes or the month does.
 *                Nothing is thrown away and nothing needs re-uploading.
 *
 *   seats     -> block, and this is the clean case: inviting a sixteenth person
 *                interrupts nothing at all, and the fifteen already inside keep
 *                working.
 *
 * ===========================================================================
 * BILLING: MEASURED, NOT COLLECTED
 * ===========================================================================
 * There is no payment gateway in this codebase and adding one now would be work
 * thrown away. A gateway integration is downstream of commercial decisions that
 * do not exist yet — whether the price below survives contact with a customer,
 * whether collection is a card or a monthly transfer against an electronic
 * invoice (which is what a Colombian SMB will actually ask for), and therefore
 * whether the rails are Wompi, PayU, dLocal or a bank. Those four do not agree
 * on what a "subscription" is, so the adapter written today gets rewritten.
 *
 * What is NOT deferred is everything that makes billing possible the day the
 * decision exists: a ledger where the unit is a row that cannot be counted twice
 * (migration 0085 § 4), a closed monthly period, a price on every plan in the
 * currency it will be charged in, and two columns waiting for a gateway's
 * customer and subscription ids. Invoicing from that is a query; the hard part
 * — an exact, auditable, tenant-safe meter — is what is done here.
 */

/** The two things a customer buys. */
export const METERS = ['answers', 'documents'] as const;
export type MeterId = (typeof METERS)[number];

/** What the product does to a meter that has run out. See the header. */
export type LimitPolicy = 'block' | 'degrade';

export const LIMIT_POLICY: Readonly<Record<MeterId, LimitPolicy>> = {
  answers: 'block',
  documents: 'degrade',
};

/** Seats are not metered — they are counted live — but they are still gated. */
export const SEATS_POLICY: LimitPolicy = 'block';

/** Fraction of the allowance at which the product starts saying so. */
export const WARNING_AT = 0.8;

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled';

export interface Plan {
  code: string;
  name: string;
  tagline: string;
  /** Monthly price in Colombian pesos, whole units. */
  priceCop: number;
  /** null on a meter means sin límite. Never a sentinel number — see 0085 § 2. */
  limits: Readonly<Record<MeterId, number | null>>;
  seatsLimit: number | null;
  graceRatio: number;
  graceMinimum: number;
  /** False for plans an owner cannot put themselves on from inside the product. */
  selfServe: boolean;
  sortOrder: number;
}

/**
 * The plan a workspace is treated as being on when it has no subscription row.
 *
 * It is the free plan and not an unlimited one on purpose: a missing row is an
 * anomaly, and an anomaly that grants unlimited service is one nobody reports.
 * The workspace that actually predates plans does not reach this — migration
 * 0085 § 7 wrote it a real `custom` row, precisely so that its entitlement is
 * never a fallback.
 */
export const FALLBACK_PLAN: Plan = {
  code: 'free',
  name: 'Gratis',
  tagline: 'Para probar Cortex con tu equipo, sin tarjeta.',
  priceCop: 0,
  limits: { answers: 150, documents: 50 },
  seatsLimit: 3,
  graceRatio: 0.1,
  graceMinimum: 10,
  selfServe: true,
  sortOrder: 1,
};

/**
 * `ok` under the warning line, `warning` approaching the limit, `grace` past the
 * limit but inside the courtesy margin, `blocked` past both.
 *
 * A meter with no limit is always `ok`. There is no fifth state for "unlimited"
 * because every consumer of this would have to handle it identically to `ok`,
 * and the one that forgot would be the one gating the grandfathered workspace.
 */
export type MeterState = 'ok' | 'warning' | 'grace' | 'blocked';

export interface Entitlement {
  meter: MeterId;
  state: MeterState;
  used: number;
  /** null = sin límite. */
  limit: number | null;
  /** Courtesy units on top of the limit. 0 when unlimited. */
  grace: number;
  /** limit + grace, i.e. the point at which `blocked` starts. null = unlimited. */
  allowance: number | null;
  /** Against the LIMIT, not the allowance: what is left before the warning wall. */
  remaining: number | null;
  /** used / limit, uncapped so "118%" can be shown honestly. null = unlimited. */
  ratio: number | null;
  /** What the product does about it if this meter runs out. */
  policy: LimitPolicy;
}

/**
 * The courtesy margin for one meter: 10% of the plan, never fewer than
 * `graceMinimum`.
 *
 * The minimum is what makes this work on a small plan. Ten percent of the free
 * plan's 50 documents is five, which is not enough room to notice a banner and
 * do something about it; the floor turns the margin into an actual chance rather
 * than a rounding error. On a big plan the ratio dominates and the floor never
 * binds.
 */
export function graceFor(plan: Plan, meter: MeterId): number {
  const limit = plan.limits[meter];
  if (limit === null) return 0;
  return Math.max(plan.graceMinimum, Math.ceil(limit * plan.graceRatio));
}

/** The same, for seats. */
export function seatsGraceFor(_plan: Plan): number {
  // None. A seat is not consumed in the middle of anything, so there is nothing
  // to protect from an abrupt stop — the margin exists to keep a conversation
  // alive, and an invitation is not a conversation.
  return 0;
}

/** Where a meter stands, given a plan and a count. Pure. */
export function entitlementFor(plan: Plan, meter: MeterId, used: number): Entitlement {
  const limit = plan.limits[meter] ?? null;
  const policy = LIMIT_POLICY[meter];

  if (limit === null) {
    return {
      meter,
      state: 'ok',
      used,
      limit: null,
      grace: 0,
      allowance: null,
      remaining: null,
      ratio: null,
      policy,
    };
  }

  const grace = graceFor(plan, meter);
  const allowance = limit + grace;
  const state: MeterState =
    used > allowance
      ? 'blocked'
      : used >= limit
        ? 'grace'
        : used >= Math.floor(limit * WARNING_AT)
          ? 'warning'
          : 'ok';

  return {
    meter,
    state,
    used,
    limit,
    grace,
    allowance,
    remaining: Math.max(0, limit - used),
    ratio: limit === 0 ? null : used / limit,
    policy,
  };
}

/**
 * True when the product should decline to START new work on this meter.
 *
 * Two conditions, and both matter. `blocked` is the count. `policy === 'block'`
 * is the decision — a degrading meter is never a refusal however far past its
 * allowance it goes, because the customer already handed us the thing.
 */
export function isRefused(entitlement: Entitlement): boolean {
  return entitlement.state === 'blocked' && entitlement.policy === 'block';
}

/** True when work should still be done, but with less of it. See LIMIT_POLICY. */
export function isDegraded(entitlement: Entitlement): boolean {
  return (
    (entitlement.state === 'blocked' || entitlement.state === 'grace') &&
    entitlement.policy === 'degrade'
  );
}

/**
 * The billing period a moment falls in: calendar month in America/Bogota, as
 * `YYYY-MM`.
 *
 * MUST agree, character for character, with `public.usage_period_of()` in
 * migration 0085 § 1 — the counter row this key reads was written by that
 * function, so a disagreement does not throw, it silently reads a period with no
 * rows in it and grants everybody a fresh month. `plans.test.ts` pins the format;
 * the SQL side pins the timezone.
 *
 * Built from `formatToParts` rather than a locale whose output shape happens to
 * look right today, because "which locale renders YYYY-MM" is not a stable API.
 */
export function usagePeriod(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${year}-${month}`;
}

/** The first day of the next period, for "se renueva el …". */
export function nextPeriodStart(period: string): Date {
  const [year, month] = period.split('-').map((n) => Number.parseInt(n, 10));
  if (!year || !month) return new Date();
  // Bogotá is UTC-5 year-round (no DST), so midnight local is 05:00 UTC. Stated
  // as a constant rather than computed, because computing it needs a date that
  // does not exist yet.
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1, 5));
}

/** A database row from `public.plans`, as PostgREST returns it. */
export interface PlanRow {
  code: string;
  name: string;
  tagline: string;
  price_cop: number;
  answers_limit: number | null;
  documents_limit: number | null;
  seats_limit: number | null;
  grace_ratio: number | string;
  grace_minimum: number;
  self_serve: boolean;
  sort_order: number;
}

/** `numeric` arrives from PostgREST as a string; everything else is a number. */
export function toPlan(row: PlanRow): Plan {
  return {
    code: row.code,
    name: row.name,
    tagline: row.tagline,
    priceCop: Number(row.price_cop) || 0,
    limits: { answers: row.answers_limit, documents: row.documents_limit },
    seatsLimit: row.seats_limit,
    graceRatio: Number(row.grace_ratio) || 0,
    graceMinimum: Number(row.grace_minimum) || 0,
    selfServe: row.self_serve !== false,
    sortOrder: Number(row.sort_order) || 0,
  };
}
