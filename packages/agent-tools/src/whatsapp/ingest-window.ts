import { createHash } from 'node:crypto';
import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { approxTokens } from '../kb/chunker';
import { embedDocuments } from '../kb/embedder';
import { assertCanWriteToSpace } from '../kb/spaces';
import type { SpeechTurn } from '../kb/transcribe';
import { chunkTranscript } from '../kb/transcript-chunker';
import {
  type ConversationWindow,
  type StagedMessage,
  displayName,
  renderMessageText,
} from './windows';

/**
 * A window of WhatsApp group conversation becomes a Brain Knowledge document.
 *
 * THIS IS `import-transcript.ts` FOR A DIFFERENT DOOR, and that is deliberate
 * down to the column names. A Meet call and a WhatsApp group are the same kind
 * of object — a conversation with authors and times — so they write the same
 * provenance columns (`recorded_at`, `duration_seconds`, `speakers`,
 * `media_kind`), are chunked by the SAME function (`chunkTranscript`), and
 * carry the same `{speaker, speakers, startMs, endMs}` in `kb_chunks.metadata`.
 * Anything built on one — a citation renderer, a "who said this" filter, the
 * brain graph's media grouping — works on the other for free.
 *
 * WHAT IS DIFFERENT, AND WHY.
 *
 *   The clock. A Meet transcript's offsets are "how far into the call"; a
 *   window's are "how far into the episode", measured from its first message.
 *   Same unit, same meaning to a reader, and the header carries the wall-clock
 *   date so a citation can be resolved to a real Tuesday afternoon.
 *
 *   The destination. A Meet import defaults to the importer's private space. A
 *   group archive has no importer and no private space that would be honest, so
 *   the space is REQUIRED rather than defaulted, chosen once per group by
 *   somebody who can write to it. See migration 0068 § 3.
 *
 *   The ledger match. A conference record is a fixed string; a window's key is
 *   derived from its first message and can therefore shift if an older message
 *   turns up later. So the ledger is matched on key OR on overlapping time
 *   range, and a shifted window updates the row it already owns instead of
 *   forking a second document out of the same conversation.
 */

/** Everything this needs. Not an agent, not a conversation, not a span. */
export interface WhatsappIngestContext {
  organizationId: string;
  /**
   * The person who switched the group on. Their permission is what the write
   * is checked against, and their id is what `kb_documents.uploaded_by`
   * records — an archive still has somebody answerable for it.
   */
  userId: string;
  db: SupabaseClient;
  logger: Logger;
}

export interface WhatsappGroupRef {
  jid: string;
  subject: string | null;
  spaceId: string;
}

export type WindowIngestOutcome =
  /** A new document was created. */
  | 'imported'
  /** The window was already a document and its text changed. */
  | 'updated'
  /** Already ingested and byte-identical — nothing re-embedded. */
  | 'unchanged'
  /** Nothing worth storing (every message was empty). */
  | 'empty'
  /** Read but not stored. Recorded so the next pass retries. */
  | 'failed';

export interface WindowIngestResult {
  outcome: WindowIngestOutcome;
  note: string;
  windowKey: string;
  documentId: string | null;
  chunks: number;
  turns: number;
  participants: string[];
}

/** Attribution for a message WhatsApp could not name a sender for. */
const UNKNOWN_SPEAKER = 'Unknown participant';

/**
 * A ceiling on one window, in messages. Past this the conversation is not an
 * episode any more, it is a feed, and every chunk beyond the cap is another
 * embedding spent on something nobody will search that deep into. The window
 * is still stored — truncated, and the header says so, because a document that
 * silently drops half a conversation is worse than one that admits it.
 */
