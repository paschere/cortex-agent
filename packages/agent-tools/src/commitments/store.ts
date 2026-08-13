import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
// Imported from the leaf module rather than the package barrel: this file is
// reached from the barrel itself, and a round trip through it would be a cycle.
import { recordSignal } from '../learning/store';
import {
  COMMITMENT_COLUMNS,
  type CommitmentKind,
  type CommitmentRow,
  DEFAULT_NOTICE_DAYS,
  MissingSourceError,
  type NoticeKind,
  type Recurrence,
  type SourceInput,
  bogotaToday,
  deriveState,
  nextDueOn,
  sourceColumns,
} from './shape';

/**
 * Every read and write of a commitment, in one module.
 *
 * The tools, the daily watcher and the web screen all go through here, which
 * is what keeps the two rules that matter from having three implementations:
 * a row cannot be written without a source, and an extracted row cannot be
 * confirmed without a human. Both are enforced in the database too (migration
 * 0069); this layer exists so the refusal is a sentence rather than a
 * constraint violation, and so the surrounding bookkeeping — recurrence,
 * cached state, notice claims — happens the same way from every caller.
 *
 * `db` is always a workspace-scoped handle. Nothing here filters by
 * organization_id by hand, and nothing here should ever be handed a raw client.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Only these states, computed from the date rather than read off the row. */
  states?: Array<'in_force' | 'due_soon' | 'overdue' | 'met' | 'dropped'>;
  /** 'confirmed' for the watched set, 'pending' for the review inbox. */
  reviewState?: 'pending' | 'confirmed' | 'rejected';
  kind?: CommitmentKind;
  /**
   * Kinds to leave out. Exists for one caller and one reason: the expiries
   * report counts deadlines owed to third parties, and an internal promise
   * between two colleagues is not one. Without this, «Ana quedó de mandar el
   * informe» would inflate the number somebody reads as "papers about to
   * expire" — a figure that has to stay comparable month to month.
   */
  excludeKinds?: CommitmentKind[];
  ownerUserId?: string;
  /** Everything falling due on or before this date. */
  dueBefore?: string;
  vehicleId?: string;
  limit?: number;
  today?: string;
}

/**
 * Names, not ids.
 *
 * A source is only citable if it can be said out loud, and "documento
 * 8f3c-…-a1" cannot. Three small lookups rather than PostgREST embeds: the
 * embeds would work, but they route the join through a table the scoped client
 * cannot pin (kb_documents is scoped, kb_chunks is derived), and three
 * `.in()` queries are both cheaper to reason about and honest about which
 * tenant filter applies to each.
 */
export async function hydrate(db: SupabaseClient, rows: CommitmentRow[]): Promise<CommitmentRow[]> {
  if (rows.length === 0) return rows;

  const docIds = [...new Set(rows.map((r) => r.source_document_id).filter(Boolean))] as string[];
  const userIds = [
    ...new Set(
      rows.flatMap((r) => [r.owner_user_id, r.source_user_id]).filter(Boolean) as string[],
    ),
  ];
  const vehicleIds = [...new Set(rows.map((r) => r.vehicle_id).filter(Boolean))] as string[];

  const [docs, users, vehicles] = await Promise.all([
    docIds.length
      ? db.from('kb_documents').select('id, title').in('id', docIds)
      : Promise.resolve({ data: [] }),
    userIds.length
      ? db.from('users').select('id, name, email').in('id', userIds)
      : Promise.resolve({ data: [] }),
    vehicleIds.length
      ? db.from('vehicles').select('id, plate').in('id', vehicleIds)
      : Promise.resolve({ data: [] }),
  ]);

  const docTitle = new Map(
    ((docs.data ?? []) as Array<{ id: string; title: string }>).map((d) => [d.id, d.title]),
  );
  const userName = new Map(
    ((users.data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
      u.id,
      u.name?.trim() || u.email,
    ]),
  );
  const plate = new Map(
    ((vehicles.data ?? []) as Array<{ id: string; plate: string }>).map((v) => [v.id, v.plate]),
  );

  return rows.map((r) => ({
    ...r,
    source_document_title: r.source_document_id
      ? (docTitle.get(r.source_document_id) ?? null)
      : null,
    source_user_name: r.source_user_id ? (userName.get(r.source_user_id) ?? null) : null,
    owner_name: r.owner_user_id ? (userName.get(r.owner_user_id) ?? null) : null,
    vehicle_plate: r.vehicle_id ? (plate.get(r.vehicle_id) ?? null) : null,
  }));
}

