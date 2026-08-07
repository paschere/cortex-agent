import { createHash } from 'node:crypto';
import { type Logger, internalEmailDomains, isInternalEmailDomain } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { approxTokens } from '../kb/chunker';
import { embedDocuments } from '../kb/embedder';
import { recordEmbeddingUsage } from '../kb/embedding-usage';
import { assertCanWriteToSpace } from '../kb/spaces';
import type { SpeechTurn } from '../kb/transcribe';
import { chunkTranscript } from '../kb/transcript-chunker';
import { type GraphMessage, addressesOf, formatRecipient } from '../msgraph/client';
import { messageMoment, threadParticipants } from './threads';

/**
 * An Outlook conversation with people outside the company becomes a Brain
 * Knowledge document.
 *
 * THIS IS `whatsapp/ingest-window.ts` FOR A DIFFERENT DOOR, deliberately, down
 * to the column names. A WhatsApp window, a Meet call and a mail thread are the
 * same kind of object — a conversation with authors and times — so all three
 * write the same provenance columns (`recorded_at`, `duration_seconds`,
 * `speakers`), are chunked by the SAME function (`chunkTranscript`), and carry
 * the same `{speaker, speakers, startMs, endMs}` in `kb_chunks.metadata`.
 * Every citation renderer and "who said this" filter built for one works on
 * this for free.
 *
 * THE RULE THAT MATTERS MOST IS WHAT DOES NOT GET ARCHIVED.
 *
 * In WhatsApp, groups are archivable and direct messages are not — because a
 * DM is one person's private correspondence and archiving it would put an
 * employee's private conversation into a shared brain. Mail has exactly the
 * same split, and it is sharper: a mailbox is nothing BUT correspondence, and
 * most of it is internal — a salary question to HR, a complaint about a
 * colleague, an argument with a manager. None of that is archive material and
 * none of it may end up in a space other people can search.
 *
 * So a thread is archivable only when somebody OUTSIDE the workspace's own
 * email domains is on it: a client, a supplier, a customs broker, a carrier.
 * That is the correspondence the company has a legitimate interest in
 * remembering, and it is the same line WhatsApp draws between a group and a DM.
 *
 * AND IF WE CANNOT TELL, WE REFUSE. When `INTERNAL_EMAIL_DOMAINS` is unset,
 * nobody is internal (see @cortex/core) — which would make EVERY thread look
 * external and archive the entire mailbox. The unconfigured deployment
 * therefore archives nothing and says why. That is the opposite direction from
 * the security classifier's default, and for the same reason: each one errs
 * toward the outcome that cannot be undone by a human noticing later.
 *
 * IDEMPOTENT BY SCHEMA. `microsoft_mail_ingests` is unique on (workspace,
 * conversation) — migration 0078 § 2 — and this looks the row up before writing
 * anything: an already-archived thread reuses its `kb_documents` row, replaces
 * its chunks in place, and when the text has not changed does not spend the
 * embedding calls. A thread that grows by three replies is re-archived as one
 * document, not four.
 */

/** Everything this needs. Not an agent, not a conversation, not a span. */
export interface OutlookIngestContext {
  organizationId: string;
  /**
   * The person archiving. Their permission is what the write is checked
   * against, and their id is what `kb_documents.uploaded_by` records — an
   * archive still has somebody answerable for it.
   */
  userId: string;
  db: SupabaseClient;
  logger: Logger;
}

export type ThreadIngestOutcome =
  /** A new document was created. */
  | 'imported'
  /** The thread was already a document and its text changed. */
  | 'updated'
  /** Already archived and byte-identical — nothing re-embedded. */
  | 'unchanged'
  /** Everyone on it works here. Not archive material; nothing was written. */
  | 'internal'
  /** Nothing worth storing (every message was empty). */
  | 'empty'
  /** Read but not stored. Recorded so a retry is possible. */
  | 'failed';

export interface ThreadIngestResult {
  outcome: ThreadIngestOutcome;
  /** One sentence a person (or a model) can act on. Never a stack trace. */
  note: string;
  conversationId: string;
  documentId: string | null;
  /** The outside domain this correspondence is with, when there is exactly one. */
  counterpartDomain: string | null;
  /** Linked client, when the domain matched one unambiguously. Usually null. */
  clientId: string | null;
  chunks: number;
  messages: number;
  participants: string[];
}

/**
 * A ceiling on one thread, in messages. Past this it is a mailing list, not a
 * conversation, and every chunk beyond the cap is another embedding spent on
 * something nobody will search that deep into. The thread is still stored —
 * truncated, and the header says so.
 */
