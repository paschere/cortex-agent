import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '../commitments/store';
import type { ActionEscalationVia } from './escalation';
import {
  ACTION_COLUMNS,
  type ActionKind,
  type ActionOutcome,
  type ActionRow,
  type MessagePayload,
  type OriginKind,
  PROPOSAL_TTL_MS,
  fingerprint,
  messagePayloadSchema,
} from './shape';

/**
 * Every read and write of a proposed action, in one module.
 *
 * `db` is always a workspace-scoped handle. Nothing here filters by
 * organization_id by hand, and nothing here may be handed a raw client.
 *
 * THE ONE INVARIANT THIS MODULE OWNS. `tool_input` and `content_hash` are
 * written together or not at all. There are exactly two statements in this file
 * that write `tool_input` — `proposeAction` and `editContent` — and both
 * compute the fingerprint from the value they are about to store, in the same
 * expression. Everything else in the product reads. The database enforces the
 * same rule independently (see `actions_content_guard` in migration 0077), so a
 * third writer added elsewhere fails loudly rather than quietly detaching an
 * approval from its text.
 */

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

export interface ProposeActionInput {
  userId: string;
  agentId?: string | null;
  conversationId?: string | null;
  kind: ActionKind;
  /** The registry id that will run. Today always `gmail.send_message`. */
  toolId: string;
  payload: MessagePayload;
  originKind: OriginKind;
  originId?: string | null;
  rationale: string;
  clientId?: string | null;
  /** Defaults to PROPOSAL_TTL_MS from now. */
  expiresAt?: Date;
  now?: Date;
}

export type ProposeOutcome =
  | { outcome: 'proposed'; action: ActionRow }
  /**
   * An open proposal for the same thing already exists. Not an error: it is
   * the daily sweep meeting yesterday's unanswered proposal, which is the
   * normal case and must not produce a second one.
   */
  | { outcome: 'already_open'; action: ActionRow };

export async function proposeAction(
  db: SupabaseClient,
  input: ProposeActionInput,
): Promise<ProposeOutcome> {
  const payload = messagePayloadSchema.parse(input.payload);
  const now = input.now ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + PROPOSAL_TTL_MS);

  const row = {
    user_id: input.userId,
    agent_id: input.agentId ?? null,
    conversation_id: input.conversationId ?? null,
    kind: input.kind,
    tool_id: input.toolId,
    tool_input: payload,
    // Computed here, from the value on the line above. The two never travel
    // separately, and no caller may supply this.
    content_hash: fingerprint(payload),
    recipient: payload.to.join(', ').slice(0, 320),
    subject: payload.subject.slice(0, 300),
    origin_kind: input.originKind,
    origin_id: input.originId ?? null,
    rationale: input.rationale.slice(0, 600),
    client_id: input.clientId ?? null,
    state: 'proposed' as const,
    expires_at: expiresAt.toISOString(),
  };

  const { data, error } = await db.from('actions').insert(row).select(ACTION_COLUMNS).single();

  if (error) {
    // The partial unique index on (workspace, kind, origin) where state is
    // 'proposed'. The sweep writes and lets the index decide, exactly like
    // commitment notices — so it never has to remember what it did yesterday.
    if (isUniqueViolation(error) && input.originId) {
      const existing = await findOpenForOrigin(db, input.kind, input.originKind, input.originId);
      if (existing) return { outcome: 'already_open', action: existing };
    }
    throw error;
  }
  return { outcome: 'proposed', action: data as unknown as ActionRow };
}

export async function findOpenForOrigin(
  db: SupabaseClient,
  kind: ActionKind,
  originKind: OriginKind,
  originId: string,
): Promise<ActionRow | null> {
  const { data } = await db
    .from('actions')
    .select(ACTION_COLUMNS)
    .eq('kind', kind)
    .eq('origin_kind', originKind)
    .eq('origin_id', originId)
    .eq('state', 'proposed')
    .maybeSingle();
  return (data as unknown as ActionRow) ?? null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListActionsOptions {
  states?: Array<'proposed' | 'approved' | 'dismissed'>;
  userId?: string;
  kind?: ActionKind;
  outcome?: ActionOutcome;
  /** Only proposals that can still be approved, as of this moment. */
  approvableAt?: Date;
  limit?: number;
}

export async function listActions(
  db: SupabaseClient,
  opts: ListActionsOptions = {},
): Promise<ActionRow[]> {
  let q = db.from('actions').select(ACTION_COLUMNS);
  if (opts.states?.length === 1) q = q.eq('state', opts.states[0] as string);
  else if (opts.states?.length) q = q.in('state', opts.states);
  if (opts.userId) q = q.eq('user_id', opts.userId);
  if (opts.kind) q = q.eq('kind', opts.kind);
  if (opts.outcome) q = q.eq('outcome', opts.outcome);
  if (opts.approvableAt) q = q.gt('expires_at', opts.approvableAt.toISOString());

  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) throw error;
  return (data ?? []) as unknown as ActionRow[];
}