export async function listCommitments(
  db: SupabaseClient,
  opts: ListOptions = {},
): Promise<CommitmentRow[]> {
  const today = opts.today ?? bogotaToday();
  let q = db.from('commitments').select(COMMITMENT_COLUMNS);

  // review_state defaults to 'confirmed' for every caller that does not ask
  // otherwise. The pending ones are proposals; they belong in the review
  // inbox and nowhere else, and a caller that forgets to filter would put an
  // unverified date in front of somebody as though it were a fact.
  q = q.eq('review_state', opts.reviewState ?? 'confirmed');

  if (opts.kind) q = q.eq('kind', opts.kind);
  if (opts.excludeKinds?.length) {
    q = q.not('kind', 'in', `(${opts.excludeKinds.join(',')})`);
  }
  if (opts.ownerUserId) q = q.eq('owner_user_id', opts.ownerUserId);
  if (opts.vehicleId) q = q.eq('vehicle_id', opts.vehicleId);
  if (opts.dueBefore) q = q.lte('due_on', opts.dueBefore);

  const { data, error } = await q.order('due_on', { ascending: true }).limit(opts.limit ?? 500);
  if (error) throw error;

  let rows = (data ?? []) as CommitmentRow[];
  // States are filtered here rather than in SQL because the stored column is a
  // cache the watcher refreshes overnight; between runs, the date is the truth.
  if (opts.states?.length) {
    const wanted = new Set(opts.states);
    rows = rows.filter((r) => wanted.has(deriveState(r, today)));
  }
  return hydrate(db, rows);
}

export async function getCommitment(db: SupabaseClient, id: string): Promise<CommitmentRow | null> {
  const { data, error } = await db
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [row] = await hydrate(db, [data as CommitmentRow]);
  return row ?? null;
}

/** Every occurrence of the same standing obligation, oldest first. */
export async function listSeries(db: SupabaseClient, seriesId: string): Promise<CommitmentRow[]> {
  const { data, error } = await db
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('series_id', seriesId)
    .order('due_on', { ascending: true });
  if (error) throw error;
  return hydrate(db, (data ?? []) as CommitmentRow[]);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface CreateCommitmentInput {
  title: string;
  detail?: string | null;
  kind: CommitmentKind;
  dueOn: string;
  /** Defaults to the sensible window for the kind — a month for a SOAT, three days for a payment. */
  noticeDays?: number | null;
  counterparty?: string | null;
  amountCop?: number | null;
  ownerUserId?: string | null;
  escalateToUserId?: string | null;
  escalateAfterDays?: number | null;
  vehicleId?: string | null;
  recurrence?: Recurrence;
  /** MANDATORY. There is no overload of this function without it. */
  source: SourceInput;
  createdBy: string;
  seriesId?: string;
  previousCommitmentId?: string | null;
}

/**
 * Create a commitment.
 *
 * `source` is a required argument of a required parameter object — not an
 * optional field with a default — because the one thing that must never happen
 * in this module is a row appearing with a plausible date and no way to check
 * it. Callers that cannot name a source cannot call this function.
 */
export async function createCommitment(
  db: SupabaseClient,
  input: CreateCommitmentInput,
): Promise<CommitmentRow> {
  if (!input.title?.trim()) throw new ValidationError('A commitment needs a title');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) {
    throw new ValidationError(`due date must be YYYY-MM-DD, got "${input.dueOn}"`);
  }
  // Throws MissingSourceError with an explanation when the source is incomplete.
  const source = sourceColumns(input.source);

  // A date READ FROM A SYSTEM must never be rolled forward by us: the next one
  // is whatever the registry says after the renewal. Silently coercing here
  // rather than rejecting, because the caller asking for a yearly SOAT is not
  // wrong about the world — only about who produces the next date.
  const recurrence: Recurrence =
    source.source_kind === 'system' && (input.recurrence ?? 'none') !== 'none'
      ? 'from_source'
      : (input.recurrence ?? 'none');

  const row: Record<string, unknown> = {
    title: input.title.trim(),
    detail: input.detail?.trim() || null,
    kind: input.kind,
    due_on: input.dueOn,
    notice_days: input.noticeDays ?? DEFAULT_NOTICE_DAYS[input.kind] ?? DEFAULT_NOTICE_DAYS.other,
    counterparty: input.counterparty?.trim() || null,
    amount_cop: input.amountCop ?? null,
    owner_user_id: input.ownerUserId ?? null,
    escalate_to_user_id: input.escalateToUserId ?? null,
    vehicle_id: input.vehicleId ?? null,
    recurrence,
    created_by: input.createdBy,
    previous_commitment_id: input.previousCommitmentId ?? null,
    ...source,
  };
  if (input.escalateAfterDays != null) row.escalate_after_days = input.escalateAfterDays;
  if (input.seriesId) row.series_id = input.seriesId;
  // The cache column, correct at birth.
  row.state = deriveState(
    { due_on: input.dueOn, notice_days: row.notice_days as number },
    bogotaToday(),
  );

  const { data, error } = await db
    .from('commitments')
    .insert(row)
    .select(COMMITMENT_COLUMNS)
    .single();
  if (error) throw error;
  return data as CommitmentRow;
}