const MAX_MESSAGES_PER_THREAD = 400;

const UNKNOWN_SENDER = 'Unknown sender';

// ---------------------------------------------------------------------------
// Who is on this thread
// ---------------------------------------------------------------------------

export interface ThreadAudience {
  /** Addresses on a domain that is not ours. */
  external: string[];
  /** The distinct outside domains, lowercased. */
  externalDomains: string[];
  /** True when INTERNAL_EMAIL_DOMAINS is unset and the question is unanswerable. */
  undecidable: boolean;
}

export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/** Who on this thread is outside the company — the whole archivability test. */
export function classifyAudience(participants: string[]): ThreadAudience {
  if (internalEmailDomains().length === 0) {
    return { external: [], externalDomains: [], undecidable: true };
  }
  const external = participants.filter((a) => !isInternalEmailDomain(a));
  const domains = new Set<string>();
  for (const a of external) {
    const d = domainOf(a);
    if (d) domains.add(d);
  }
  return { external, externalDomains: [...domains], undecidable: false };
}

/**
 * Free mailbox providers. A thread with a client is with `naviera.com.co`; a
 * thread with `hotmail.com` is a person, and their address is not a company we
 * would ever want to attribute correspondence to.
 */
const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'hotmail.com.co',
  'outlook.com',
  'outlook.es',
  'live.com',
  'yahoo.com',
  'yahoo.es',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'aol.com',
]);

/**
 * The one outside domain this correspondence is with, when there is one.
 *
 * Null when the thread spans several companies or only free mailboxes: an
 * ambiguous attribution is worse than none, because a wrong `client_id` is a
 * fact somebody will later read off a report.
 */
