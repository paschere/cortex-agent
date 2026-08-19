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
 * THE QUOTA BELONGS TO THE HEAD, LIKE THE ASSISTANT
 * ===========================================================================
 * Cortex is sold per person: $30.000 each from five people, $24.000 each from
 * twenty-five, and each person brings answers and documents with them. So a plan
 * does not carry a limit — it carries a RATE, and the limit is that rate times
 * however many people the workspace has:
 *
 *     limit = plan.perSeat[meter] x seats.billable
 *
 * Migration 0086 renamed the columns to say so (`answers_per_seat`, not
 * `answers_limit`) and dropped the old ones, because the same number in the same
 * slot meaning something different is how a company gets blocked on the third of
 * the month by arithmetic that adds up. The types here do the same job: nothing
 * in this module will compute a limit without being handed a `SeatBasis`, so a
 * caller cannot accidentally compare a whole company's consumption against one
 * person's allowance — the compiler stops them.
 *
 * Consumption is still counted for the workspace as a whole. That is what the
 * pricing page states ("los cupos se cuentan juntos para tu empresa") and it is
 * the kinder reading: the lawyer who asks forty questions the week a contract
 * lands is not stopped because her own share ran out while nine colleagues left
 * theirs untouched.
 *
 * ===========================================================================
 * SEATS: WHO COUNTS, AND WHY THE CEILING NEVER FALLS MID-MONTH
 * ===========================================================================
 * `seatBasisFor` takes the largest of four numbers:
 *
 *   members      people with a directory row — the ones who can ask Cortex
 *                something. Pending invitations are NOT here: an invitation
 *                nobody accepts would buy a month of quota for a person who
 *                never arrived. They still count against `seatsMaximum`, which
 *                is the question they are actually relevant to.
 *
 *   peak         the most members the workspace had AT ONCE this period, kept by
 *                triggers in `organization_seat_periods` (0086 § 5). This is the
 *                one that matters. Somebody joining on the 14th raises the
 *                ceiling, which is right — they are being paid for. Somebody
 *                LEAVING on the 14th must not lower it: a workspace at 1.400 of
 *                1.500 that loses two people would land at 1.400 of 1.200 and be
 *                blocked instantly, retroactively, by a personnel change. The
 *                ceiling comes back down at the period boundary, which is also
 *                when the invoice changes.
 *
 *   contracted   seats agreed with the customer, when something was agreed. A
 *                floor, never a ceiling — a workspace that outgrows its contract
 *                is entitled to what it actually has, and owes for it.
 *
 *   minimum      the plan's billing floor: 5 on Equipo, 25 on Empresa. It is
 *                NOT a gate. A team of eight belongs on Equipo; a team of three
 *                that wants Equipo pays for five and receives five seats of
 *                quota, because you get exactly what you are charged for.
 *
 * The one hard ceiling on people is `seatsMaximum`, and only the free plan has
 * one. On a per-person price, capping how many people may join is declining
 * money.
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
 *      the effective limit, never fewer than 10 answers). This is the half that
 *      protects the person mid-conversation: crossing the line in the middle of
 *      asking something does not end the conversation, it puts a banner on the
 *      screen and sends the owner one email. You cannot walk into the wall by
 *      accident.
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
 *   seats     -> block, and this is the clean case: refusing a fourth person on
 *                the free plan interrupts nothing at all, and the three already
 *                inside keep working. It is also the only place a person is ever
 *                refused, because `seatsMaximum` is null on every paid plan.
 *
 * ===========================================================================
 * BILLING: MEASURED, NOT COLLECTED
 * ===========================================================================
 * There is still no payment gateway in this codebase and adding one now would be
 * work thrown away. A gateway integration is downstream of commercial decisions
 * that do not exist yet — whether collection is a card or a monthly transfer
 * against an electronic invoice (which is what a Colombian SMB will actually ask
 * for), and therefore whether the rails are Wompi, PayU, dLocal or a bank. Those
 * four do not agree on what a "subscription" is, so the adapter written today
 * gets rewritten. The public page says so in its own words — "todavía no
 * cobramos dentro de Cortex" — and shipping a checkout would make the one page
 * whose whole subject is not overstating things overstate something.
 *
 * What per-seat pricing changes is that the amount owed is now DERIVABLE rather
 * than a judgement call: `monthlyChargeCop()` is `priceCopPerSeat` times the
 * same billable seat count the quota came from, every input to it is in the
 * database, and it is shown on /plan next to the seat count it was computed
 * from. That is the number a gateway would be told to charge on the day one
 * exists; the columns waiting for that day are still empty.
 *
 * ===========================================================================
 * GERENTE IS NOT A BIGGER SEAT
 * ===========================================================================
 * Equipo and Empresa sell an assistant per person. Gerente sells the job: a
 * monthly retainer, unlimited answers, implantación and an SLA. The invoice is
 * `retainerCop`, not a headcount times a rate — fifteen people on Gerente still
 * owe ten million, not a hundred and fifty. `priceCopPerSeat` stays 0 on that
 * row so a caller that has not read the new column cannot accidentally bill
 * them as if they were Equipo.
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
  /**
   * Monthly price in Colombian pesos FOR ONE PERSON. There is no package price
   * anywhere: the invoice is this times the billable seats.
   */
  priceCopPerSeat: number;
  /**
   * What ONE PERSON brings per month. null means sin límite — never a sentinel
   * number, see 0085 § 2.
   *
   * Never compare a workspace total against this. `limitFor()` multiplies it by
   * the seat basis, and every reader in the product goes through that.
   */
  perSeat: Readonly<Record<MeterId, number | null>>;
  /**
   * The fewest people this plan is charged for. A floor on the bill, never a
   * limit on use: it is why a team of three can be on Equipo, and why they get
   * five seats of quota for the five they pay for.
   */
  billableSeatsMinimum: number;
  /**
   * The only hard ceiling on how many people a workspace may hold. null = sin
   * tope, which is every paid plan.
   */
  seatsMaximum: number | null;
  graceRatio: number;
  graceMinimum: number;
  /** False for plans an owner cannot put themselves on from inside the product. */
  selfServe: boolean;
  /**
   * Monthly retainer in whole pesos. When set, the invoice is this number, not
   * a rate times a headcount. null = per-person pricing.
   */
  retainerCop: number | null;
  sortOrder: number;
}