const MAX_MESSAGES_PER_WINDOW = 2_000;

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/**
 * Messages into the `SpeechTurn` shape the transcript chunker already speaks.
 *
 * Consecutive messages from the same person are merged into one turn. This is
 * not cosmetic: WhatsApp is written the way people talk, in four short bursts
 * where a caller would have said one sentence, and without merging the chunker
 * would be packing "Ana: ya" / "Ana: voy" / "Ana: en 10" as three turns and
 * spending three speaker prefixes on eight words. Merged, they read as what
 * they were.
 *
 * The merge stops at a five-minute gap even for the same speaker, because past
 * that the second burst is a new thought rather than a continuation, and its
 * timestamp is the one a citation should carry.
 */
export function buildTurns(messages: StagedMessage[], originMs: number): SpeechTurn[] {
  const MERGE_GAP_MS = 5 * 60_000;
  const turns: SpeechTurn[] = [];
  let lastAbsMs = originMs;

  for (const message of messages) {
    const text = renderMessageText(message).trim();
    if (!text) continue;

    const speaker = displayName(message) || UNKNOWN_SPEAKER;
    const absMs = Date.parse(message.sentAt);
    const at = Number.isFinite(absMs) ? absMs : lastAbsMs;
    const offset = Math.max(0, at - originMs);

    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === speaker && at - lastAbsMs < MERGE_GAP_MS) {
      previous.text = `${previous.text}\n${text}`;
      previous.endMs = Math.max(previous.endMs, offset);
      lastAbsMs = at;
      continue;
    }

    turns.push({ speaker, startMs: offset, endMs: offset, text });
    lastAbsMs = at;
  }

  return turns;
}

