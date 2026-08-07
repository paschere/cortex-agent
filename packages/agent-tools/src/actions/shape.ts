import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The pure core of proposed actions: the vocabulary, the fingerprint, and the
 * two checks that stand between an approval and an execution.
 *
 * Everything here is a function of its arguments — no database, no clock beyond
 * the `now` it is handed, no model. That is deliberate. The single most
 * important property of this whole feature ("what runs is what was approved")
 * reduces to two small functions in this file, and they are only trustworthy if
 * they can be tested without a Postgres, a Gmail and a session.
 */

// ---------------------------------------------------------------------------
// What kind of thing this is
// ---------------------------------------------------------------------------

/**
 * Three kinds, chosen rather than enumerated.
 *
 * Each one is a message somebody at a postal and customs operator writes by
 * hand today, from information Cortex already holds:
 *
 *   collect_payment  A cobro to a client whose invoice lapsed. The headline
 *                    case: Cortex knows the amount, the date and how late it
 *                    is, and today a person retypes all three into an email.
 *   remind_owner     A deadline handed back to whoever answers for it — a
 *                    SOAT, a tecnomecánica, a customs window, a lapsed
 *                    receivable. Internal, and the only kind the unattended
 *                    sweep drafts on its own, because the recipient is a
 *                    colleague whose address we hold rather than a client
 *                    contact we would have to guess at.
 *   reply_to_client  An answer to a client email that is still unanswered.
 *
 * A fourth requires a migration, on purpose. A catalogue of proposals nobody
 * approves is worse than three that get used every day.
 */