/**
 * The plan a workspace is treated as being on when it has no subscription row.
 *
 * It is the free plan and not an unlimited one on purpose: a missing row is an
 * anomaly, and an anomaly that grants unlimited service is one nobody reports.
 * The workspace that actually predates plans does not reach this — migration
 * 0085 § 7 wrote it a real row and 0086 § 3 repointed it at `enterprise`,
 * precisely so that its entitlement is never a fallback.
 */
export const FALLBACK_PLAN: Plan = {
  code: 'free',
  name: 'Gratis',
  tagline: 'Para probar Cortex con tu equipo, sin tarjeta. Hasta 3 personas.',
  priceCopPerSeat: 0,
  perSeat: { answers: 50, documents: 15 },
  billableSeatsMinimum: 1,
  seatsMaximum: 3,
  graceRatio: 0.1,
  graceMinimum: 10,
  selfServe: true,
  retainerCop: null,
  sortOrder: 1,
};

/**
 * What a workspace is treated as being on when the CATALOGUE ITSELF could not be
 * read — a different anomaly from a missing subscription, and it must have the
 * opposite answer.
 *
 * "This workspace has no subscription row" is a statement about one workspace
 * and the safe reading is the free plan. "The price list is unreadable" is a
 * statement about us: a schema change mid-deploy, a permission, an outage. Every
 * workspace in the install is affected at once, and the grandfathered one — whose
 * entitlement depends entirely on the catalogue saying its quotas are null —
 * would be silently downgraded to the free plan's numbers and blocked. Fail open
 * instead, which is the same posture `checkMeter` already documents: the cost of
 * being wrong is a handful of uncharged answers, and the ledger recorded every
 * one of them anyway.
 */
export const UNMETERED_PLAN: Plan = {
  code: 'unknown',
  name: 'Tu plan',
  tagline: 'No pudimos leer el catálogo de planes. Nada te está limitando ahora mismo.',
  priceCopPerSeat: 0,
  perSeat: { answers: null, documents: null },
  billableSeatsMinimum: 1,
  seatsMaximum: null,
  graceRatio: 0.1,
  graceMinimum: 10,
  selfServe: false,
  retainerCop: null,
  sortOrder: 99,
};

/**
 * How many people a workspace is entitled to — and charged for — this period.
 *
 * A value object rather than a bare number, and every function that needs a seat
 * count takes THIS type. That is the point: `entitlementFor(plan, meter, used,
 * seats)` cannot be called with the two numbers the wrong way round, and no
 * caller can pass "the people we have today" where "the people this month is
 * billed for" was meant. The one number that matters is computed in exactly one
 * place, by `seatBasisFor`.
 */
export interface SeatBasis {
  /** People with a directory row right now. */
  members: number;
  /** The most members this workspace had at once during the period. */
  peak: number;
  /** Seats agreed with the customer, if any. */
  contracted: number | null;
  /** The largest of the four; what the quota and the bill are both computed from. */
  billable: number;
}

/**
 * The seat basis, from the numbers that go into it. See the header for why each
 * of the four is in the max().
 */