function formatMoment(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function formatClock(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/**
 * The first chunk, and the reason the conversation is citable on its own terms.
 *
 * A retrieved chunk of a WhatsApp group says "Ana: confirmado, sale mañana a
 * primera hora" and nothing else — not which group, not which client, not when.
 * Indexed as its own chunk, this header means "the Acme group in March" finds
 * the conversation itself, and anything that previews a document's first chunk
 * shows something worth reading.
 */
export function buildWindowHeader(input: {
  groupSubject: string;
  startMs: number;
  endMs: number;
  participants: string[];
  messageCount: number;
  timeZone: string;
  truncated: boolean;
}): string {
  const minutes = Math.max(1, Math.round((input.endMs - input.startMs) / 60_000));
  const facts = [
    'WhatsApp group',
    formatMoment(input.startMs, input.timeZone),
    `${formatClock(input.startMs, input.timeZone)}–${formatClock(input.endMs, input.timeZone)}`,
    `${minutes} min`,
    `${input.messageCount} message${input.messageCount === 1 ? '' : 's'}`,
  ];

  return [
    `# ${input.groupSubject}`,
    facts.join(' · '),
    input.participants.length
      ? `Who took part: ${input.participants.join(', ')}`
      : 'Who took part: WhatsApp reported no names.',
    input.truncated
      ? `Note: this conversation ran past ${MAX_MESSAGES_PER_WINDOW} messages and only the first ${MAX_MESSAGES_PER_WINDOW} are stored here.`
      : null,
    '',
    'What follows is the conversation in this WhatsApp group, in order, with who wrote each message and how far into the conversation. Voice notes are marked 🎤 and were transcribed automatically; files and images appear as a marker with whatever was written alongside them.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

interface PreparedChunk {
  content: string;
  chunkIndex: number;
  tokens: number;
  metadata: Record<string, unknown>;
}

/** Header chunk + one chunk per span of conversation, in reading order. */
export function buildWindowChunks(header: string, turns: SpeechTurn[]): PreparedChunk[] {
  const chunks: PreparedChunk[] = [
    {
      content: header,
      chunkIndex: 0,
      // No `speaker`: nobody wrote this, and attributing it to a participant
      // would put words in somebody's mouth in a citation.
      metadata: { kind: 'whatsapp_header', startMs: 0, endMs: 0 },
      tokens: approxTokens(header),
    },
  ];

  for (const chunk of chunkTranscript(turns)) {
    chunks.push({
      content: chunk.content,
      chunkIndex: chunks.length,
      tokens: chunk.tokens,
      metadata: { ...chunk.metadata },
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

interface LedgerRow {
  id: string;
  window_key: string;
  document_id: string | null;
  sha256: string | null;
}

/**
 * The row this window already owns, if it owns one.
 *
 * Two lookups because a window has two identities. The key is exact and is what
 * matches in the ordinary case. The time range is what catches the awkward one:
 * a message arriving out of order, older than the window's current first
 * message, moves the start and therefore the key — and without this second
 * lookup that would fork a second document out of a conversation that already
 * has one. Overlap, not containment: the boundaries have moved, so the ranges
 * merely touch.
 */
async function findLedger(
  db: SupabaseClient,
  groupJid: string,
  window: ConversationWindow,
): Promise<LedgerRow | null> {
  const { data: byKey } = await db
    .from('whatsapp_ingest_windows')
    .select('id, window_key, document_id, sha256')
    .eq('group_jid', groupJid)
    .eq('window_key', window.key)
    .maybeSingle();
  if (byKey) return byKey as unknown as LedgerRow;

  const { data: overlapping } = await db
    .from('whatsapp_ingest_windows')
    .select('id, window_key, document_id, sha256')
    .eq('group_jid', groupJid)
    .lte('window_start', new Date(window.endMs).toISOString())
    .gte('window_end', new Date(window.startMs).toISOString())
    .order('window_start', { ascending: true })
    .limit(1);
  const row = (overlapping ?? [])[0];
  return row ? (row as unknown as LedgerRow) : null;
}

// ---------------------------------------------------------------------------
// The ingest
// ---------------------------------------------------------------------------

export interface IngestWindowOptions {
  timeZone?: string;
}

/**
 * Fold one closed conversation window into Brain Knowledge.
 *
 * IDEMPOTENT BY SCHEMA. `whatsapp_ingest_windows` is unique on (workspace,
 * group, window key) — migration 0068 § 5 — and this function looks the row up
 * before writing anything: an already-ingested window reuses its `kb_documents`
 * row, replaces its chunks in place, and when the text has not changed at all
 * does not spend the embedding calls. That is what makes the flush pass safe to
 * run every few minutes over the same trailing hours.
 */
export async function ingestWindow(
  ctx: WhatsappIngestContext,
  group: WhatsappGroupRef,
  window: ConversationWindow,
  opts: IngestWindowOptions = {},
): Promise<WindowIngestResult> {
  const db = ctx.db;
  const timeZone = opts.timeZone ?? 'America/Bogota';
  const subject = group.subject?.trim() || 'WhatsApp group';

  const base = {
    windowKey: window.key,
    participants: window.participants,
  };

  // The writability check is FIRST and is not a formality. A space can be
  // renamed, made personal, or handed to somebody else long after a group was
  // switched on, and an archive that kept writing into it would be an
  // unattended job publishing a client conversation into a space its owner
  // never agreed to.
  try {
    await assertCanWriteToSpace(db, ctx.userId, group.spaceId);
  } catch (err) {
    return {
      ...base,
      outcome: 'failed',
      note: `The person who switched this group on can no longer write to the space it was going into: ${(err as Error).message}`,
      documentId: null,
      chunks: 0,
      turns: 0,
    };
  }

  const truncated = window.messages.length > MAX_MESSAGES_PER_WINDOW;
  const messages = truncated ? window.messages.slice(0, MAX_MESSAGES_PER_WINDOW) : window.messages;

  const turns = buildTurns(messages, window.startMs);
  if (turns.length === 0) {
    return {
      ...base,
      outcome: 'empty',
      note: 'Every message in that stretch was a sticker, a reaction or an empty body, so there was nothing to remember.',
      documentId: null,
      chunks: 0,
      turns: 0,
    };
  }

  const header = buildWindowHeader({
    groupSubject: subject,
    startMs: window.startMs,
    endMs: window.endMs,
    participants: window.participants,
    messageCount: messages.length,
    timeZone,
    truncated,
  });
  const chunks = buildWindowChunks(header, turns);
  const sha256 = createHash('sha256')
    .update(chunks.map((c) => c.content).join('\n\n'))
    .digest('hex');

  const ledger = await findLedger(db, group.jid, window);
  let documentId = ledger?.document_id ?? null;
  let currentSha: string | null = null;

  if (documentId) {
    const { data: docRow } = await db
      .from('kb_documents')
      .select('id, sha256, status, collection_id')
      .eq('id', documentId)
      .maybeSingle();
    if (docRow) {
      // A document mid-failure has to be rebuilt even if the text matches.
      currentSha = docRow.status === 'ready' ? ((docRow.sha256 as string | null) ?? null) : null;
    } else {
      // Somebody deleted the document from the Brain Knowledge page. That is a
      // decision, not a fault — but the ledger row still points at it, so the
      // window is rebuilt from scratch rather than silently skipped forever.
      documentId = null;
    }
  }

  const title = `${subject} — WhatsApp, ${formatMoment(window.startMs, timeZone)}`;
  const durationSeconds = Math.max(0, Math.round((window.endMs - window.startMs) / 1000));

  if (documentId && currentSha === sha256) {
    await stampMessages(db, messages, window.key, documentId);
    return {
      ...base,
      outcome: 'unchanged',
      note: 'That stretch of conversation was already saved and has not changed, so nothing was re-indexed.',
      documentId,
      chunks: 0,
      turns: turns.length,
    };
  }

  const documentFields = {
    collection_id: group.spaceId,
    source: 'whatsapp',
    // Identifies the exact window, so a document can be traced back to the
    // conversation without going through the ledger.
    source_ref: `${group.jid}#${window.key}`,
    title,
    mime: 'text/markdown',
    sha256,
    uploaded_by: ctx.userId,
    status: 'pending',
    error_message: null,
    // 0058's provenance columns, used for what they were defined for. The
    // `whatsapp` media kind (0068 § 7) keeps this out of the transcription
    // worker: there are no bytes here, the words already exist.
    media_kind: 'whatsapp',
    recorded_at: new Date(window.startMs).toISOString(),
    duration_seconds: durationSeconds,
    speakers: window.participants,
    transcript_status: 'ready',
    transcript_error: null,
  };

  try {
    if (documentId) {
      const { error } = await db.from('kb_documents').update(documentFields).eq('id', documentId);
      if (error) throw new Error(error.message);
      // Replace rather than diff: chunk boundaries move when a window is
      // re-planned, so index N is not the passage it was last time.
      const { error: delErr } = await db.from('kb_chunks').delete().eq('document_id', documentId);
      if (delErr) throw new Error(delErr.message);
    } else {
      const { data: created, error } = await db
        .from('kb_documents')
        .insert(documentFields)
        .select('id')
        .single();
      if (error || !created) throw new Error(error?.message ?? 'document row was not created');
      documentId = created.id as string;
    }

    // Indexed as documents, never as queries (see kb/embedder.ts on asymmetry).
    const embedded = await embedDocuments(chunks.map((c) => c.content));
    if (!embedded.ok && embedded.configured) throw new Error(embedded.reason);

    const { error: chunkErr } = await db.from('kb_chunks').insert(
      chunks.map((c, i) => ({
        document_id: documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        tokens: c.tokens,
        // Same trade as everywhere else: a deployment with no embedding key
        // still keeps the conversation, findable by keyword, rather than losing
        // it to a missing environment variable.
        embedding: embedded.ok ? embedded.data[i] : null,
        metadata: c.metadata,
      })),
    );
    if (chunkErr) throw new Error(chunkErr.message);

    await db
      .from('kb_documents')
      .update(
        embedded.ok
          ? { status: 'ready', error_message: null }
          : { status: 'pending', error_message: embedded.reason },
      )
      .eq('id', documentId);

    await recordWindow(db, ledger?.id ?? null, {
      groupJid: group.jid,
      window,
      messageCount: messages.length,
      documentId,
      sha256,
      status: 'ready',
      error: embedded.ok ? null : embedded.reason,
    });
    await stampMessages(db, messages, window.key, documentId);

    const outcome: WindowIngestOutcome = ledger?.document_id ? 'updated' : 'imported';
    return {
      ...base,
      outcome,
      note: embedded.ok
        ? `${outcome === 'updated' ? 'Refreshed' : 'Saved'} ${messages.length} messages from "${subject}" as one conversation: ${chunks.length} searchable passages, each tagged with who wrote it and when.`
        : `That conversation from "${subject}" was stored but could not be indexed by meaning: ${embedded.reason} It is still findable by keyword.`,
      documentId,
      chunks: chunks.length,
      turns: turns.length,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (documentId) {
      await db
        .from('kb_documents')
        .update({ status: 'failed', error_message: message })
        .eq('id', documentId)
        .then(undefined, () => undefined);
    }
    // Recorded as failed rather than not recorded: the next flush retries a
    // failed row, and an operator can see the attempt happened.
    await recordWindow(db, ledger?.id ?? null, {
      groupJid: group.jid,
      window,
      messageCount: messages.length,
      documentId,
      sha256,
      status: 'failed',
      error: message,
    }).catch((ledgerErr: unknown) => {
      ctx.logger.error(
        { err: (ledgerErr as Error).message, group: group.jid, window: window.key },
        'whatsapp: could not record the failed window',
      );
    });
    ctx.logger.error(
      { err: message, group: group.jid, window: window.key },
      'whatsapp: window ingest failed',
    );

    return {
      ...base,
      outcome: 'failed',
      note: `That conversation was read but could not be stored: ${message}`,
      documentId,
      chunks: 0,
      turns: turns.length,
    };
  }
}

/**
 * Write the ledger row.
 *
 * Deliberately fatal on the success path, for the same reason `recordImport` is
 * in the meeting importer: this row is what stops the next flush ingesting the
 * window a second time, so losing it silently would trade one visible failure
 * for an unbounded pile of duplicate documents.
 */
async function recordWindow(
  db: SupabaseClient,
  existingId: string | null,
  row: {
    groupJid: string;
    window: ConversationWindow;
    messageCount: number;
    documentId: string | null;
    sha256: string | null;
    status: 'ready' | 'failed';
    error: string | null;
  },
): Promise<void> {
  const payload = {
    group_jid: row.groupJid,
    window_key: row.window.key,
    window_start: new Date(row.window.startMs).toISOString(),
    window_end: new Date(row.window.endMs).toISOString(),
    message_count: row.messageCount,
    participants: row.window.participants,
    document_id: row.documentId,
    sha256: row.sha256,
    status: row.status,
    error: row.error,
    ingested_at: new Date().toISOString(),
  };

  // Update when the row was found by time range under a different key —
  // upserting on the key would insert a second row for the same conversation,
  // which is precisely what the overlap lookup exists to prevent.
  const { error } = existingId
    ? await db.from('whatsapp_ingest_windows').update(payload).eq('id', existingId)
    : await db
        .from('whatsapp_ingest_windows')
        .upsert(payload, { onConflict: 'organization_id,group_jid,window_key' });

  if (error) throw new Error(`whatsapp_ingest_windows write failed: ${error.message}`);
}

/**
 * Mark the staged messages as belonging to a document.
 *
 * This is what takes them out of the flush pass's "not folded in yet" query. It
 * is not the idempotency mechanism — the ledger is — but it is what keeps the
 * pass from re-reading the whole history of a group every five minutes.
 */
async function stampMessages(
  db: SupabaseClient,
  messages: StagedMessage[],
  windowKey: string,
  documentId: string,
): Promise<void> {
  const ids = messages.map((m) => m.id).filter(Boolean);
  if (ids.length === 0) return;
  // Chunked because PostgREST puts the id list in the URL and a long window
  // would otherwise build a request line nothing will accept.
  for (let i = 0; i < ids.length; i += 200) {
    await db
      .from('whatsapp_messages')
      .update({ window_key: windowKey, document_id: documentId })
      .in('id', ids.slice(i, i + 200))
      .then(undefined, () => undefined);
  }
}
