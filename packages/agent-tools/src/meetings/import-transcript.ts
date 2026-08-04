import { createHash } from 'node:crypto';
import { IntegrationError } from '@cortex/core';
import { z } from 'zod';
import { fetchEventsInRange, parseMeetCode } from '../gcal/events';
import { registerTool } from '../index';
import { approxTokens } from '../kb/chunker';
import { embedDocuments } from '../kb/embedder';
import { assertCanWriteToSpace, ensurePersonalSpace, resolveSpaceByName } from '../kb/spaces';
import type { SpeechTurn } from '../kb/transcribe';
import { chunkTranscript } from '../kb/transcript-chunker';
import type { ToolContext } from '../types';
import {
  type ConferenceRecord,
  MEET_READONLY_SCOPE,
  type MeetParticipant,
  type TranscriptEntry,
  fetchSpaceMeetingCode,
  fetchTranscriptEntries,
  getConferenceRecord,
  listConferenceRecords,
  listParticipants,
  listTranscripts,
  pickTranscript,
} from './client';

/**
 * Turning a Google Meet call into something the Knowledge Base remembers.
 *
 * THE PROBLEM. `meetings.get_transcript` reads a call and hands the text to the
 * model for one turn, and then it is gone. Everything this company agrees to
 * out loud — a scope change a client accepted on a Tuesday, a rate someone
 * conceded, the reason a candidate was passed over — lived only in Google's
 * retention window and in whoever happened to be listening. This module makes
 * the call a document: chunked by who was speaking, stamped with when they said
 * it, and searchable next to everything else Cortex knows, months later.
 *
 * WHY IT REUSES THE AUDIO PATH. 0058 taught the Knowledge Base to hold spoken
 * material: `kb_documents` gained `recorded_at` / `duration_seconds` /
 * `speakers`, `kb_chunks.metadata` gained `{speaker, startMs, endMs}`, and
 * `kb_search_scoped` started returning that metadata so a hit can be cited as
 * "she said it 14 minutes in". A Meet transcript is the same kind of object
 * arriving through a different door — Google has already done the transcribing
 * — so it writes the same columns and is chunked by the SAME function
 * (`chunkTranscript`). Anything built on top of one (a citation renderer, a
 * player, a "who said this" filter) works on the other for free.
 *
 * WHERE IT LANDS, AND WHY THAT IS THE CAREFUL PART. See `resolveDestination`.
 */

/** What a chunk of a Meet transcript can be attributed to when Meet cannot. */
const UNKNOWN_SPEAKER = 'Unknown speaker';

/**
 * A hard ceiling on entries pulled from one conference. A long all-hands can
 * emit tens of thousands, and every chunk past this point is another embedding
 * charged against a call nobody will ever search that deep into.
 */
const MAX_ENTRIES = 8_000;

export type MeetingImportOutcome =
  /** A new document was created. */
  | 'imported'
  /** The conference was already in the KB and its document was refreshed. */
  | 'updated'
  /** Already imported and the transcript has not changed — nothing re-embedded. */
  | 'unchanged'
  /** No transcript exists (yet). Not an error; nothing was written. */
  | 'unavailable'
  /** Google refused: the Meet scope is missing or the connection has lapsed. */
  | 'unauthorized'
  /** A transcript was found but could not be stored. Recorded for retry. */
  | 'failed';

export interface MeetingImportResult {
  outcome: MeetingImportOutcome;
  /** One sentence a person (or a model) can act on. Never a stack trace. */
  note: string;
  conferenceRecord: string | null;
  meetingCode: string | null;
  title: string | null;
  documentId: string | null;
  spaceId: string | null;
  spaceName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  participants: string[];
  chunks: number;
  turns: number;
}

export interface ImportMeetingOptions {
  /** "conferenceRecords/xxx" — one exact sitting of a meeting. */
  conferenceRecord?: string;
  /** The joinable code from the invite, e.g. "abc-defg-hij". */
  meetCode?: string;
  /** How far back to look when resolving a meeting code to a sitting. */
  lookbackDays?: number;
  /**
   * Name of the Knowledge Base space to file it in. Omitted means "the
   * importer's own space" — see `resolveDestination`.
   */
  spaceName?: string;
  /**
   * The same thing by id, for surfaces that already hold one (the Knowledge
   * Base page imports into the space you are looking at). Wins over `spaceName`
   * because an id is unambiguous and a name is a guess.
   */
  spaceId?: string;
  /** Skip the calendar lookup that resolves a human title. */
  skipCalendarTitle?: boolean;
}