export interface MarkMetResult {
  commitment: CommitmentRow;
  /** The next occurrence, when the recurrence is one a person stated. */
  successor: CommitmentRow | null;
  /** Set when there is a next occurrence but Cortex must not invent its date. */
  successorDeferred: string | null;
  alreadyMet: boolean;
}

/**
 * Mark a commitment fulfilled, and roll the series forward if — and only if —
 * rolling it forward repeats something a person said rather than guessing.
 *
 * The old row is never mutated beyond its own outcome. History matters here in
 * a concrete way: "when did we last renew the SOAT on WGY482, and who said so"
 * is a question the fleet manager asks, and it is unanswerable in a schema
 * where fulfilment moves the date forward in place.
 */
export async function markMet(
  db: SupabaseClient,
  input: { id: string; userId: string; note?: string | null; today?: string },
): Promise<MarkMetResult> {
  const current = await getCommitment(db, input.id);
  if (!current) throw new NotFoundError('That commitment no longer exists.');
  if (current.state === 'met') {
    return { commitment: current, successor: null, successorDeferred: null, alreadyMet: true };
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('commitments')
    .update({
      state: 'met',
      met_at: now,
      met_by: input.userId,
      met_note: input.note?.trim() || null,
      updated_at: now,
    })
    .eq('id', input.id)
    .select(COMMITMENT_COLUMNS)
    .single();
  if (error) throw error;
  const commitment = data as CommitmentRow;

  const next = nextDueOn(commitment.due_on, commitment.recurrence);
  if (!next) {
    return {
      commitment,
      successor: null,
      successorDeferred:
        commitment.recurrence === 'from_source'
          ? `La próxima ${commitment.kind === 'soat' ? 'vigencia del SOAT' : 'fecha'} entra sola cuando ${commitment.source_system ?? 'el sistema'} la reporte. Cortex no la calcula.`
          : null,
      alreadyMet: false,
    };
  }

  // A system-read date has no cadence Cortex may apply, even if somebody set
  // one: the successor would claim to have been read from a registry that has
  // not been consulted. createCommitment coerces this at write time; this is
  // the second gate, for rows that predate the coercion.
  if (commitment.source_kind === 'system') {
    return {
      commitment,
      successor: null,
      successorDeferred: `La próxima fecha la reporta ${commitment.source_system ?? 'el sistema'}; no se calcula sumando un periodo.`,
      alreadyMet: false,
    };
  }

  const source: SourceInput =
    commitment.source_kind === 'document'
      ? {
          kind: 'document',
          documentId: commitment.source_document_id as string,
          chunkId: commitment.source_chunk_id,
          quote: commitment.source_quote as string,
        }
      : { kind: 'manual', userId: commitment.source_user_id ?? input.userId };

  try {
    const successor = await createCommitment(db, {
      title: commitment.title,
      detail: commitment.detail,
      kind: commitment.kind,
      dueOn: next,
      noticeDays: commitment.notice_days,
      counterparty: commitment.counterparty,
      amountCop: commitment.amount_cop,
      ownerUserId: commitment.owner_user_id,
      escalateToUserId: commitment.escalate_to_user_id,
      escalateAfterDays: commitment.escalate_after_days,
      vehicleId: commitment.vehicle_id,
      recurrence: commitment.recurrence,
      source,
      createdBy: input.userId,
      seriesId: commitment.series_id,
      previousCommitmentId: commitment.id,
    });
    return { commitment, successor, successorDeferred: null, alreadyMet: false };
  } catch (err) {
    // `commitments_successor_once_idx` rejects a second successor for the same
    // occurrence, which is how a retried job fails safely instead of forking
    // the series. Anything else is a real error.
    if (isUniqueViolation(err)) {
      return { commitment, successor: null, successorDeferred: null, alreadyMet: false };
    }
    throw err;
  }
}

export async function dropCommitment(
  db: SupabaseClient,
  input: { id: string; reason: string; userId: string },
): Promise<CommitmentRow> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('commitments')
    .update({
      state: 'dropped',
      dropped_at: now,
      dropped_reason: input.reason.trim().slice(0, 500) || 'Sin motivo registrado',
      updated_at: now,
    })
    .eq('id', input.id)
    .select(COMMITMENT_COLUMNS)
    .single();
  if (error) throw error;
  return data as CommitmentRow;
}

