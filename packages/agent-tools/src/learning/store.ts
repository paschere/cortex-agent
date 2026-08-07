/**
 * Reading and writing what Cortex has learned.
 *
 * Everything here goes through a workspace-scoped handle. That is not a style
 * rule in this module, it is the whole risk: a module that generalises from how
 * people use the product is the easiest place in the codebase to accidentally
 * generalise from one company's usage and answer another company with it. The
 * three tables are registered `tenant()` in `tenancy/tables.ts`, so a query
 * that lost its filter does not return the wrong rows — it refuses to run.
 *
 * The only read on the answering path is `loadActiveAdjustments`, and it is
 * cached in process for a few seconds. See the note there.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActiveAdjustment,
  AdjustmentEvidence,
  AdjustmentKind,
  LearningAdjustment,
  LearningProposal,
  LearningProposalInput,
  LearningSignalInput,
  LearningSignalRow,
  ProposalStatus,
  SignalKind,
} from './types';

/** An adjustment lives 90 days unless the evidence keeps coming. */
export const ADJUSTMENT_DAYS = 90;
/** Signals are kept twice as long as the window that gates an adjustment. */
export const SIGNAL_RETENTION_DAYS = 180;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// The answering path
// ---------------------------------------------------------------------------

/**
 * How long a workspace's adjustments are trusted from memory.
 *
 * Short enough that undoing something takes effect while the person is still
 * looking at the screen, long enough that a burst of turns costs one lookup.
 * The correctness argument is that everything in the cache is an ORDERING and
 * nothing in it is a permission — serving one that was revoked eight seconds
 * ago changes which of two already-relevant passages is quoted first, and
 * nothing else. A cache over anything that gated access would not be
 * acceptable at any TTL.
 */
const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  at: number;
  adjustments: ActiveAdjustment[];
}

const cache = new Map<string, CacheEntry>();