export function seatBasisFor(
  plan: Plan,
  counts: { members: number; peak?: number; contracted?: number | null },
): SeatBasis {
  const members = Math.max(0, Math.floor(counts.members));
  const peak = Math.max(0, Math.floor(counts.peak ?? 0));
  const contracted =
    counts.contracted === null || counts.contracted === undefined
      ? null
      : Math.max(0, Math.floor(counts.contracted));

  return {
    members,
    peak,
    contracted,
    billable: Math.max(members, peak, contracted ?? 0, plan.billableSeatsMinimum, 1),
  };
}

/** A workspace with nobody in it yet, for the fail-open paths. */
export function emptySeatBasis(plan: Plan): SeatBasis {
  return seatBasisFor(plan, { members: 0 });
}

/**
 * The effective ceiling for one meter: what one person brings, times the people
 * this workspace is billed for. null when the plan has no limit on that meter —
 * null times anything is still null, which is what keeps Enterprise unlimited
 * however many people it has.
 */
export function limitFor(plan: Plan, meter: MeterId, seats: SeatBasis): number | null {
  const perSeat = plan.perSeat[meter];
  if (perSeat === null || perSeat === undefined) return null;
  return perSeat * seats.billable;
}

/** What this workspace owes for a month at this seat basis, in whole pesos. */
export function monthlyChargeCop(plan: Plan, seats: SeatBasis): number {
  if (plan.retainerCop != null) return plan.retainerCop;
  return plan.priceCopPerSeat * seats.billable;
}

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
  /** What one person brings on this plan. null = sin límite. */
  perSeat: number | null;
  /** The people this limit was computed from. */
  seats: number;
  /** perSeat x seats. null = sin límite. */
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
 * The courtesy margin for one meter: 10% of the EFFECTIVE limit, never fewer
 * than `graceMinimum`.
 *
 * The minimum is what makes this work on a small workspace. Ten percent of one
 * free seat's 15 documents is two, which is not enough room to notice a banner
 * and do something about it; the floor turns the margin into an actual chance
 * rather than a rounding error. On a workspace with real headcount the ratio
 * dominates and the floor never binds.
 */
export function graceFor(plan: Plan, meter: MeterId, seats: SeatBasis): number {
  const limit = limitFor(plan, meter, seats);
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

/** Where a meter stands, given a plan, a seat basis and a count. Pure. */
export function entitlementFor(
  plan: Plan,
  meter: MeterId,
  used: number,
  seats: SeatBasis,
): Entitlement {
  const perSeat = plan.perSeat[meter] ?? null;
  const limit = limitFor(plan, meter, seats);
  const policy = LIMIT_POLICY[meter];

  if (limit === null) {
    return {
      meter,
      state: 'ok',
      used,
      perSeat: null,
      seats: seats.billable,
      limit: null,
      grace: 0,
      allowance: null,
      remaining: null,
      ratio: null,
      policy,
    };
  }

  const grace = graceFor(plan, meter, seats);
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
    perSeat,
    seats: seats.billable,
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
 * rows in it and grants everybody a fresh month. Since 0086 the seat high-water
 * mark is keyed by the same function, so the seat basis and the consumption it
 * gates are always talking about the same month. `plans.test.ts` pins the format;
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

/**
 * A database row from `public.plans`, as PostgREST returns it.
 *
 * The names are 0086's, and 0086 dropped the ones they replaced. A build still
 * asking for `answers_limit` gets an error naming the column rather than a
 * plausible number that means something else — which is the whole reason the old
 * columns were dropped instead of deprecated.
 */
export interface PlanRow {
  code: string;
  name: string;
  tagline: string;
  price_cop_per_seat: number;
  answers_per_seat: number | null;
  documents_per_seat: number | null;
  billable_seats_minimum: number | null;
  seats_maximum: number | null;
  grace_ratio: number | string;
  grace_minimum: number;
  self_serve: boolean;
  retainer_cop: number | null;
  sort_order: number;
}

/** `numeric` arrives from PostgREST as a string; everything else is a number. */
export function toPlan(row: PlanRow): Plan {
  return {
    code: row.code,
    name: row.name,
    tagline: row.tagline,
    priceCopPerSeat: Number(row.price_cop_per_seat) || 0,
    perSeat: { answers: row.answers_per_seat, documents: row.documents_per_seat },
    billableSeatsMinimum: Math.max(1, Number(row.billable_seats_minimum) || 1),
    seatsMaximum: row.seats_maximum,
    graceRatio: Number(row.grace_ratio) || 0,
    graceMinimum: Number(row.grace_minimum) || 0,
    selfServe: row.self_serve !== false,
    retainerCop:
      row.retainer_cop === null || row.retainer_cop === undefined
        ? null
        : Number(row.retainer_cop) || 0,
    sortOrder: Number(row.sort_order) || 0,
  };
}