/**
 * A person vouches for an extracted date, and only then does it start being
 * watched.
 *
 * `confirmed_by` and `confirmed_at` are not bookkeeping — migration 0069 will
 * not accept a document-sourced row marked confirmed without them, so this
 * function is the only way an extraction can ever reach the watcher, and the
 * name of whoever vouched is on the row forever.
 */
export async function confirmExtracted(
  db: SupabaseClient,
  input: {
    id: string;
    userId: string;
    dueOn?: string;
    noticeDays?: number;
    /**
     * Supplied by the surfaces that have it, so this review can also be
     * recorded as evidence about the document the date was read out of
     * (migration 0083). Optional because it is not needed to confirm anything:
     * the learning row is a by-product and must never be a precondition.
     */
    organizationId?: string;
  },
): Promise<CommitmentRow> {
  const current = await getCommitment(db, input.id);
  if (!current) throw new NotFoundError('That commitment no longer exists.');
  if (current.review_state === 'confirmed') return current;
  if (current.review_state === 'rejected') {
    throw new ValidationError('That extraction was already rejected; register it by hand instead.');
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    review_state: 'confirmed',
    confirmed_at: now,
    confirmed_by: input.userId,
    updated_at: now,
  };
  // The reviewer may correct the date while confirming — that is the point of
  // a review step. The quote stays as it was, so a corrected date sits visibly
  // next to the sentence it was read from.
  if (input.dueOn) patch.due_on = input.dueOn;
  if (input.noticeDays != null) patch.notice_days = input.noticeDays;
  patch.state = deriveState(
    {
      due_on: (input.dueOn ?? current.due_on) as string,
      notice_days: input.noticeDays ?? current.notice_days,
    },
    bogotaToday(),
  );

  const { data, error } = await db
    .from('commitments')
    .update(patch)
    .eq('id', input.id)
    .select(COMMITMENT_COLUMNS)
    .single();
  if (error) throw error;

  // The gold signal, and the reason this hook is here rather than derived from
  // the row later: a corrected date is INVISIBLE afterwards. `due_on` is
  // overwritten in place and nothing keeps what the extractor originally read,
  // so "a human vouched for this unchanged" and "a human had to fix it" become
  // the same row the instant this update lands. The difference is only knowable
  // at this exact moment, so it is written down at this exact moment.
  //
  // Fire-and-forget inside `recordSignal`, which swallows everything: somebody
  // confirming a deadline must never be made to care that a learning row failed.
  if (input.organizationId && current.source_document_id) {
    const corrected = Boolean(input.dueOn) && input.dueOn !== current.due_on;
    await recordSignal(db, input.organizationId, {
      kind: corrected ? 'extraction_corrected' : 'extraction_confirmed',
      polarity: corrected ? -1 : 1,
      weight: 3,
      documentId: current.source_document_id,
      // The whole document, not a chunk: "we read this paper wrong" is a
      // statement about the paper, not about where the chunker cut it.
      chunkIndex: -1,
      actorUserId: input.userId,
      detail: {
        kind: corrected ? 'extraction_corrected' : 'extraction_confirmed',
        readAs: current.due_on,
        ...(corrected ? { correctedTo: input.dueOn } : {}),
        quote: current.source_quote,
        note: corrected
          ? 'Cortex leyó una fecha de este documento y alguien tuvo que corregirla a mano.'
          : 'Alguien revisó la fecha que Cortex leyó de este documento y la dio por buena.',
      },
      dedupeKey: `${corrected ? 'extraction_corrected' : 'extraction_confirmed'}:${input.id}`,
      observedAt: now,
    });
  }

  return data as CommitmentRow;
}