export function counterpartDomainOf(audience: ThreadAudience): string | null {
  const corporate = audience.externalDomains.filter((d) => !PERSONAL_MAIL_DOMAINS.has(d));
  return corporate.length === 1 ? (corporate[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// The client link
// ---------------------------------------------------------------------------

/**
 * Find the client this correspondence belongs to, from the counterpart domain.
 *
 * IT READS A HUMAN'S STATEMENT AND MAKES NO GUESS OF ITS OWN. `client_domains`
 * (migration 0075) holds "this domain belongs to this client", each row signed
 * by the person who vouched for it and unique across the workspace. That is the
 * strongest signal there is for whose mail this is — stronger than the subject,
 * the body, or any similarity between a domain and a company name — precisely
 * because somebody asserted it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is fall back to matching the domain's label
 * against client names. `coltrans.com` looks like "Colombiana de Transportes"
 * and also like "Colombia Transportadora", and 0075's own header states the
 * rule this defers to: a link that was not earned is worse than no link at all.
 * A wrong attribution ends up in a report somebody acts on; a missing one is a
 * gap closed by registering the domain once, which then fixes every future
 * thread from that sender.
 *
 * SO IT RETURNS NULL FAR MORE OFTEN THAN IT MATCHES, and the whole lookup is
 * wrapped: a workspace that has registered no domains, or a deployment where
 * migration 0075 has not been applied, gets a null link rather than a failed
 * archive.
 */
export async function matchClientByDomain(
  db: SupabaseClient,
  domain: string | null,
): Promise<string | null> {
  if (!domain) return null;
  try {
    const { data, error } = await db
      .from('client_domains')
      .select('client_id')
      .eq('domain', domain.trim().toLowerCase())
      .maybeSingle();
    if (error || !data) return null;
    return ((data as { client_id?: string }).client_id ?? null) as string | null;
  } catch {
    // The table may not exist yet in this environment. A missing link is a
    // normal outcome here; a failed archive would not be.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

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

function momentMs(m: GraphMessage): number {
  const at = messageMoment(m);
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Messages into the `SpeechTurn` shape the transcript chunker already speaks.
 *
 * Offsets are "how far into the correspondence", measured from the first
 * message — the same unit a WhatsApp window uses, and it means the same thing
 * to a reader: a citation can say "in the third message, two days in".
 *
 * Consecutive messages from the same person are NOT merged, unlike WhatsApp.
 * Two mails from the same person a day apart are two documents of intent, not
 * one burst of typing, and collapsing them would lose the second date.
 */
export function buildMailTurns(messages: GraphMessage[], originMs: number): SpeechTurn[] {
  const turns: SpeechTurn[] = [];
  for (const m of messages) {
    const text = (m.body?.content ?? m.bodyPreview ?? '').trim();
    if (!text) continue;
    const speaker = formatRecipient(m.from ?? m.sender) ?? UNKNOWN_SENDER;
    const offset = Math.max(0, momentMs(m) - originMs);
    turns.push({ speaker, startMs: offset, endMs: offset, text });
  }
  return turns;
}

/**
 * The first chunk, and the reason the thread is citable on its own terms.
 *
 * A retrieved chunk of a mail thread says "confirmamos el zarpe para el 14" and
 * nothing else — not with whom, not about what, not when. Indexed as its own
 * chunk, this header means "the Naviera correspondence in March" finds the
 * thread itself, and anything previewing a document's first chunk shows
 * something worth reading.
 */
export function buildThreadHeader(input: {
  subject: string;
  startMs: number;
  endMs: number;
  participants: string[];
  externalDomains: string[];
  messageCount: number;
  timeZone: string;
  truncated: boolean;
}): string {
  const facts = [
    'Outlook mail thread',
    formatMoment(input.startMs, input.timeZone),
    input.endMs > input.startMs ? `until ${formatMoment(input.endMs, input.timeZone)}` : null,
    `${input.messageCount} message${input.messageCount === 1 ? '' : 's'}`,
  ].filter((f): f is string => Boolean(f));

  return [
    `# ${input.subject}`,
    facts.join(' · '),
    input.participants.length
      ? `Who took part: ${input.participants.join(', ')}`
      : 'Who took part: the mailbox reported no addresses.',
    input.externalDomains.length
      ? `Outside the company: ${input.externalDomains.join(', ')}`
      : null,
    input.truncated
      ? `Note: this thread ran past ${MAX_MESSAGES_PER_THREAD} messages and only the first ${MAX_MESSAGES_PER_THREAD} are stored here.`
      : null,
    '',
    'What follows is the correspondence in this mail thread, in order, with who wrote each message and how far into the exchange.',
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

/** Header chunk + one chunk per span of correspondence, in reading order. */
export function buildThreadChunks(header: string, turns: SpeechTurn[]): PreparedChunk[] {
  const chunks: PreparedChunk[] = [
    {
      content: header,
      chunkIndex: 0,
      // No `speaker`: nobody wrote this, and attributing it to a participant
      // would put words in somebody's mouth in a citation.
      metadata: { kind: 'outlook_header', startMs: 0, endMs: 0 },
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
  document_id: string | null;
  sha256: string | null;
}

async function findLedger(
  db: SupabaseClient,
  conversationId: string,
): Promise<LedgerRow | null> {
  const { data } = await db
    .from('microsoft_mail_ingests')
    .select('id, document_id, sha256')
    .eq('conversation_id', conversationId)
    .maybeSingle();
  return (data as unknown as LedgerRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// The ingest
// ---------------------------------------------------------------------------

export interface IngestThreadOptions {
  timeZone?: string;
}

/**
 * Fold one Outlook conversation into Brain Knowledge.
 *
 * Takes the messages rather than fetching them, so the tool, a future sweep and
 * the tests all drive the same code with no Graph in the way.
 */
export async function ingestThread(
  ctx: OutlookIngestContext,
  input: {
    conversationId: string;
    spaceId: string;
    messages: GraphMessage[];
  },
  opts: IngestThreadOptions = {},
): Promise<ThreadIngestResult> {
  const db = ctx.db;
  const timeZone = opts.timeZone ?? 'America/Bogota';

  const ordered = [...input.messages].sort((a, b) => momentMs(a) - momentMs(b));
  const participants = threadParticipants(ordered);
  const audience = classifyAudience(participants);

  const base = {
    conversationId: input.conversationId,
    participants,
    counterpartDomain: null as string | null,
    clientId: null as string | null,
  };

  if (audience.undecidable) {
    return {
      ...base,
      outcome: 'internal',
      note: 'Cortex cannot tell who is inside this company and who is not, because INTERNAL_EMAIL_DOMAINS is not configured on this deployment. Nothing was archived — without that list every thread would look like client correspondence, including the private ones. Ask whoever runs the deployment to set it.',
      documentId: null,
      chunks: 0,
      messages: 0,
    };
  }

  if (audience.external.length === 0) {
    return {
      ...base,
      outcome: 'internal',
      note: 'Everyone on this thread works here, so it is internal correspondence and was not archived. Cortex archives mail with clients, suppliers and other outside parties — the same line it draws between a WhatsApp group and a direct message.',
      documentId: null,
      chunks: 0,
      messages: 0,
    };
  }

  const counterpartDomain = counterpartDomainOf(audience);
  base.counterpartDomain = counterpartDomain;

  // The writability check is FIRST and is not a formality. A space can be
  // renamed, made personal or handed to somebody else, and an archive that kept
  // writing into it would publish client correspondence into a space its owner
  // never agreed to.
  try {
    await assertCanWriteToSpace(db, ctx.userId, input.spaceId);
  } catch (err) {
    return {
      ...base,
      outcome: 'failed',
      note: `That thread was not archived because you cannot write to the space it was going into: ${(err as Error).message}`,
      documentId: null,
      chunks: 0,
      messages: 0,
    };
  }

  const truncated = ordered.length > MAX_MESSAGES_PER_THREAD;
  const messages = truncated ? ordered.slice(0, MAX_MESSAGES_PER_THREAD) : ordered;

  const startMs = momentMs(messages[0] ?? ({} as GraphMessage));
  const endMs = momentMs(messages[messages.length - 1] ?? ({} as GraphMessage));

  const turns = buildMailTurns(messages, startMs);
  if (turns.length === 0) {
    return {
      ...base,
      outcome: 'empty',
      note: 'Every message in that thread came back with an empty body, so there was nothing to remember.',
      documentId: null,
      chunks: 0,
      messages: 0,
    };
  }

  const subject = messages[0]?.subject?.trim() || '(no subject)';
  const header = buildThreadHeader({
    subject,
    startMs,
    endMs,
    participants,
    externalDomains: audience.externalDomains,
    messageCount: messages.length,
    timeZone,
    truncated,
  });
  const chunks = buildThreadChunks(header, turns);
  const sha256 = createHash('sha256')
    .update(chunks.map((c) => c.content).join('\n\n'))
    .digest('hex');

  const clientId = await matchClientByDomain(db, counterpartDomain);
  base.clientId = clientId;

  const ledger = await findLedger(db, input.conversationId);
  let documentId = ledger?.document_id ?? null;
  let currentSha: string | null = null;

  if (documentId) {
    const { data: docRow } = await db
      .from('kb_documents')
      .select('id, sha256, status')
      .eq('id', documentId)
      .maybeSingle();
    if (docRow) {
      // A document mid-failure has to be rebuilt even if the text matches.
      currentSha = docRow.status === 'ready' ? ((docRow.sha256 as string | null) ?? null) : null;
    } else {
      // Somebody deleted it from the Brain Knowledge page. That is a decision,
      // not a fault — but the ledger still points at it, so the thread is
      // rebuilt from scratch rather than silently skipped forever.
      documentId = null;
    }
  }

  if (documentId && currentSha === sha256) {
    return {
      ...base,
      outcome: 'unchanged',
      note: 'That thread was already archived and has not changed since, so nothing was re-indexed.',
      documentId,
      chunks: 0,
      messages: messages.length,
    };
  }

  const title = `${subject} — Outlook, ${formatMoment(startMs, timeZone)}`;
  const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));

  const documentFields = {
    collection_id: input.spaceId,
    source: 'outlook',
    // Identifies the exact conversation, so a document can be traced back to
    // the mailbox without going through the ledger.
    source_ref: `outlook:${input.conversationId}`,
    title,
    mime: 'text/markdown',
    sha256,
    uploaded_by: ctx.userId,
    status: 'pending',
    error_message: null,
    // 0058's provenance columns, used for what they were defined for.
    // `media_kind` stays 'text' rather than gaining a fifth value: there are no
    // bytes here and nothing for the transcription worker to do, and widening a
    // shared check constraint from this migration would fight with anyone
    // else's. Provenance is carried by `source`.
    media_kind: 'text',
    recorded_at: new Date(startMs).toISOString(),
    duration_seconds: durationSeconds,
    speakers: participants,
    transcript_status: 'ready',
    transcript_error: null,
  };

  try {
    if (documentId) {
      const { error } = await db.from('kb_documents').update(documentFields).eq('id', documentId);
      if (error) throw new Error(error.message);
      // Replace rather than diff: chunk boundaries move when a thread grows, so
      // index N is not the passage it was last time.
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
    if (!embedded.ok && embedded.retryable) throw new Error(embedded.reason);

    const { error: chunkErr } = await db.from('kb_chunks').insert(
      chunks.map((c, i) => ({
        document_id: documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        tokens: c.tokens,
        // Same trade as everywhere else: a deployment with no embedding key
        // still keeps the correspondence, findable by keyword.
        embedding: embedded.ok ? embedded.data[i] : null,
        // The model travels with the vector or neither is written (0074).
        embedding_model: embedded.ok ? embedded.usage.modelId : null,
        metadata: c.metadata,
      })),
    );
    if (chunkErr) throw new Error(chunkErr.message);

    if (embedded.ok) {
      await recordEmbeddingUsage(db, {
        organizationId: ctx.organizationId,
        documentId,
        source: 'outlook',
        usage: embedded.usage,
      });
    }

    await db
      .from('kb_documents')
      .update(
        embedded.ok
          ? { status: 'ready', error_message: null }
          : { status: 'pending', error_message: embedded.reason },
      )
      .eq('id', documentId);

    await recordIngest(db, ledger?.id ?? null, {
      userId: ctx.userId,
      conversationId: input.conversationId,
      internetMessageId: messages[0]?.internetMessageId ?? null,
      subject,
      spaceId: input.spaceId,
      documentId,
      clientId,
      counterpartDomain,
      messageCount: messages.length,
      firstMessageAt: new Date(startMs).toISOString(),
      lastMessageAt: new Date(endMs).toISOString(),
      sha256,
      status: 'ready',
      error: embedded.ok ? null : embedded.reason,
    });

    const outcome: ThreadIngestOutcome = ledger?.document_id ? 'updated' : 'imported';
    return {
      ...base,
      outcome,
      note: embedded.ok
        ? `${outcome === 'updated' ? 'Refreshed' : 'Saved'} ${messages.length} message${messages.length === 1 ? '' : 's'} from "${subject}" as one thread: ${chunks.length} searchable passages, each tagged with who wrote it and when.${clientId ? ' Linked to the client that owns that domain.' : ''}`
        : `That thread was stored but could not be indexed by meaning: ${embedded.reason} It is still findable by keyword.`,
      documentId,
      chunks: chunks.length,
      messages: messages.length,
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
    await recordIngest(db, ledger?.id ?? null, {
      userId: ctx.userId,
      conversationId: input.conversationId,
      internetMessageId: messages[0]?.internetMessageId ?? null,
      subject,
      spaceId: input.spaceId,
      documentId,
      clientId,
      counterpartDomain,
      messageCount: messages.length,
      firstMessageAt: new Date(startMs).toISOString(),
      lastMessageAt: new Date(endMs).toISOString(),
      sha256,
      status: 'failed',
      error: message,
    }).catch((ledgerErr: unknown) => {
      ctx.logger.error(
        { err: (ledgerErr as Error).message, conversation: input.conversationId },
        'outlook: could not record the failed thread',
      );
    });
    ctx.logger.error(
      { err: message, conversation: input.conversationId },
      'outlook: thread ingest failed',
    );

    return {
      ...base,
      outcome: 'failed',
      note: `That thread was read but could not be stored: ${message}`,
      documentId,
      chunks: 0,
      messages: messages.length,
    };
  }
}

/**
 * Write the ledger row.
 *
 * Deliberately fatal on the success path, for the same reason it is in the
 * WhatsApp and Meet importers: this row is what stops the thread being archived
 * a second time, so losing it silently would trade one visible failure for an
 * unbounded pile of duplicate documents.
 */
async function recordIngest(
  db: SupabaseClient,
  existingId: string | null,
  row: {
    userId: string;
    conversationId: string;
    internetMessageId: string | null;
    subject: string;
    spaceId: string;
    documentId: string | null;
    clientId: string | null;
    counterpartDomain: string | null;
    messageCount: number;
    firstMessageAt: string;
    lastMessageAt: string;
    sha256: string | null;
    status: 'ready' | 'failed';
    error: string | null;
  },
): Promise<void> {
  const payload = {
    user_id: row.userId,
    conversation_id: row.conversationId,
    internet_message_id: row.internetMessageId,
    subject: row.subject,
    space_id: row.spaceId,
    document_id: row.documentId,
    client_id: row.clientId,
    counterpart_domain: row.counterpartDomain,
    message_count: row.messageCount,
    first_message_at: row.firstMessageAt,
    last_message_at: row.lastMessageAt,
    sha256: row.sha256,
    status: row.status,
    error: row.error,
    ingested_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = existingId
    ? await db.from('microsoft_mail_ingests').update(payload).eq('id', existingId)
    : await db
        .from('microsoft_mail_ingests')
        .upsert(payload, { onConflict: 'organization_id,conversation_id' });

  if (error) throw new Error(`microsoft_mail_ingests write failed: ${error.message}`);
}

/** Addresses on a message, for callers that only hold one. */
export function messageAddresses(m: GraphMessage): string[] {
  return addressesOf(m.from ?? m.sender, m.toRecipients, m.ccRecipients);
}
