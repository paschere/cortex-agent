import { z } from 'zod';

/**
 * The pure core of the commitments module: dates, states, sources and the
 * decision about which notices are owed today.
 *
 * Everything in this file is a function of its arguments. No database, no
 * clock beyond the `now` it is handed, no model. That is deliberate — the two
 * things most likely to be wrong in this module are the timezone arithmetic
 * and the "have we already said this" rule, and both are only testable if they
 * are separable from the job that runs them.
 */

// ---------------------------------------------------------------------------
// Time, in Bogotá
// ---------------------------------------------------------------------------

/**
 * Colombia does not observe daylight saving, so this is a fixed UTC-5 and the
 * only timezone this module knows about. If Cortex ever watches deadlines in
 * another country, this becomes a per-workspace setting and every call site
 * already takes it as an argument.
 */
export const COMMITMENTS_TIMEZONE = 'America/Bogota';

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const BOGOTA_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: COMMITMENTS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today's calendar day where the people using this actually are, as
 * `YYYY-MM-DD`.
 *
 * This is the single place the timezone is applied, and getting it wrong is
 * the most expensive small bug available in this module: between 19:00 and
 * midnight Colombian time the UTC date is already tomorrow, so a watcher that
 * asked `new Date().toISOString().slice(0,10)` would declare things due
 * "today" a day early — every evening, quietly, forever.
 */
export function bogotaToday(now: Date = new Date()): string {
  const parts = BOGOTA_PARTS.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. Negative = past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / DAY_MS);
}

/** Days from today until a due date. Negative once it has passed. */
export function daysUntilDue(dueOn: string, today: string): number {
  return daysBetween(today, dueOn);
}

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Add whole months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. The naive version
 * (`setMonth`) rolls over, and a monthly payment set up on the 31st would walk
 * forward through the calendar a few days a year until it landed on the wrong
 * date entirely.
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export const isoDate = z
  .string()
  .regex(ISO_DATE, 'Use a calendar date, YYYY-MM-DD')
  .describe('Calendar date, YYYY-MM-DD, read in Colombian time (UTC-5)');

// ---------------------------------------------------------------------------
// What kind of thing this is
// ---------------------------------------------------------------------------

export const COMMITMENT_KINDS = [
  'soat',
  'rtm',
  'contract',
  'policy',
  'warranty',
  'customs',
  'payment',
  'other',
] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

/**
 * How much warning each kind deserves, in days.
 *
 * These are not arbitrary: they are how long the thing actually takes to sort
 * out. Booking a tecnomecánica appointment and getting the truck there is a
 * few weeks of scheduling around routes; renewing a client contract needs a
 * conversation and a signature, so it gets longer; a payment needs someone to
 * approve a transfer, which is days. Warning a month ahead about a payment
 * trains people to ignore the warning, and warning three days ahead about a
 * contract renewal is not a warning, it is a post-mortem.
 */
export const DEFAULT_NOTICE_DAYS: Record<CommitmentKind, number> = {
  soat: 30,
  rtm: 30,
  contract: 45,
  policy: 30,
  warranty: 15,
  customs: 7,
  payment: 3,
  other: 15,
};