export async function rejectExtracted(
  db: SupabaseClient,
  input: { id: string; userId: string; reason?: string; organizationId?: string },
): Promise<CommitmentRow> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('commitments')
    .update({
      review_state: 'rejected',
      rejected_at: now,
      rejected_by: input.userId,
      state: 'dropped',
      dropped_at: now,
      dropped_reason: input.reason?.trim().slice(0, 500) || 'Rechazado en revisión',
      updated_at: now,
    })
    .eq('id', input.id)
    .select(COMMITMENT_COLUMNS)
    .single();
  if (error) throw error;

  // A thrown-out extraction is the bluntest possible statement that the reading
  // of this document was wrong. Read off the row that came back, so it is the
  // document the rejected commitment really named.
  const row = data as CommitmentRow;
  if (input.organizationId && row.source_document_id) {
    await recordSignal(db, input.organizationId, {
      kind: 'extraction_rejected',
      polarity: -1,
      weight: 3,
      documentId: row.source_document_id,
      chunkIndex: -1,
      actorUserId: input.userId,
      detail: {
        kind: 'extraction_rejected',
        readAs: row.due_on,
        quote: row.source_quote,
        reason: input.reason?.trim().slice(0, 200) ?? null,
        note: 'Alguien descartó por completo un vencimiento que Cortex leyó de este documento.',
      },
      dedupeKey: `extraction_rejected:${input.id}`,
      observedAt: now,
    });
  }

  return row;
}