export async function getAction(db: SupabaseClient, id: string): Promise<ActionRow | null> {
  const { data, error } = await db
    .from('actions')
    .select(ACTION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ActionRow) ?? null;
}

/**
 * Names, not ids — the same reasoning as commitments/store.ts. A draft that
 * says "recordatorio para 7f3c-…" cannot be read; one that says "recordatorio
 * para Ana Gómez" can.
 */
export async function hydrateOwners(db: SupabaseClient, rows: ActionRow[]): Promise<ActionRow[]> {
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  if (ids.length === 0) return rows;
  const { data } = await db.from('users').select('id, name, email').in('id', ids);
  const byId = new Map(
    ((data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
      u.id,
      u.name?.trim() || u.email,
    ]),
  );
  return rows.map((r) => ({ ...r, owner_name: byId.get(r.user_id) ?? null }));
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export interface EditContentInput {
  id: string;
  userId: string;
  /** The fingerprint of the text the editor was looking at. */
  expectedHash: string;
  /** What they changed. Anything absent keeps its current value. */
  patch: Partial<Pick<MessagePayload, 'to' | 'cc' | 'subject' | 'body'>>;
  now?: Date;
}

export type EditOutcome =
  | { outcome: 'edited'; action: ActionRow }
  /** Somebody else changed it first, or it was decided while being edited. */
  | { outcome: 'stale' }
  | { outcome: 'unchanged'; action: ActionRow };

/**
 * Rewrite the draft, and keep the receipt.
 *
 * Two properties, both load-bearing:
 *
 *   The edit is CONDITIONAL on the text that was edited. `expectedHash` sits in
 *   the WHERE clause, so two people editing the same draft in two tabs do not
 *   silently overwrite each other — the second one is told the text moved. It
 *   is the same guard the approval uses, for the same reason.
 *
 *   The edit is RECORDED. Who rewrote what before it went out is the most
 *   useful thing this feature produces: a draft that four people out of five
 *   rewrite the same way is a template that is wrong, and there is no way to
 *   ever learn that without keeping both sides.
 */
export async function editContent(
  db: SupabaseClient,
  input: EditContentInput,
): Promise<EditOutcome> {
  const current = await getAction(db, input.id);
  if (!current) throw new NotFoundError('Esa acción ya no existe.');
  if (current.content_hash !== input.expectedHash || current.state !== 'proposed') {
    return { outcome: 'stale' };
  }

  const next = messagePayloadSchema.parse({
    ...current.tool_input,
    ...(input.patch.to ? { to: input.patch.to } : {}),
    ...(input.patch.cc ? { cc: input.patch.cc } : {}),
    ...(input.patch.subject !== undefined ? { subject: input.patch.subject } : {}),
    ...(input.patch.body !== undefined ? { body: input.patch.body } : {}),
  });
  const nextHash = fingerprint(next);
  // A no-op edit must not write a revision: `action_revisions_actually_changed`
  // rejects one, and a list of "edits" that includes opening the box and
  // closing it again is a list nobody reads.
  if (nextHash === current.content_hash) return { outcome: 'unchanged', action: current };

  // Snapshot the old side BEFORE the update, by value.
  //
  // The revision is the record of what the text used to be, so it may not be a
  // reference to anything the update can still reach. Holding one is how a
  // "history" quietly ends up showing the new text on both sides of every edit
  // — which is worse than having no history at all, because it looks like one.
  const beforeHash = current.content_hash;
  const beforeInput = JSON.parse(JSON.stringify(current.tool_input)) as MessagePayload;

  const now = (input.now ?? new Date()).toISOString();
  const { data, error } = await db
    .from('actions')
    .update({
      tool_input: next,
      content_hash: nextHash,
      recipient: next.to.join(', ').slice(0, 320),
      subject: next.subject.slice(0, 300),
      edited_count: current.edited_count + 1,
      updated_at: now,
    })
    .eq('id', input.id)
    // The guard. Everything above is derived from the row we read; this is what
    // makes writing it safe.
    .eq('content_hash', input.expectedHash)
    .eq('state', 'proposed')
    .select(ACTION_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { outcome: 'stale' };

  await db.from('action_revisions').insert({
    action_id: input.id,
    edited_by: input.userId,
    edited_at: now,
    from_hash: beforeHash,
    to_hash: nextHash,
    before_input: beforeInput,
    after_input: next,
  });

  return { outcome: 'edited', action: data as unknown as ActionRow };
}

export interface RevisionRow {
  id: string;
  action_id: string;
  edited_by: string | null;
  edited_at: string;
  from_hash: string;
  to_hash: string;
  before_input: MessagePayload;
  after_input: MessagePayload;
}

export async function listRevisions(db: SupabaseClient, actionId: string): Promise<RevisionRow[]> {
  const { data } = await db
    .from('action_revisions')
    .select('id, action_id, edited_by, edited_at, from_hash, to_hash, before_input, after_input')
    .eq('action_id', actionId)
    .order('edited_at', { ascending: true });
  return (data ?? []) as unknown as RevisionRow[];
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface ClaimActionInput {
  id: string;
  userId: string;
  decision: 'approved' | 'dismissed';
  via: 'web' | 'chat' | 'mcp';
  /**
   * The fingerprint of the text the approver was shown. Required for an
   * approval; ignored for a dismissal, since dismissing text you have not read
   * is always safe and refusing to let somebody clear a stale card would be
   * hostile.
   */
  contentHash?: string;
  reason?: string;
  now: Date;
}

/**
 * Take the decision, and hand back the payload in the same breath.
 *
 * THIS IS THE STATEMENT THE WHOLE FEATURE RESTS ON. Every guard is in the WHERE
 * clause, and the payload that comes back is the payload that satisfied it:
 *
 *   id            it is this action
 *   user_id       the person deciding owns it
 *   state         it has not already been decided — so two clicks send once
 *   expires_at    the proposal has not gone stale
 *   content_hash  the text is the text they read
 *
 * A read-then-write version of this passes every test built on a Map and still
 * sends twice under two concurrent clicks, because both reads see a row in
 * 'proposed'. Here the loser matches zero rows and is told the truth. Same
 * lesson, same shape as lib/approvals/claim.ts, which this deliberately mirrors
 * so that the approval semantics of this product are one design and not two.
 */
export async function claimAction(
  db: SupabaseClient,
  input: ClaimActionInput,
): Promise<ActionRow | null> {
  const nowIso = input.now.toISOString();
  let q = db
    .from('actions')
    .update({
      state: input.decision,
      decided_at: nowIso,
      decided_by: input.userId,
      decided_via: input.via,
      ...(input.decision === 'dismissed' && input.reason
        ? { dismissed_reason: input.reason.slice(0, 400) }
        : {}),
      updated_at: nowIso,
    })
    .eq('id', input.id)
    .eq('user_id', input.userId)
    .eq('state', 'proposed')
    .gt('expires_at', nowIso);

  if (input.decision === 'approved') {
    if (!input.contentHash) {
      throw new ValidationError(
        'Approving an action requires the fingerprint of the content that was shown.',
      );
    }
    q = q.eq('content_hash', input.contentHash);
  }

  const { data, error } = await q.select(ACTION_COLUMNS).maybeSingle();
  if (error || !data) return null;
  return data as unknown as ActionRow;
}

/** Read by id ALONE, for explaining a refused claim. Never authorises anything. */
export async function peekAction(
  db: SupabaseClient,
  id: string,
): Promise<Pick<
  ActionRow,
  | 'id'
  | 'user_id'
  | 'tool_id'
  | 'expires_at'
  | 'state'
  | 'decided_at'
  | 'decided_via'
  | 'content_hash'
> | null> {
  const { data } = await db
    .from('actions')
    .select('id, user_id, tool_id, expires_at, state, decided_at, decided_via, content_hash')
    .eq('id', id)
    .maybeSingle();
  return (data as never) ?? null;
}

// ---------------------------------------------------------------------------
// Execution and what came after
// ---------------------------------------------------------------------------

export interface RecordExecutionInput {
  id: string;
  status: 'ok' | 'failed' | 'blocked';
  result?: unknown;
  error?: string | null;
  /** The Gmail thread the send landed in — what the follow-up sweep watches. */
  threadId?: string | null;
  now?: Date;
}

/**
 * Write down what happened when it ran.
 *
 * A failure does NOT return the action to 'proposed'. Retrying a write that may
 * already have half-happened is how "it may or may not have gone out" becomes
 * the answer, and that is worse than "it didn't — ask me again". Same posture
 * as lib/approvals/decide.ts.
 */
export async function recordExecution(
  db: SupabaseClient,
  input: RecordExecutionInput,
): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  const { error } = await db
    .from('actions')
    .update({
      executed_at: now,
      execution_status: input.status,
      execution_error: input.error ? input.error.slice(0, 2000) : null,
      execution_result: input.status === 'ok' ? (input.result ?? null) : null,
      thread_id: input.threadId ?? null,
      // Only a send that actually left starts waiting for an answer.
      outcome: input.status === 'ok' ? 'awaiting' : 'none',
      updated_at: now,
    })
    .eq('id', input.id)
    .eq('state', 'approved');
  if (error) throw error;
}

export async function recordOutcome(
  db: SupabaseClient,
  input: { id: string; outcome: ActionOutcome; note?: string | null; now?: Date },
): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  await db
    .from('actions')
    .update({
      outcome: input.outcome,
      outcome_at: now,
      outcome_note: input.note ? input.note.slice(0, 1000) : null,
      updated_at: now,
    })
    .eq('id', input.id)
    // Only ever moves an action ON from waiting. A closed loop does not reopen
    // because a sweep ran again.
    .eq('outcome', 'awaiting');
}

// ---------------------------------------------------------------------------
// El escalado
// ---------------------------------------------------------------------------

export interface MarkEscalatedInput {
  id: string;
  /** A quién se le avisó. NO pasa a poder aprobar: ver el comentario de abajo. */
  toUserId: string;
  via: ActionEscalationVia;
  now?: Date;
}

/**
 * Dejar constancia de que este escalado ya salió, y que no salga otra vez.
 *
 * EL `is('escalated_at', null)` ES LA MITAD DE ESTA FUNCIÓN. Un barrido no corre
 * una vez: Inngest reintenta pasos, un despliegue reinicia uno a la mitad, y dos
 * corridas simultáneas del mismo espacio son un martes normal. La versión
 * leer-y-luego-escribir pasa todas las pruebas que se hagan sobre un Map y
 * manda dos correos idénticos al mismo jefe en cuanto haya concurrencia de
 * verdad, porque las dos lecturas ven `escalated_at` nulo. Aquí la que pierde no
 * casa con ninguna fila y devuelve `false`, y quien llama no manda nada.
 *
 * Por eso el aviso se manda ANTES de llamar aquí, no después: si el correo falla,
 * la fila se queda sin marcar y mañana se vuelve a intentar. Un rastro que dice
 * «escalado» sin que nadie haya recibido nada es la única forma de que este
 * módulo mienta, y es peor que un día de retraso.
 *
 * `user_id` NO SE TOCA, ni aquí ni en ninguna parte. Aprobar sigue siendo
 * exclusivo del dueño porque el correo sale de su Gmail firmado con su nombre
 * (ver `actions.user_id` en la migración 0077). Esto es un aviso, no un traspaso.
 */
export async function markEscalated(
  db: SupabaseClient,
  input: MarkEscalatedInput,
): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const { data, error } = await db
    .from('actions')
    .update({
      escalated_at: now,
      escalated_to: input.toUserId,
      escalated_via: input.via,
      updated_at: now,
    })
    .eq('id', input.id)
    // Sigue esperando de verdad: una aprobada o descartada entre que se leyó la
    // cola y se mandó el aviso ya no necesita que nadie se entere.
    .eq('state', 'proposed')
    .is('escalated_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