/** Drop a workspace's cached adjustments. Called by every write below. */
export function forgetAdjustmentCache(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

interface ActiveRow {
  kind: AdjustmentKind;
  document_id: string;
  chunk_index: number;
}

/**
 * Every live adjustment for this workspace, for the retrieval about to run.
 *
 * NEVER THROWS. Learning is an improvement on an answer, never a precondition
 * for one: a workspace whose migrations lag by one, a lock, a network blip —
 * none of those may turn into a failed search. An empty list is exactly the
 * behaviour this module was added on top of, so failing to load is failing
 * safe, by construction rather than by care.
 */
export async function loadActiveAdjustments(
  db: SupabaseClient,
  organizationId: string,
): Promise<ActiveAdjustment[]> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.adjustments;

  try {
    const { data, error } = await db
      .from('learning_adjustments')
      .select('kind, document_id, chunk_index')
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString());
    if (error) throw error;
    const adjustments = ((data ?? []) as unknown as ActiveRow[]).map((r) => ({
      kind: r.kind,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
    }));
    cache.set(organizationId, { at: Date.now(), adjustments });
    return adjustments;
  } catch {
    // Cached as empty for the same TTL, so a database that is refusing this
    // query does not get asked again on every turn.
    cache.set(organizationId, { at: Date.now(), adjustments: [] });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function signalRow(input: LearningSignalInput, organizationId: string) {
  return {
    organization_id: organizationId,
    kind: input.kind,
    polarity: input.polarity,
    weight: input.weight,
    document_id: input.documentId,
    chunk_index: input.chunkIndex,
    actor_user_id: input.actorUserId ?? null,
    conversation_id: input.conversationId ?? null,
    turn_context_id: input.turnContextId ?? null,
    detail: input.detail ?? {},
    dedupe_key: input.dedupeKey,
    observed_at: input.observedAt,
    purge_at: new Date(
      new Date(input.observedAt).getTime() + SIGNAL_RETENTION_DAYS * DAY_MS,
    ).toISOString(),
  };
}

/**
 * Write observations, ignoring the ones already recorded.
 *
 * `upsert` on the dedupe key with `ignoreDuplicates`, because the derivation
 * pass deliberately re-reads an overlapping window every night and every one of
 * those nights would otherwise re-count the same Tuesday. Idempotence has to
 * live in the database: two concurrent passes get past any `if (!exists)`.
 *
 * Returns how many rows were actually new.
 */
export async function recordSignals(
  db: SupabaseClient,
  organizationId: string,
  inputs: readonly LearningSignalInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  const { data, error } = await db
    .from('learning_signals')
    .upsert(
      inputs.map((i) => signalRow(i, organizationId)),
      { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * One observation, from a place where a person just did something telling.
 *
 * Swallows everything. This is called from the middle of somebody confirming a
 * deadline or copying a passage; a learning row is never worth failing the
 * thing they were actually doing.
 */
export async function recordSignal(
  db: SupabaseClient,
  organizationId: string,
  input: LearningSignalInput,
): Promise<void> {
  try {
    await recordSignals(db, organizationId, [input]);
  } catch {
    // Deliberately silent. See above.
  }
}

interface SignalRow {
  id: string;
  kind: SignalKind;
  polarity: number;
  weight: number;
  document_id: string;
  chunk_index: number;
  actor_user_id: string | null;
  conversation_id: string | null;
  turn_context_id: string | null;
  detail: Record<string, unknown> | null;
  dedupe_key: string;
  observed_at: string;
  created_at: string;
}

function toSignal(row: SignalRow): LearningSignalRow {
  return {
    id: row.id,
    kind: row.kind,
    polarity: row.polarity === 1 ? 1 : -1,
    weight: (row.weight === 3 ? 3 : row.weight === 2 ? 2 : 1) as 1 | 2 | 3,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    actorUserId: row.actor_user_id,
    conversationId: row.conversation_id,
    turnContextId: row.turn_context_id,
    detail: row.detail ?? {},
    dedupeKey: row.dedupe_key,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}

/** Every signal in the gating window, newest first. */
export async function listSignalsSince(
  db: SupabaseClient,
  since: string,
  limit = 4000,
): Promise<LearningSignalRow[]> {
  const { data, error } = await db
    .from('learning_signals')
    .select(
      'id, kind, polarity, weight, document_id, chunk_index, actor_user_id, conversation_id, turn_context_id, detail, dedupe_key, observed_at, created_at',
    )
    .gte('observed_at', since)
    .order('observed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as SignalRow[]).map(toSignal);
}

/** Drop observations past their retention. Scoped like everything else. */
export async function purgeSignals(db: SupabaseClient, now = new Date()): Promise<void> {
  const { error } = await db.from('learning_signals').delete().lt('purge_at', now.toISOString());
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

interface AdjustmentRow {
  id: string;
  kind: AdjustmentKind;
  document_id: string;
  chunk_index: number;
  status: 'active' | 'revoked' | 'expired';
  evidence: AdjustmentEvidence | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}

const EMPTY_EVIDENCE: AdjustmentEvidence = {
  net: 0,
  positive: 0,
  negative: 0,
  actors: 0,
  days: 0,
  byKind: {},
  firstSeen: '',
  lastSeen: '',
};

function toAdjustment(row: AdjustmentRow): LearningAdjustment {
  return {
    id: row.id,
    kind: row.kind,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    status: row.status,
    evidence: row.evidence ?? EMPTY_EVIDENCE,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokedReason: row.revoked_reason,
  };
}

const ADJUSTMENT_COLUMNS =
  'id, kind, document_id, chunk_index, status, evidence, created_at, expires_at, revoked_at, revoked_by, revoked_reason';

export async function listAdjustments(
  db: SupabaseClient,
  opts: { status?: 'active' | 'past'; limit?: number } = {},
): Promise<LearningAdjustment[]> {
  let q = db.from('learning_adjustments').select(ADJUSTMENT_COLUMNS);
  if (opts.status === 'active') q = q.eq('status', 'active');
  if (opts.status === 'past') q = q.neq('status', 'active');
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) throw error;
  return ((data ?? []) as unknown as AdjustmentRow[]).map(toAdjustment);
}

export interface CreateAdjustmentInput {
  kind: AdjustmentKind;
  documentId: string;
  chunkIndex: number;
  evidence: AdjustmentEvidence;
}

/**
 * Apply an adjustment, replacing whatever was live for that fragment.
 *
 * The replacement is the interesting half. The first time the evidence turns
 * around — a fragment people were rephrasing away from starts being copied —
 * the old verdict must GO, not sit alongside the new one. The unique index in
 * migration 0083 makes coexistence impossible in the database; this is the
 * happy path that keeps the code from ever meeting that error.
 */
export async function applyAdjustment(
  db: SupabaseClient,
  organizationId: string,
  input: CreateAdjustmentInput,
  now = new Date(),
): Promise<void> {
  await db
    .from('learning_adjustments')
    .update({
      status: 'expired',
      revoked_at: now.toISOString(),
      revoked_reason: 'La evidencia cambió y este ajuste fue reemplazado.',
    })
    .eq('status', 'active')
    .eq('document_id', input.documentId)
    .eq('chunk_index', input.chunkIndex);

  const { error } = await db.from('learning_adjustments').insert({
    organization_id: organizationId,
    kind: input.kind,
    document_id: input.documentId,
    chunk_index: input.chunkIndex,
    status: 'active',
    evidence: input.evidence,
    expires_at: new Date(now.getTime() + ADJUSTMENT_DAYS * DAY_MS).toISOString(),
  });
  if (error) throw error;
  forgetAdjustmentCache(organizationId);
}

/**
 * The undo.
 *
 * One row, one write, and it stops applying on the next turn (within the cache
 * TTL, which is seconds). Nothing is deleted: an adjustment that was undone is
 * more interesting than one that was never made, and the history panel is how
 * anybody works out whether the loop is helping.
 */
export async function revokeAdjustment(
  db: SupabaseClient,
  organizationId: string,
  opts: { id: string; userId: string; reason?: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('learning_adjustments')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: opts.userId,
      revoked_reason: opts.reason?.trim() || 'Alguien lo deshizo a mano.',
    })
    .eq('id', opts.id)
    .eq('status', 'active')
    .select('id');
  if (error) throw error;
  forgetAdjustmentCache(organizationId);
  return (data ?? []).length > 0;
}

/** Retire everything past its date. Called at the top of every pass. */
export async function expireAdjustments(
  db: SupabaseClient,
  organizationId: string,
  now = new Date(),
): Promise<number> {
  const { data, error } = await db
    .from('learning_adjustments')
    .update({
      status: 'expired',
      revoked_at: now.toISOString(),
      revoked_reason: 'Dejó de haber evidencia nueva y venció por su cuenta.',
    })
    .eq('status', 'active')
    .lt('expires_at', now.toISOString())
    .select('id');
  if (error) throw error;
  forgetAdjustmentCache(organizationId);
  return (data ?? []).length;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

interface ProposalRow {
  id: string;
  kind: LearningProposal['kind'];
  document_id: string | null;
  chunk_index: number | null;
  headline: string;
  detail: string;
  evidence: Record<string, unknown> | null;
  status: ProposalStatus;
  decided_at: string | null;
  decided_by: string | null;
  decided_note: string | null;
  dedupe_key: string;
  created_at: string;
}

const PROPOSAL_COLUMNS =
  'id, kind, document_id, chunk_index, headline, detail, evidence, status, decided_at, decided_by, decided_note, dedupe_key, created_at';

function toProposal(row: ProposalRow): LearningProposal {
  return {
    id: row.id,
    kind: row.kind,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    headline: row.headline,
    detail: row.detail,
    evidence: row.evidence ?? {},
    status: row.status,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decidedNote: row.decided_note,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
  };
}

/**
 * Raise proposals, skipping the ones already on the board.
 *
 * `ignoreDuplicates` on the dedupe key is doing real work here: a proposal that
 * somebody DISMISSED must stay dismissed. Re-raising it every night until they
 * gave in would be the module nagging its way past a human decision, which is
 * the exact failure the proposal table exists to prevent. It comes back only
 * when the evidence changes enough to change the key.
 */
export async function raiseProposals(
  db: SupabaseClient,
  organizationId: string,
  inputs: readonly LearningProposalInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  const { data, error } = await db
    .from('learning_proposals')
    .upsert(
      inputs.map((p) => ({
        organization_id: organizationId,
        kind: p.kind,
        document_id: p.documentId,
        chunk_index: p.chunkIndex,
        headline: p.headline,
        detail: p.detail,
        evidence: p.evidence,
        dedupe_key: p.dedupeKey,
      })),
      { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

export async function listLearningProposals(
  db: SupabaseClient,
  opts: { status?: ProposalStatus; limit?: number } = {},
): Promise<LearningProposal[]> {
  let q = db.from('learning_proposals').select(PROPOSAL_COLUMNS);
  if (opts.status) q = q.eq('status', opts.status);
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (error) throw error;
  return ((data ?? []) as unknown as ProposalRow[]).map(toProposal);
}

/**
 * A person decides. `accepted` means "yes, I will go and fix it" — it does not
 * fix anything, because fixing it means editing the corpus and that is the one
 * thing this module never does on its own.
 */
export async function decideLearningProposal(
  db: SupabaseClient,
  opts: { id: string; userId: string; status: 'accepted' | 'dismissed'; note?: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('learning_proposals')
    .update({
      status: opts.status,
      decided_at: new Date().toISOString(),
      decided_by: opts.userId,
      decided_note: opts.note?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', opts.id)
    .eq('status', 'open')
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}