/** Move a due date deliberately. Reopens the notices for the new date. */
export async function rescheduleCommitment(
  db: SupabaseClient,
  input: { id: string; dueOn: string; today?: string },
): Promise<CommitmentRow> {
  const current = await getCommitment(db, input.id);
  if (!current) throw new NotFoundError('That commitment no longer exists.');
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('commitments')
    .update({
      due_on: input.dueOn,
      state: deriveState(
        { due_on: input.dueOn, notice_days: current.notice_days },
        input.today ?? bogotaToday(),
      ),
      updated_at: now,
    })
    .eq('id', input.id)
    .select(COMMITMENT_COLUMNS)
    .single();
  if (error) throw error;
  return data as CommitmentRow;
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export interface NoticeClaim {
  /** 'claimed' -> send it. 'retry' -> a previous attempt failed; send again. 'sent' -> do nothing. */
  outcome: 'claimed' | 'retry' | 'sent';
  id: string | null;
}

/**
 * Take the right to send one notice, before sending it.
 *
 * The unique index on (commitment_id, notice_kind, due_on) does the work: a
 * second watcher run, a redeploy at 06:00 or an Inngest retry all try the same
 * insert and all lose it, so the person gets one message. A claim whose send
 * failed is reported as 'retry' — the message never went out, so repeating the
 * ATTEMPT costs an API call and repeating nothing costs a missed deadline.
 */
export async function claimNotice(
  db: SupabaseClient,
  input: {
    commitmentId: string;
    noticeKind: NoticeKind;
    dueOn: string;
    sentOn: string;
    recipientUserId?: string | null;
    recipientEmail?: string | null;
    channel?: 'email' | 'calendar' | 'none';
  },
): Promise<NoticeClaim> {
  const { data, error } = await db
    .from('commitment_notices')
    .insert({
      commitment_id: input.commitmentId,
      notice_kind: input.noticeKind,
      due_on: input.dueOn,
      sent_on: input.sentOn,
      channel: input.channel ?? 'email',
      recipient_user_id: input.recipientUserId ?? null,
      recipient_email: input.recipientEmail ?? null,
      delivered: false,
    })
    .select('id')
    .single();

  if (!error && data) return { outcome: 'claimed', id: (data as { id: string }).id };
  if (!isUniqueViolation(error)) throw error;

  const { data: existing } = await db
    .from('commitment_notices')
    .select('id, delivered')
    .eq('commitment_id', input.commitmentId)
    .eq('notice_kind', input.noticeKind)
    .eq('due_on', input.dueOn)
    .maybeSingle();
  const row = existing as { id: string; delivered: boolean } | null;
  if (!row) return { outcome: 'sent', id: null };
  return row.delivered ? { outcome: 'sent', id: row.id } : { outcome: 'retry', id: row.id };
}

export async function settleNotice(
  db: SupabaseClient,
  input: { id: string; delivered: boolean; note?: string | null; sentOn?: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    delivered: input.delivered,
    delivery_note: input.note?.slice(0, 500) ?? null,
  };
  if (input.sentOn) patch.sent_on = input.sentOn;
  await db.from('commitment_notices').update(patch).eq('id', input.id);
}

export async function acknowledgeNotices(
  db: SupabaseClient,
  input: { commitmentId: string; userId: string },
): Promise<void> {
  await db
    .from('commitment_notices')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: input.userId })
    .eq('commitment_id', input.commitmentId)
    .is('acknowledged_at', null);
}

export interface NoticeRow {
  id: string;
  commitment_id: string;
  notice_kind: NoticeKind;
  due_on: string;
  sent_on: string;
  channel: string;
  recipient_user_id: string | null;
  recipient_email: string | null;
  delivered: boolean;
  delivery_note: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

export const NOTICE_COLUMNS =
  'id, commitment_id, notice_kind, due_on, sent_on, channel, recipient_user_id, recipient_email, delivered, delivery_note, acknowledged_at, acknowledged_by, created_at';

export async function listNoticesFor(
  db: SupabaseClient,
  commitmentIds: string[],
): Promise<NoticeRow[]> {
  if (commitmentIds.length === 0) return [];
  const { data, error } = await db
    .from('commitment_notices')
    .select(NOTICE_COLUMNS)
    .in('commitment_id', commitmentIds)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) throw error;
  return (data ?? []) as NoticeRow[];
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Refresh the cached `state` column for the rows whose date moved them.
 *
 * Only rows that actually changed are written, so a workspace whose deadlines
 * are all months away costs one SELECT a day. `met` and `dropped` are never
 * touched: those are human decisions and a date arithmetic pass has no
 * business overruling them.
 */
export async function refreshStates(
  db: SupabaseClient,
  today: string,
): Promise<{ scanned: number; changed: number }> {
  const { data, error } = await db
    .from('commitments')
    .select('id, state, due_on, notice_days')
    .in('state', ['in_force', 'due_soon', 'overdue'])
    .eq('review_state', 'confirmed')
    .limit(5000);
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    id: string;
    state: string;
    due_on: string;
    notice_days: number;
  }>;
  let changed = 0;
  for (const row of rows) {
    const next = deriveState(row, today);
    if (next === row.state) continue;
    await db
      .from('commitments')
      .update({ state: next, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    changed += 1;
  }
  return { scanned: rows.length, changed };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * PostgREST reports a unique-index collision as 23505. Two of this module's
 * guarantees — one notice per occurrence, one successor per occurrence — are
 * enforced by indexes, so recognising this code is how "somebody else got
 * there first" is told apart from "something is broken".
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  return e.code === '23505' || /duplicate key value/i.test(e.message ?? '');
}