/** Spanish labels for the screen and for anything Cortex says out loud. */
export const KIND_LABEL: Record<CommitmentKind, string> = {
  soat: 'SOAT',
  rtm: 'Tecnomecánica',
  contract: 'Contrato',
  policy: 'Póliza',
  warranty: 'Garantía',
  customs: 'Plazo de aduana',
  payment: 'Pago',
  other: 'Otro',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const COMMITMENT_STATES = ['in_force', 'due_soon', 'overdue', 'met', 'dropped'] as const;
export type CommitmentState = (typeof COMMITMENT_STATES)[number];

/** The three colours the design system already uses for exactly this. */
export const STATE_TONE: Record<CommitmentState, 'emerald' | 'amber' | 'rose' | 'ink'> = {
  in_force: 'emerald',
  due_soon: 'amber',
  overdue: 'rose',
  met: 'emerald',
  dropped: 'ink',
};

export const STATE_LABEL: Record<CommitmentState, string> = {
  in_force: 'Vigente',
  due_soon: 'Por vencer',
  overdue: 'Vencido',
  met: 'Cumplido',
  dropped: 'Descartado',
};

/**
 * What state a commitment is in today.
 *
 * `met` and `dropped` are decisions a person made and are returned untouched.
 * The other three are recomputed from the date every single time rather than
 * read off the row, so the screen is never showing yesterday's answer because
 * the watcher has not run yet.
 */
export function deriveState(
  row: { state?: string | null; due_on: string; notice_days?: number | null },
  today: string,
): CommitmentState {
  if (row.state === 'met') return 'met';
  if (row.state === 'dropped') return 'dropped';
  const left = daysUntilDue(row.due_on, today);
  if (Number.isNaN(left)) return 'in_force';
  if (left < 0) return 'overdue';
  if (left <= (row.notice_days ?? DEFAULT_NOTICE_DAYS.other)) return 'due_soon';
  return 'in_force';
}

/** True for the states that are still somebody's problem. */
export function isOpen(state: CommitmentState): boolean {
  return state === 'in_force' || state === 'due_soon' || state === 'overdue';
}

// ---------------------------------------------------------------------------
// Where the date came from
// ---------------------------------------------------------------------------

export const SOURCE_KINDS = ['manual', 'system', 'document'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const sourceSchema = z.object({
  kind: z
    .enum(SOURCE_KINDS)
    .describe(
      'manual: a person stated it. system: read out of a system of record such as RUNT. document: extracted from a document in Brain Knowledge.',
    ),
  /** "RUNT", "Ana Gómez", "Contrato Servientrega 2026.pdf" — what to cite. */
  label: z.string().describe('What to name as the source when saying this out loud'),
  readAt: z
    .string()
    .nullable()
    .describe('When the source was read, ISO. Null for something a person simply stated.'),
  documentId: z.string().nullable(),
  chunkId: z.string().nullable(),
  quote: z
    .string()
    .nullable()
    .describe('The literal sentence the date was read out of, for document-sourced dates'),
  confirmed: z
    .boolean()
    .describe('False means it is waiting for a human to confirm it and is NOT being watched'),
});

export type CommitmentSource = z.infer<typeof sourceSchema>;

export class MissingSourceError extends Error {
  constructor(detail: string) {
    super(
      `A commitment cannot be created without a verifiable source: ${detail}. Every date Cortex watches has to be traceable to the person who stated it, the system it was read from, or the document sentence it was quoted from — see migration 0069.`,
    );
    this.name = 'MissingSourceError';
  }
}

interface SourceColumns {
  source_kind: SourceKind;
  source_system: string | null;
  source_read_at: string | null;
  source_user_id: string | null;
  source_document_id: string | null;
  source_chunk_id: string | null;
  source_quote: string | null;
  review_state: 'pending' | 'confirmed' | 'rejected';
  confirmed_at: string | null;
  confirmed_by: string | null;
}

export type SourceInput =
  | { kind: 'manual'; userId: string }
  | { kind: 'system'; system: string; readAt: string }
  | { kind: 'document'; documentId: string; chunkId?: string | null; quote: string };

/**
 * Turn a source into the columns that satisfy migration 0069's constraints —
 * and refuse, in TypeScript, anything that would not.
 *
 * The database already rejects a sourceless row; this exists so the refusal
 * arrives with a sentence a person can act on instead of a Postgres constraint
 * name, and so the "extracted goes to review" rule is expressed once, here,
 * rather than remembered at each of the three call sites that write rows.
 */
export function sourceColumns(source: SourceInput): SourceColumns {
  const base = {
    source_system: null,
    source_read_at: null,
    source_user_id: null,
    source_document_id: null,
    source_chunk_id: null,
    source_quote: null,
    confirmed_at: null,
    confirmed_by: null,
  };

  switch (source.kind) {
    case 'manual': {
      if (!source.userId) throw new MissingSourceError('a manual commitment needs the person');
      return {
        ...base,
        source_kind: 'manual',
        source_user_id: source.userId,
        review_state: 'confirmed',
      };
    }
    case 'system': {
      if (!source.system || !source.readAt) {
        throw new MissingSourceError('a system-read date needs the system and the moment read');
      }
      return {
        ...base,
        source_kind: 'system',
        source_system: source.system,
        source_read_at: source.readAt,
        review_state: 'confirmed',
      };
    }
    case 'document': {
      if (!source.documentId || !source.quote || source.quote.trim().length < 8) {
        throw new MissingSourceError(
          'a date taken from a document needs the document and the sentence it was read from',
        );
      }
      // The one branch that is NOT confirmed. An extracted date is a proposal
      // until a person says otherwise, and nothing in this codebase can hand it
      // to the watcher without that step.
      return {
        ...base,
        source_kind: 'document',
        source_document_id: source.documentId,
        source_chunk_id: source.chunkId ?? null,
        source_quote: source.quote.trim(),
        review_state: 'pending',
      };
    }
  }
}

/** How to introduce the source of a date in a sentence or on a chip. */
export function describeSource(row: CommitmentRow): CommitmentSource {
  const confirmed = row.review_state === 'confirmed';
  switch (row.source_kind) {
    case 'system':
      return {
        kind: 'system',
        label: row.source_system ?? 'sistema',
        readAt: row.source_read_at,
        documentId: null,
        chunkId: null,
        quote: null,
        confirmed,
      };
    case 'document':
      return {
        kind: 'document',
        label: row.source_document_title ?? 'Brain Knowledge',
        readAt: row.created_at,
        documentId: row.source_document_id,
        chunkId: row.source_chunk_id,
        quote: row.source_quote,
        confirmed,
      };
    default:
      return {
        kind: 'manual',
        label: row.source_user_name ?? 'registrado a mano',
        readAt: row.created_at,
        documentId: null,
        chunkId: null,
        quote: null,
        confirmed,
      };
  }
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

export const RECURRENCES = ['none', 'monthly', 'quarterly', 'yearly', 'from_source'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  none: 'No se repite',
  monthly: 'Cada mes',
  quarterly: 'Cada trimestre',
  yearly: 'Cada año',
  from_source: 'La próxima la trae el sistema',
};

/**
 * The date of the next occurrence, or null when Cortex must not invent one.
 *
 * `from_source` returns null on purpose and that is the whole point of it
 * existing: the next SOAT expiry is whatever RUNT says after the renewal, and
 * `due_on + 365` filed as "read from RUNT" would be a fabricated date wearing
 * a trustworthy label. The fleet sync creates that row when the registry
 * actually reports it.
 */
export function nextDueOn(dueOn: string, recurrence: Recurrence): string | null {
  switch (recurrence) {
    case 'monthly':
      return addMonths(dueOn, 1);
    case 'quarterly':
      return addMonths(dueOn, 3);
    case 'yearly':
      return addMonths(dueOn, 12);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Which notices are owed today
// ---------------------------------------------------------------------------

export const NOTICE_KINDS = ['ahead', 'due_today', 'overdue', 'escalation'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * Which notices this commitment has earned as of `today`, ignoring what has
 * already been sent.
 *
 * Pairing this with the unique index on (commitment_id, notice_kind, due_on)
 * is the whole anti-repetition design: this function is free to say "ahead"
 * every day for the thirty days a SOAT sits in its window, because the claim
 * only succeeds once. Trying to make the function itself fire exactly once
 * would mean it had to know what day it fired on, which is a second source of
 * truth about the same thing.
 */
export function noticesOwed(input: {
  dueOn: string;
  noticeDays: number;
  escalateAfterDays: number;
  state: CommitmentState;
  today: string;
  /** Whether any notice for this occurrence has been marked seen by a person. */
  acknowledged: boolean;
}): NoticeKind[] {
  if (!isOpen(input.state)) return [];
  const left = daysUntilDue(input.dueOn, input.today);
  if (Number.isNaN(left)) return [];

  const owed: NoticeKind[] = [];
  if (left > 0 && left <= input.noticeDays) owed.push('ahead');
  if (left === 0) owed.push('due_today');
  if (left < 0) {
    owed.push('overdue');
    // Escalation is about ABSENCE of action, so somebody having acknowledged
    // the warning stops it. Going over the head of a person who already
    // answered is how an escalation path gets quietly disabled by the people
    // it embarrasses.
    if (-left >= input.escalateAfterDays && !input.acknowledged) owed.push('escalation');
  }
  return owed;
}

// ---------------------------------------------------------------------------
// Rows -> model- and screen-facing shapes
// ---------------------------------------------------------------------------

/**
 * The columns every commitments read selects. One constant so the row type,
 * the adapter and the queries cannot drift apart.
 *
 * The two embedded selects are what let a source be CITED rather than merely
 * referenced: a document id is not something a person can check, a document
 * title is.
 */
export const COMMITMENT_COLUMNS =
  'id, title, detail, kind, counterparty, amount_cop, due_on, notice_days, state, met_at, met_by, met_note, dropped_at, dropped_reason, owner_user_id, escalate_to_user_id, escalate_after_days, source_kind, source_system, source_read_at, source_user_id, source_document_id, source_chunk_id, source_quote, review_state, confirmed_at, confirmed_by, vehicle_id, recurrence, series_id, previous_commitment_id, calendar_event_id, calendar_id, calendar_user_id, calendar_synced_due_on, calendar_error, created_by, created_at, updated_at';

export interface CommitmentRow {
  id: string;
  title: string;
  detail: string | null;
  kind: CommitmentKind;
  counterparty: string | null;
  amount_cop: number | null;
  due_on: string;
  notice_days: number;
  state: CommitmentState;
  met_at: string | null;
  met_by: string | null;
  met_note: string | null;
  dropped_at: string | null;
  dropped_reason: string | null;
  owner_user_id: string | null;
  escalate_to_user_id: string | null;
  escalate_after_days: number;
  source_kind: SourceKind;
  source_system: string | null;
  source_read_at: string | null;
  source_user_id: string | null;
  source_document_id: string | null;
  source_chunk_id: string | null;
  source_quote: string | null;
  review_state: 'pending' | 'confirmed' | 'rejected';
  confirmed_at: string | null;
  confirmed_by: string | null;
  vehicle_id: string | null;
  recurrence: Recurrence;
  series_id: string;
  previous_commitment_id: string | null;
  calendar_event_id: string | null;
  calendar_id: string | null;
  calendar_user_id: string | null;
  calendar_synced_due_on: string | null;
  calendar_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Joined in by the callers that need to name the source, never stored. */
  source_document_title?: string | null;
  source_user_name?: string | null;
  owner_name?: string | null;
  vehicle_plate?: string | null;
}

export const commitmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  kind: z.enum(COMMITMENT_KINDS),
  kindLabel: z.string(),
  counterparty: z.string().nullable().describe('Client, supplier or authority this is with'),
  amountCop: z.number().nullable().describe('Amount owed in Colombian pesos, for payments'),
  dueOn: z.string().describe('Calendar date it falls due, YYYY-MM-DD, Colombian time'),
  daysLeft: z.number().describe('Whole days until it falls due; negative once it has passed'),
  state: z.enum(COMMITMENT_STATES),
  stateLabel: z.string(),
  noticeDays: z.number().describe('How many days before the date the first warning goes out'),
  owner: z.string().nullable().describe('Who answers for it'),
  vehiclePlate: z.string().nullable(),
  recurrence: z.enum(RECURRENCES),
  // The load-bearing field. Every date this tool reports comes with where it
  // came from, so the agent cites it instead of simply asserting it.
  source: sourceSchema,
});

export type Commitment = z.infer<typeof commitmentSchema>;

export function adaptCommitment(row: CommitmentRow, today: string): Commitment {
  const state = deriveState(row, today);
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    kind: row.kind,
    kindLabel: KIND_LABEL[row.kind] ?? KIND_LABEL.other,
    counterparty: row.counterparty,
    amountCop: row.amount_cop,
    dueOn: row.due_on,
    daysLeft: daysUntilDue(row.due_on, today),
    state,
    stateLabel: STATE_LABEL[state],
    noticeDays: row.notice_days,
    owner: row.owner_name ?? null,
    vehiclePlate: row.vehicle_plate ?? null,
    recurrence: row.recurrence,
    source: describeSource(row),
  };
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "en 4 días" / "hace 12 días" / "hoy" — how a person would say it. */
export function whenPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'hoy';
  if (daysLeft > 0) return `en ${plural(daysLeft, 'día')}`;
  return `hace ${plural(-daysLeft, 'día')}`;
}

export function cop(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CO')} COP`;
}

/**
 * One sentence naming where a date came from, for the agent to say out loud.
 *
 * The whole module exists so this sentence can be true, so it never says
 * anything softer than the evidence supports: a pending extraction is
 * announced as unconfirmed even though that makes the answer longer.
 */
export function sourceSentence(source: CommitmentSource): string {
  const when = source.readAt ? ` (${source.readAt.slice(0, 10)})` : '';
  switch (source.kind) {
    case 'system':
      return `Fecha leída de ${source.label}${when}.`;
    case 'document':
      return source.confirmed
        ? `Fecha tomada de ${source.label}: «${source.quote ?? ''}».`
        : `Fecha propuesta a partir de ${source.label} — «${source.quote ?? ''}» — y todavía sin confirmar, así que no se está vigilando.`;
    default:
      return `Fecha registrada por ${source.label}${when}.`;
  }
}