/**
 * The importer needs a user, a database and Google credentials — not an agent,
 * a conversation or a tracing span. Declaring the narrow shape lets the Inngest
 * sweep and the web route call it without inventing an agent id, while a real
 * `ToolContext` still satisfies it structurally.
 */
export type MeetingImportContext = Pick<
  ToolContext,
  'userId' | 'db' | 'integrations' | 'logger'
> & { signal?: AbortSignal };

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Meet entries into the `SpeechTurn` shape the transcript chunker already
 * speaks, with offsets relative to the start of the conference.
 *
 * ON MISSING TIMESTAMPS. Meet stamps `startTime`/`endTime` on transcript
 * entries in practice, but both are optional in the API surface and an entry
 * without them must not poison the whole document's offsets. When one is
 * missing the entry is placed at the running cursor — where the previous
 * utterance ended — which keeps offsets monotonic and puts the line within one
 * turn of where it actually happened. If NOTHING in the transcript carries a
 * time (and no conference start is known), every offset collapses to 0 and the
 * document is still perfectly searchable; it just cannot be cited to the minute.
 *
 * Consecutive entries from the same participant are merged, because Meet emits
 * one entry per utterance fragment and a sentence routinely spans three of them.
 */
export function buildSpeechTurns(
  entries: TranscriptEntry[],
  speakerNames: Map<string, string>,
  opts: { originMs?: number | null } = {},
): SpeechTurn[] {
  const firstStamped = entries.find((e) => e.startTime != null);
  const origin = opts.originMs ?? parseMs(firstStamped?.startTime) ?? null;

  const turns: SpeechTurn[] = [];
  let cursor = 0;

  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) continue;

    const speaker =
      (entry.participant ? speakerNames.get(entry.participant) : null) ?? UNKNOWN_SPEAKER;

    const absStart = parseMs(entry.startTime);
    const absEnd = parseMs(entry.endTime);
    const startMs = absStart != null && origin != null ? Math.max(0, absStart - origin) : cursor;
    const endMs = absEnd != null && origin != null ? Math.max(startMs, absEnd - origin) : startMs;
    cursor = Math.max(cursor, endMs);

    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${text}`;
      previous.endMs = Math.max(previous.endMs, endMs);
      continue;
    }
    turns.push({ speaker, startMs, endMs, text });
  }

  return turns;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string | null {
  const ms = parseMs(iso);
  if (ms == null) return null;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

/**
 * The first chunk of the document, and the reason the transcript is citable on
 * its own terms.
 *
 * A retrieved chunk of conversation says "Ana: yes, we can do the 15th" and
 * nothing else — not which meeting, not which client, not when. This header is
 * indexed as its own chunk so that "the Acme call in March" finds the meeting
 * itself, and so anything that shows a document's first chunk as a preview
 * shows something worth reading.
 */
export function buildHeader(input: {
  title: string;
  meetingCode: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  participants: string[];
  conferenceRecord: string;
}): string {
  const when = formatDate(input.startedAt);
  const minutes = input.durationSeconds != null ? Math.round(input.durationSeconds / 60) : null;

  const facts = [
    'Google Meet',
    when,
    minutes != null ? `${minutes} min` : null,
    input.participants.length
      ? `${input.participants.length} participant${input.participants.length === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean) as string[];

  return [
    `# ${input.title}`,
    facts.join(' · '),
    input.participants.length
      ? `Who was there: ${input.participants.join(', ')}`
      : 'Who was there: not reported by Google Meet.',
    input.meetingCode ? `Meeting code: ${input.meetingCode}` : null,
    `Meet conference record: ${input.conferenceRecord}`,
    '',
    'What follows is the transcript of the conversation, in order, with the speaker and the time into the call.',
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

/**
 * Header chunk + one chunk per span of conversation, numbered in reading order.
 *
 * The conversation chunks come from `chunkTranscript`, the same function 0058's
 * audio ingestion uses, so `{speaker, speakers, startMs, endMs}` means exactly
 * the same thing whether the words arrived from Deepgram or from Meet.
 */
export function buildChunks(header: string, turns: SpeechTurn[]): PreparedChunk[] {
  const body = chunkTranscript(turns);

  const chunks: PreparedChunk[] = [
    {
      content: header,
      chunkIndex: 0,
      tokens: approxTokens(header),
      // No `speaker`: nobody said this, so attributing it to a participant
      // would put words in someone's mouth in a citation. The zero offsets are
      // true — it describes the call from its start.
      metadata: { kind: 'meeting_header', startMs: 0, endMs: 0 },
    },
  ];

  for (const chunk of body) {
    chunks.push({
      content: chunk.content,
      chunkIndex: chunks.length,
      tokens: chunk.tokens,
      metadata: { ...chunk.metadata },
    });
  }

  return chunks;
}

/** The plain text the document's sha256 is taken over. */
function fullText(chunks: PreparedChunk[]): string {
  return chunks.map((c) => c.content).join('\n\n');
}

// ---------------------------------------------------------------------------
// Where it lands
// ---------------------------------------------------------------------------

/**
 * WHICH SPACE A TRANSCRIPT GOES INTO — the one decision in this file that can
 * hurt someone if it is wrong.
 *
 * The default is the importer's OWN personal space, never a company-wide one.
 *
 * A meeting transcript is the least consented-to document this product handles.
 * Nobody on that call chose to publish it; several of them are usually not
 * employees at all. It routinely contains a client's internal politics, a
 * salary, a candidate's reason for leaving, an off-hand remark someone would
 * never put in writing. A global space is read by everyone in the org AND
 * answered from by everyone's Cortex, so filing a client call there by default
 * would mean an automated cron job publishing a client's confidences to the
 * whole company at 3am, on a schedule, with nobody in the loop.
 *
 * The asymmetry is the argument, and it is the same one `ensurePersonalSpace`
 * makes for saved notes: a transcript that should have been shared is one drag
 * into another space away, while a transcript that should have stayed private
 * and was not cannot be un-read. The importer was in the room (they are the
 * Google account whose credentials fetched it), so their own space is also the
 * least surprising place to look for it.
 *
 * Sharing stays possible and stays deliberate: pass a space name. That path goes
 * through `assertCanWriteToSpace`, which already refuses a global space to
 * anyone who is not an org admin — so "publish this call to the whole company"
 * requires both an explicit request and the authority to make it.
 *
 * RE-IMPORTS DO NOT MOVE ANYTHING. If someone has already filed a transcript
 * into a shared space, the next sweep must not drag it back to the importer's
 * private one. The caller passes `currentSpaceId` for exactly this: an existing
 * document keeps its space unless a new one is named on purpose.
 */
async function resolveDestination(
  ctx: MeetingImportContext,
  opts: { spaceId?: string; spaceName?: string; currentSpaceId?: string | null },
): Promise<{ id: string; name: string }> {
  if (opts.spaceId) {
    const space = await assertCanWriteToSpace(ctx.db, ctx.userId, opts.spaceId);
    return { id: space.id, name: space.name };
  }

  if (opts.spaceName?.trim()) {
    const space = await resolveSpaceByName(ctx.db, ctx.userId, opts.spaceName.trim());
    if (!space) {
      throw new Error(
        `There is no space called "${opts.spaceName}" that you can write to. Leave it out to file the meeting in your own space.`,
      );
    }
    await assertCanWriteToSpace(ctx.db, ctx.userId, space.id);
    return { id: space.id, name: space.name };
  }

  if (opts.currentSpaceId) {
    // Already filed somewhere, possibly deliberately moved. Keep it there.
    const { data } = await ctx.db
      .from('kb_collections')
      .select('id, name')
      .eq('id', opts.currentSpaceId)
      .maybeSingle();
    if (data) return { id: data.id as string, name: data.name as string };
  }

  return ensurePersonalSpace(ctx.db, ctx.userId);
}

// ---------------------------------------------------------------------------
// Resolving which conference to import
// ---------------------------------------------------------------------------

interface ResolvedConference {
  record: ConferenceRecord;
  transcriptName: string;
  meetingCode: string | null;
}

/**
 * Best-effort human title from the calendar.
 *
 * Deliberately swallows every failure. The Meet scope alone is enough to read
 * and store a call; `calendar.readonly` only buys a nicer name than "Meet
 * abc-defg-hij". Making the import depend on it would mean a workspace that
 * granted one scope and not the other silently remembers nothing.
 */
async function resolveCalendarTitle(
  ctx: MeetingImportContext,
  meetingCode: string | null,
  startedAt: string | null,
): Promise<string | null> {
  const startMs = parseMs(startedAt);
  if (!meetingCode || startMs == null) return null;

  try {
    const events = await fetchEventsInRange(ctx as ToolContext, {
      calendarId: 'primary',
      timeMin: new Date(startMs - 12 * 3_600_000).toISOString(),
      timeMax: new Date(startMs + 12 * 3_600_000).toISOString(),
      maxResults: 50,
    });
    const match = events.find((e) => parseMeetCode(e) === meetingCode);
    return match?.summary?.trim() || null;
  } catch {
    return null;
  }
}

/** The first sitting (newest first) that actually produced a transcript. */
async function resolveConference(
  ctx: MeetingImportContext,
  opts: ImportMeetingOptions,
): Promise<ResolvedConference | { unavailable: string }> {
  const meetCtx = ctx as ToolContext;

  if (opts.conferenceRecord) {
    const record = await getConferenceRecord(meetCtx, opts.conferenceRecord);
    if (!record) {
      return {
        unavailable: `Google Meet has no record of ${opts.conferenceRecord} any more. Meet only keeps conference records for a limited time, so a call from long ago may simply have aged out.`,
      };
    }
    const transcript = pickTranscript(await listTranscripts(meetCtx, record.name));
    if (!transcript) {
      return { unavailable: notEnabledNote() };
    }
    const meetingCode = record.space ? await fetchSpaceMeetingCode(meetCtx, record.space) : null;
    return { record, transcriptName: transcript.name, meetingCode };
  }

  const meetingCode = opts.meetCode?.trim().toLowerCase();
  if (!meetingCode) {
    return { unavailable: 'No meeting was named — give it a Meet code or a conference record.' };
  }

  const lookbackDays = opts.lookbackDays ?? 30;
  const records = await listConferenceRecords(meetCtx, {
    meetingCode,
    startAfter: new Date(Date.now() - lookbackDays * 86_400_000),
    pageSize: 25,
  });
  if (records.length === 0) {
    return {
      unavailable: `No Google Meet session ran under ${meetingCode} in the last ${lookbackDays} days, so there is nothing to remember yet.`,
    };
  }

  // Newest first; the first sitting with a finished transcript wins.
  for (const record of records.slice(0, 5)) {
    const transcript = pickTranscript(await listTranscripts(meetCtx, record.name));
    if (transcript) return { record, transcriptName: transcript.name, meetingCode };
  }
  return { unavailable: notEnabledNote() };
}

function notEnabledNote(): string {
  return 'That meeting happened but Google wrote no transcript for it, so there is nothing to store. Meet only transcribes when someone turns transcription (or recording with transcript) on during the call, and it can take a few minutes to appear after the call ends.';
}

/** Google saying "no" is a permission problem, not a bug — say which. */
function isAuthFailure(err: unknown): boolean {
  if (err instanceof IntegrationError) return true;
  const message = err instanceof Error ? err.message : '';
  return /\b(401|403)\b/.test(message) || /no google integration/i.test(message);
}

const UNAUTHORIZED_NOTE =
  'Google would not let me read that meeting. The connected Google account needs permission to read Meet recordings (the "meetings.space.readonly" scope) — reconnecting Google from the integrations page usually fixes it. Nothing was imported and nothing was lost.';

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

function emptyResult(outcome: MeetingImportOutcome, note: string): MeetingImportResult {
  return {
    outcome,
    note,
    conferenceRecord: null,
    meetingCode: null,
    title: null,
    documentId: null,
    spaceId: null,
    spaceName: null,
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    participants: [],
    chunks: 0,
    turns: 0,
  };
}

/**
 * Import one Google Meet conference into the Knowledge Base.
 *
 * IDEMPOTENT BY SCHEMA, not by good intentions. `meeting_imports` has a unique
 * index on the conference record (migration 0059), and this function looks the
 * row up before doing anything: an already-imported conference reuses its
 * `kb_documents` row, replaces its chunks in place, and — when the transcript
 * has not changed at all — does not even spend the embedding calls. Running the
 * cron sweep every half hour over the same two days is therefore free after the
 * first pass, which is what makes the sweep safe to run at all.
 */
export async function importMeetingTranscript(
  ctx: MeetingImportContext,
  opts: ImportMeetingOptions = {},
): Promise<MeetingImportResult> {
  const meetCtx = ctx as ToolContext;
  const db = ctx.db;

  let resolved: ResolvedConference | { unavailable: string };
  let participants: MeetParticipant[];
  let entries: TranscriptEntry[];

  // Everything that talks to Google lives in this one try: a revoked scope, a
  // lapsed refresh token and a Meet outage all present as a thrown fetch, and
  // all three deserve "reconnect Google", not a stack trace in a chat bubble.
  try {
    resolved = await resolveConference(ctx, opts);
    if ('unavailable' in resolved) return emptyResult('unavailable', resolved.unavailable);

    participants = await listParticipants(meetCtx, resolved.record.name);
    entries = await fetchTranscriptEntries(meetCtx, {
      transcriptName: resolved.transcriptName,
      maxEntries: MAX_ENTRIES,
    });
  } catch (err) {
    if (isAuthFailure(err)) {
      ctx.logger.warn(
        { err: (err as Error).message },
        'meetings.import_transcript: Google refused',
      );
      return emptyResult('unauthorized', UNAUTHORIZED_NOTE);
    }
    ctx.logger.error(
      { err: (err as Error).message },
      'meetings.import_transcript: Meet lookup failed',
    );
    return emptyResult(
      'unavailable',
      'Google Meet could not be reached just now, so the meeting was not imported. Nothing was lost — it will be picked up on the next sweep.',
    );
  }

  const { record, meetingCode } = resolved;
  const conferenceRecord = record.name;

  const speakerNames = new Map<string, string>();
  for (const p of participants) {
    if (p.displayName) speakerNames.set(p.name, p.displayName);
  }
  const participantNames = [
    ...new Set(participants.map((p) => p.displayName).filter(Boolean)),
  ] as string[];

  const turns = buildSpeechTurns(entries, speakerNames, {
    originMs: parseMs(record.startTime),
  });
  if (turns.length === 0) {
    return {
      ...emptyResult(
        'unavailable',
        'Google has a transcript for that meeting but it came back empty — Meet is probably still finishing it. It will be picked up on the next sweep.',
      ),
      conferenceRecord,
      meetingCode: meetingCode ?? null,
    };
  }

  // Duration from the conference record when Meet reports both ends; otherwise
  // from the transcript itself, which is a floor rather than a guess.
  const startMs = parseMs(record.startTime);
  const endMs = parseMs(record.endTime);
  const durationSeconds =
    startMs != null && endMs != null && endMs > startMs
      ? Math.round((endMs - startMs) / 1000)
      : Math.round((turns[turns.length - 1]?.endMs ?? 0) / 1000) || null;

  // Look the ledger up BEFORE writing anything: it decides whether this is a
  // create or an update, and which document/space to reuse.
  const { data: ledgerRow } = await db
    .from('meeting_imports')
    .select('id, document_id')
    .eq('conference_record', conferenceRecord)
    .maybeSingle();

  const existingDocumentId = (ledgerRow?.document_id as string | null) ?? null;
  let currentSpaceId: string | null = null;
  let currentSha: string | null = null;
  let documentId: string | null = null;

  if (existingDocumentId) {
    const { data: docRow } = await db
      .from('kb_documents')
      .select('id, collection_id, sha256, status')
      .eq('id', existingDocumentId)
      .maybeSingle();
    if (docRow) {
      documentId = docRow.id as string;
      currentSpaceId = docRow.collection_id as string;
      // A document mid-failure has to be rebuilt even if the text is identical.
      currentSha = docRow.status === 'ready' ? ((docRow.sha256 as string | null) ?? null) : null;

      // A conference has exactly one document (the unique index says so), and
      // two people who were both on the call will both sweep it. Whoever
      // imported it first owns where it lives — which is very often their
      // PRIVATE space. Without this check the second sweep would happily
      // rewrite a document sitting in someone else's personal space, which is
      // the one thing spaces exist to prevent.
      const writable = await assertCanWriteToSpace(db, ctx.userId, currentSpaceId).then(
        () => true,
        () => false,
      );
      if (!writable) {
        return {
          ...emptyResult(
            'unchanged',
            'Somebody else who was on that call has already saved it, into a space you cannot write to. It was left exactly as they filed it — ask them to move it if the whole team should be able to ask about it.',
          ),
          conferenceRecord,
          meetingCode: meetingCode ?? null,
          participants: participantNames,
          startedAt: record.startTime ?? null,
          endedAt: record.endTime ?? null,
          durationSeconds,
          turns: turns.length,
        };
      }
    }
  }

  const titleFromCalendar = opts.skipCalendarTitle
    ? null
    : await resolveCalendarTitle(ctx, meetingCode ?? null, record.startTime ?? null);
  const title =
    titleFromCalendar ??
    (meetingCode
      ? `Meet ${meetingCode}${formatDate(record.startTime ?? null) ? ` — ${formatDate(record.startTime ?? null)}` : ''}`
      : `Meeting on ${formatDate(record.startTime ?? null) ?? 'an unknown date'}`);

  const header = buildHeader({
    title,
    meetingCode: meetingCode ?? null,
    startedAt: record.startTime ?? null,
    durationSeconds,
    participants: participantNames,
    conferenceRecord,
  });
  const chunks = buildChunks(header, turns);
  const sha256 = createHash('sha256').update(fullText(chunks)).digest('hex');

  const base = {
    conferenceRecord,
    meetingCode: meetingCode ?? null,
    title,
    startedAt: record.startTime ?? null,
    endedAt: record.endTime ?? null,
    durationSeconds,
    participants: participantNames,
    turns: turns.length,
  };

  let destination: { id: string; name: string };
  try {
    destination = await resolveDestination(ctx, {
      ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
      ...(opts.spaceName ? { spaceName: opts.spaceName } : {}),
      currentSpaceId,
    });
  } catch (err) {
    return {
      ...base,
      outcome: 'failed',
      note: (err as Error).message,
      documentId,
      spaceId: null,
      spaceName: null,
      chunks: 0,
    };
  }

  // Nothing has changed since the last import: no chunk churn, no embedding
  // spend, no status flicker on a document somebody is reading right now.
  if (documentId && currentSha === sha256) {
    if (destination.id === currentSpaceId) {
      return {
        ...base,
        outcome: 'unchanged',
        note: `That meeting is already in ${destination.name} and the transcript has not changed, so nothing was re-indexed.`,
        documentId,
        spaceId: destination.id,
        spaceName: destination.name,
        chunks: 0,
      };
    }
    // Same words, new home: a move is a one-column update, not a re-embed.
    await db.from('kb_documents').update({ collection_id: destination.id }).eq('id', documentId);
    return {
      ...base,
      outcome: 'updated',
      note: `That meeting was already saved, so it was moved to ${destination.name} rather than imported again.`,
      documentId,
      spaceId: destination.id,
      spaceName: destination.name,
      chunks: 0,
    };
  }

  const documentFields = {
    collection_id: destination.id,
    source: 'meeting',
    source_ref: conferenceRecord,
    title,
    mime: 'text/markdown',
    sha256,
    uploaded_by: ctx.userId,
    status: 'pending',
    error_message: null,
    // 0058's provenance columns, used for what they were defined for: the date
    // an answer should cite, how long the conversation ran, and who was in it.
    // `media_kind: 'meeting'` (0059) keeps it out of the transcription worker —
    // there are no bytes here, Google already did the transcribing.
    media_kind: 'meeting',
    recorded_at: record.startTime ?? null,
    duration_seconds: durationSeconds,
    speakers: participantNames,
    transcript_status: 'ready',
    transcript_error: null,
  };

  try {
    if (documentId) {
      const { error } = await db.from('kb_documents').update(documentFields).eq('id', documentId);
      if (error) throw new Error(error.message);
      // Replace rather than diff: chunk boundaries move when a transcript is
      // re-read, so index N is not the same passage it was last time.
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
        // Same trade as `ingestMarkdown`: a deployment with no embedding key
        // still keeps the conversation, findable by keyword, rather than losing
        // a meeting because of a missing environment variable.
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

    await recordImport(db, {
      conferenceRecord,
      meetingCode: meetingCode ?? null,
      spaceName: record.space ?? null,
      title,
      startedAt: record.startTime ?? null,
      endedAt: record.endTime ?? null,
      participants: participantNames,
      documentId,
      importedBy: ctx.userId,
      status: 'ready',
      error: embedded.ok ? null : embedded.reason,
    });

    const outcome: MeetingImportOutcome = existingDocumentId ? 'updated' : 'imported';
    return {
      ...base,
      outcome,
      note: embedded.ok
        ? `${outcome === 'updated' ? 'Refreshed' : 'Imported'} "${title}" into ${destination.name}: ${turns.length} speaking turns across ${chunks.length} searchable passages, each tagged with who said it and how far into the call.`
        : `"${title}" was stored in ${destination.name} but could not be indexed by meaning: ${embedded.reason} It is still findable by keyword.`,
      documentId,
      spaceId: destination.id,
      spaceName: destination.name,
      chunks: chunks.length,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (documentId) {
      await db
        .from('kb_documents')
        .update({ status: 'failed', error_message: message, transcript_error: message })
        .eq('id', documentId);
    }
    // Recorded as failed rather than not recorded at all: the sweep retries a
    // failed row, and an operator can see that the attempt happened. If even
    // this fails there is nothing useful left to do — the caller is already
    // being told the import did not work.
    await recordImport(db, {
      conferenceRecord,
      meetingCode: meetingCode ?? null,
      spaceName: record.space ?? null,
      title,
      startedAt: record.startTime ?? null,
      endedAt: record.endTime ?? null,
      participants: participantNames,
      documentId,
      importedBy: ctx.userId,
      status: 'failed',
      error: message,
    }).catch((ledgerErr: unknown) => {
      ctx.logger.error(
        { err: (ledgerErr as Error).message, conferenceRecord },
        'meetings.import_transcript: could not record the failed import',
      );
    });
    ctx.logger.error(
      { err: message, conferenceRecord },
      'meetings.import_transcript: ingest failed',
    );

    return {
      ...base,
      outcome: 'failed',
      note: `The transcript of "${title}" was read but could not be stored: ${message}`,
      documentId,
      spaceId: destination.id,
      spaceName: destination.name,
      chunks: 0,
    };
  }
}

/** Upsert on the unique conference record — the schema's idempotency, used. */
async function recordImport(
  db: MeetingImportContext['db'],
  row: {
    conferenceRecord: string;
    meetingCode: string | null;
    spaceName: string | null;
    title: string;
    startedAt: string | null;
    endedAt: string | null;
    participants: string[];
    documentId: string | null;
    importedBy: string;
    status: 'ready' | 'failed';
    error: string | null;
  },
): Promise<void> {
  const { error } = await db.from('meeting_imports').upsert(
    {
      conference_record: row.conferenceRecord,
      meeting_code: row.meetingCode,
      space_name: row.spaceName,
      title: row.title,
      started_at: row.startedAt,
      ended_at: row.endedAt,
      participants: row.participants,
      document_id: row.documentId,
      imported_by: row.importedBy,
      imported_at: new Date().toISOString(),
      status: row.status,
      error: row.error,
    },
    { onConflict: 'conference_record' },
  );
  // Deliberately fatal on the success path. The ledger row is what stops the
  // next sweep importing this conference a second time, so losing it silently
  // would trade one visible failure for an unbounded pile of duplicates.
  if (error) {
    throw new Error(`meeting_imports upsert failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const meetingsImportTranscript = registerTool({
  id: 'meetings.import_transcript',
  description:
    'Save a past Google Meet call into the Knowledge Base for good, so it can be searched and quoted months later. Use it whenever a call is worth remembering — a client agreeing to something, a decision nobody wrote down, a handover — or when someone asks you to "remember this meeting", "file that call" or "add the transcript to the knowledge base". It stores the conversation split by speaking turn, each passage tagged with who said it and how far into the call, so later answers can cite the person and the minute. It files the meeting in the caller\'s own private space unless another space is named. Do NOT use it just to read or summarise a call — `meetings.get_transcript` does that without storing anything. Running it twice on the same meeting updates the saved copy instead of making a second one.',
  inputSchema: z
    .object({
      meetCode: z
        .string()
        .optional()
        .describe(
          'The Meet code from the invite link, e.g. "abc-defg-hij". The usual way to name a meeting.',
        ),
      conferenceRecord: z
        .string()
        .optional()
        .describe(
          'The exact Meet conference record ("conferenceRecords/xxx") when one specific sitting is meant — from a previous listing, not something to invent.',
        ),
      lookbackDays: z
        .number()
        .int()
        .min(1)
        .max(180)
        .default(30)
        .describe('How far back to search for a session of this meeting code.'),
      spaceName: z
        .string()
        .optional()
        .describe(
          "Knowledge Base space to file it in, by name. Leave empty to keep it in the caller's own private space — only pass this when the person explicitly asked to share the meeting somewhere, since a company space is readable by everyone.",
        ),
    })
    .refine((v) => Boolean(v.meetCode || v.conferenceRecord), {
      message: 'Name the meeting with its Meet code or a conference record.',
    }),
  outputSchema: z.object({
    outcome: z.enum(['imported', 'updated', 'unchanged', 'unavailable', 'unauthorized', 'failed']),
    note: z.string(),
    documentId: z.string().nullable(),
    space: z.string().nullable(),
    title: z.string().nullable(),
    meetingCode: z.string().nullable(),
    conferenceRecord: z.string().nullable(),
    startedAt: z.string().nullable(),
    durationMinutes: z.number().nullable(),
    participants: z.array(z.string()),
    passages: z.number(),
    speakingTurns: z.number(),
    guidance: z.string(),
  }),
  requiredScopes: [{ provider: 'google', scopes: [MEET_READONLY_SCOPE] }],
  // Each run can mean thousands of embedding calls; this is not a tool to loop.
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const result = await importMeetingTranscript(ctx, {
      ...(input.meetCode ? { meetCode: input.meetCode } : {}),
      ...(input.conferenceRecord ? { conferenceRecord: input.conferenceRecord } : {}),
      ...(input.spaceName ? { spaceName: input.spaceName } : {}),
      lookbackDays: input.lookbackDays ?? 30,
    });

    const guidance = ((): string => {
      switch (result.outcome) {
        case 'imported':
        case 'updated':
          return `The meeting is now part of what Cortex knows. Ask about it by what was discussed, not by its filename — searching the Knowledge Base will return the exact passage with the speaker and the offset. It is in ${result.spaceName ?? 'the space it was filed in'}, which ${result.spaceName === null ? 'may be private' : 'is where it can be read from'}; to let the whole company ask about it, move it to a company space on the Knowledge Base page.`;
        case 'unchanged':
          return 'Already saved and unchanged, so nothing was re-indexed. Search the Knowledge Base to quote from it.';
        case 'unavailable':
          return 'Nothing was stored and nothing broke. If the call has only just finished, try again in a few minutes; if transcription was never switched on, there is genuinely nothing to save and the notes would have to come from a person.';
        case 'unauthorized':
          return 'This is a permissions problem, not a missing meeting. Do not retry — tell the person to reconnect Google with permission to read Meet recordings.';
        default:
          return 'The transcript was read but not stored. The attempt was recorded, so the next automatic sweep will try again; there is no need to run this repeatedly.';
      }
    })();

    return {
      outcome: result.outcome,
      note: result.note,
      documentId: result.documentId,
      space: result.spaceName,
      title: result.title,
      meetingCode: result.meetingCode,
      conferenceRecord: result.conferenceRecord,
      startedAt: result.startedAt,
      durationMinutes:
        result.durationSeconds != null ? Math.round(result.durationSeconds / 60) : null,
      participants: result.participants,
      passages: result.chunks,
      speakingTurns: result.turns,
      guidance,
    };
  },
});