export const ACTION_KINDS = ['collect_payment', 'remind_owner', 'reply_to_client'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** What the screen calls each one. Spanish (Colombia), sentence case. */
export const KIND_LABEL: Record<ActionKind, string> = {
  collect_payment: 'Cobro de cartera',
  remind_owner: 'Recordatorio de vencimiento',
  reply_to_client: 'Respuesta a un cliente',
};

/**
 * Who ends up reading it. This is the distinction that decides the register of
 * the text — a client is addressed as *usted*, a colleague as *tú* — and it is
 * also what the screen warns about before an external send.
 */
export const KIND_AUDIENCE: Record<ActionKind, 'client' | 'internal'> = {
  collect_payment: 'client',
  remind_owner: 'internal',
  reply_to_client: 'client',
};

export const ACTION_STATES = ['proposed', 'approved', 'dismissed'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const STATE_LABEL: Record<ActionState, string> = {
  proposed: 'Propuesta',
  approved: 'Aprobada',
  dismissed: 'Descartada',
};

export const ORIGIN_KINDS = ['commitment', 'email_thread', 'manual'] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** What happened after it ran. See the column comment in migration 0077. */
export const ACTION_OUTCOMES = ['none', 'awaiting', 'replied', 'resolved', 'no_reply'] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<ActionOutcome, string> = {
  none: 'Sin enviar',
  awaiting: 'Esperando respuesta',
  replied: 'Respondieron',
  resolved: 'Resuelto',
  no_reply: 'Sin respuesta',
};

/** The three colours the design system already uses for exactly this. */
export const OUTCOME_TONE: Record<ActionOutcome, 'emerald' | 'amber' | 'rose' | 'ink'> = {
  none: 'ink',
  awaiting: 'amber',
  replied: 'emerald',
  resolved: 'emerald',
  // Not rose-as-error: nobody failed. It is a fact worth acting on, which is
  // what amber means everywhere else in this product.
  no_reply: 'amber',
};

/**
 * How long a proposal stays approvable.
 *
 * Seven days, and the number is doing real work in both directions. Long
 * enough that a proposal made on Friday afternoon survives the weekend and the
 * Monday backlog. Short enough that the figures in the body are still true: a
 * cobro whose first line says "lleva 47 días" is a correct sentence for about
 * a week and a lie after that, and the honest repair is a fresh draft with
 * fresh numbers rather than an old one somebody finally got round to.
 *
 * Expiry only ever REVOKES the ability to approve. Nothing in this module
 * executes on a timer. See migration 0077's header.
 */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * How long an executed action waits for an answer before silence itself
 * becomes the finding.
 *
 * Ten calendar days: long enough that a client who is simply slow is not filed
 * as ignoring you, short enough that a cobro nobody ever answered surfaces
 * while the invoice can still be chased.
 */
export const FOLLOW_UP_WINDOW_MS = 10 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

/**
 * A JSON encoding in which the same value always produces the same bytes.
 *
 * `JSON.stringify` does not have that property in the way this needs: object
 * key order follows insertion order, so `{to, subject, body}` and
 * `{subject, to, body}` — the same payload, round-tripped through two different
 * code paths — serialize differently and would fingerprint differently. That
 * would produce the worst possible failure of this feature: an approval refused
 * because the text "changed" when nothing changed, teaching people the warning
 * is noise, on the one screen where it must never be.
 *
 * So keys are sorted, recursively. Arrays are NOT sorted — order is meaning in
 * a recipient list. `undefined` members are dropped exactly as JSON.stringify
 * drops them, so a payload that survived a JSON round trip fingerprints the
 * same as the one that went in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * The fingerprint of what will run.
 *
 * This value is rendered with the draft, travels back with the approval, and
 * sits in the WHERE clause of the statement that approves it. Everything the
 * person read is inside it; nothing else is.
 */
export function fingerprint(toolInput: unknown): string {
  return createHash('sha256').update(canonicalJson(toolInput), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * The message an action sends. This IS the payload of `gmail.send_message`,
 * declared here as well so the drafting side and the executing side cannot
 * drift: an action whose content does not satisfy this never becomes a row.
 *
 * There is no draft id, no reference to something stored in Gmail, no template
 * plus parameters. The literal text is the payload, which is what makes "what
 * ran is what was approved" a property of the data rather than a promise about
 * the code between here and Google.
 */
export const messagePayloadSchema = z.object({
  to: z.array(z.string().email()).min(1).max(10).describe('Recipients, in order'),
  cc: z.array(z.string().email()).max(10).optional(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000).describe('The message, as plain text, exactly as it will be sent'),
  threadId: z
    .string()
    .optional()
    .describe('Gmail thread to reply inside, when this answers an existing conversation'),
});

export type MessagePayload = z.infer<typeof messagePayloadSchema>;

// ---------------------------------------------------------------------------
// The two checks
// ---------------------------------------------------------------------------

export class ActionIntegrityError extends Error {
  constructor(
    message: string,
    /** Safe to show a person: it says what happened and what to do. */
    public readonly spanish: string,
  ) {
    super(message);
    this.name = 'ActionIntegrityError';
  }
}

/**
 * The last gate before `runTool`, and the reason this feature can be trusted.
 *
 * By the time this runs the row has already been claimed by a conditional
 * UPDATE that had the approver's hash in its WHERE clause, so in the ordinary
 * case every assertion here passes. That is the point: this is the check that
 * only ever fires when something is wrong that should be impossible — a hash
 * and a payload that disagree, an execution attempted on a row nobody approved,
 * a second execution of the same approval.
 *
 * Impossible things are exactly what a system sending email on somebody's
 * behalf should refuse loudly rather than assume away. Each of the three has a
 * cheaper "just trust the claim" version, and each of those versions is how a
 * message goes out that nobody agreed to.
 */
export function assertExecutable(
  row: Pick<ActionRow, 'id' | 'state' | 'tool_input' | 'content_hash' | 'executed_at'>,
  approvedHash: string,
): void {
  if (row.state !== 'approved') {
    throw new ActionIntegrityError(
      `action ${row.id} is ${row.state}, not approved`,
      'Esa acción no está aprobada, así que no se ejecutó nada.',
    );
  }
  if (row.executed_at) {
    throw new ActionIntegrityError(
      `action ${row.id} already ran at ${row.executed_at}`,
      'Esa acción ya se había enviado. No se envió una segunda vez.',
    );
  }
  // The row's own consistency: does its stored fingerprint describe its stored
  // content? The database trigger keeps these together for every writer, so a
  // failure here means the trigger was bypassed or the hash was forged.
  const actual = fingerprint(row.tool_input);
  if (actual !== row.content_hash) {
    throw new ActionIntegrityError(
      `action ${row.id} fingerprint mismatch: stored ${row.content_hash}, computed ${actual}`,
      'El contenido de esa acción no coincide con su sello. No se envió nada; vuelve a proponerla.',
    );
  }
  // And the approver's consistency: is this the text they read?
  if (approvedHash !== row.content_hash) {
    throw new ActionIntegrityError(
      `action ${row.id} was approved against ${approvedHash} but holds ${row.content_hash}`,
      'El texto cambió después de que lo aprobaste, así que no se envió. Revísalo y apruébalo de nuevo.',
    );
  }
}

/**
 * Whether a proposal can still be approved, as of `now`.
 *
 * Separate from `assertExecutable` because it answers a different question at a
 * different moment — "should this still be on screen" rather than "may this
 * run" — and because the screen needs it without wanting an exception.
 */
export function isApprovable(
  row: Pick<ActionRow, 'state' | 'expires_at'>,
  now: Date = new Date(),
): boolean {
  return row.state === 'proposed' && Date.parse(row.expires_at) > now.getTime();
}

// ---------------------------------------------------------------------------
// Rows -> model- and screen-facing shapes
// ---------------------------------------------------------------------------

/** Every column an actions read selects. One constant, so nothing drifts. */
export const ACTION_COLUMNS =
  'id, user_id, agent_id, conversation_id, kind, tool_id, tool_input, content_hash, recipient, subject, origin_kind, origin_id, rationale, client_id, state, expires_at, decided_at, decided_by, decided_via, dismissed_reason, executed_at, execution_status, execution_error, execution_result, thread_id, outcome, outcome_at, outcome_note, edited_count, created_at, updated_at';

export interface ActionRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  kind: ActionKind;
  tool_id: string;
  tool_input: MessagePayload;
  content_hash: string;
  recipient: string;
  subject: string;
  origin_kind: OriginKind;
  origin_id: string | null;
  rationale: string;
  client_id: string | null;
  state: ActionState;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_via: string | null;
  dismissed_reason: string | null;
  executed_at: string | null;
  execution_status: 'ok' | 'failed' | 'blocked' | null;
  execution_error: string | null;
  execution_result: unknown;
  thread_id: string | null;
  outcome: ActionOutcome;
  outcome_at: string | null;
  outcome_note: string | null;
  edited_count: number;
  created_at: string;
  updated_at: string;
  /** Joined in by callers that need to name a person, never stored. */
  owner_name?: string | null;
}

/**
 * What a tool returns and what the cards render.
 *
 * The body is included in full and on purpose. A summary here would mean the
 * chat card shows one thing and the executed payload contains another, which
 * is the entire failure this feature is built to prevent — so the card renders
 * `tool_input`, and `contentHash` travels beside it so the button can prove
 * which text it is agreeing to.
 */
export const actionSchema = z.object({
  id: z.string(),
  kind: z.enum(ACTION_KINDS),
  kindLabel: z.string(),
  audience: z.enum(['client', 'internal']),
  state: z.enum(ACTION_STATES),
  stateLabel: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  body: z.string().describe('The message exactly as it will be sent, if approved'),
  /** The fingerprint of the payload. Required to approve it. */
  contentHash: z.string(),
  rationale: z.string().describe('The fact this was derived from, in one sentence'),
  originKind: z.enum(ORIGIN_KINDS),
  originId: z.string().nullable(),
  expiresAt: z.string(),
  editedCount: z.number(),
  outcome: z.enum(ACTION_OUTCOMES),
  outcomeLabel: z.string(),
  outcomeNote: z.string().nullable(),
  executedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type Action = z.infer<typeof actionSchema>;

export function adaptAction(row: ActionRow): Action {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: KIND_LABEL[row.kind] ?? row.kind,
    audience: KIND_AUDIENCE[row.kind] ?? 'internal',
    state: row.state,
    stateLabel: STATE_LABEL[row.state] ?? row.state,
    to: row.tool_input?.to ?? [],
    cc: row.tool_input?.cc ?? [],
    subject: row.tool_input?.subject ?? row.subject,
    body: row.tool_input?.body ?? '',
    contentHash: row.content_hash,
    rationale: row.rationale,
    originKind: row.origin_kind,
    originId: row.origin_id,
    expiresAt: row.expires_at,
    editedCount: row.edited_count,
    outcome: row.outcome,
    outcomeLabel: OUTCOME_LABEL[row.outcome] ?? row.outcome,
    outcomeNote: row.outcome_note,
    executedAt: row.executed_at,
    createdAt: row.created_at,
  };
}

/**
 * The one-line summary of an action, for a notification or a list.
 *
 * Names the recipient, because "an action is waiting" is not information and
 * "un cobro a Coltrans está esperando" is.
 */
export function actionHeadline(row: Pick<ActionRow, 'kind' | 'recipient'>): string {
  return `${KIND_LABEL[row.kind] ?? row.kind} a ${row.recipient}`;
}
