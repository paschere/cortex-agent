import { createHash } from 'node:crypto';
import { parseMeetCode } from '../gcal/events';
import { approxTokens } from '../kb/chunker';
import { embedDocuments } from '../kb/embedder';
import { recordEmbeddingUsage } from '../kb/embedding-usage';
import { ensurePersonalSpace } from '../kb/spaces';
import type { SpeechTurn } from '../kb/transcribe';
import { type LiveInsights, analyzeLiveCall, emptyInsights } from './analyze-live';
import { buildChunks } from './import-transcript';
import type { MeetingImportContext } from './import-transcript';
import { type CallEvent, formatTimelineForPrompt, normalizeTimeline } from './timeline';

/**
 * Keeping a live call after Cortex hangs up.
 *
 * The meet-bot holds the transcript in RAM and forgets the sitting ~30 s after
 * it ends. This module is the other half of that sentence: write the people and
 * the lines to `live_calls` (what Llamadas replays) and, when there is anything
 * to search, file the same conversation into Brain Knowledge the way a Google
 * Meet import does — same chunks, same speaker metadata — so "qué acordamos
 * ayer" does not depend on Google having turned transcription on.
 *
 * Idempotent on (organization, session_id): a retry from the bot updates the
 * sitting instead of doubling it.
 */

export interface LiveLine {
  text: string;
  speaker: string | null;
  at: number;
}

export interface LivePerson {
  id: string;
  name: string;
  self?: boolean;
}

export interface ArchiveLiveInput {
  sessionId: string;
  meetUrl: string;
  botName?: string | null;
  userId?: string | null;
  startedAt: number;
  endedAt?: number | null;
  status: 'ended' | 'failed';
  detail?: string | null;
  participants: LivePerson[];
  transcript: LiveLine[];
  source?: 'live' | 'upload';
  timeline?: CallEvent[];
  recordingPath?: string | null;
  recordingContentType?: string | null;
}

export interface ArchiveLiveResult {
  callId: string;
  documentId: string | null;
  title: string;
  lines: number;
  note: string;
}

const LIVE_RECORD_PREFIX = 'liveSessions/';

export function liveConferenceRecord(sessionId: string): string {
  return `${LIVE_RECORD_PREFIX}${sessionId}`;
}

/**
 * Deepgram's `at` is seconds from the start of the stream. Consecutive lines
 * from the same speaker merge the way Meet's own entries do in `buildSpeechTurns`.
 */
export function linesToTurns(lines: LiveLine[]): SpeechTurn[] {
  const turns: SpeechTurn[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(line.at * 1000));
    const speaker = line.speaker?.trim() || 'Alguien';
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${text}`;
      previous.endMs = Math.max(previous.endMs, startMs);
      continue;
    }
    turns.push({ speaker, startMs, endMs: startMs, text });
  }
  for (let i = 0; i < turns.length - 1; i++) {
    const current = turns[i];
    const next = turns[i + 1];
    if (current && next && next.startMs > current.endMs) current.endMs = next.startMs;
  }
  return turns;
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat('es-CO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

function liveHeader(input: {
  title: string;
  meetingCode: string | null;
  startedAt: string;
  durationSeconds: number | null;
  participants: string[];
  sessionId: string;
}): string {
  const minutes = input.durationSeconds != null ? Math.round(input.durationSeconds / 60) : null;
  const facts = [
    'Google Meet · Cortex en vivo',
    formatWhen(Date.parse(input.startedAt)),
    minutes != null ? `${minutes} min` : null,
    input.participants.length
      ? `${input.participants.length} participante${input.participants.length === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean) as string[];

  return [
    `# ${input.title}`,
    facts.join(' · '),
    input.participants.length
      ? `Who was there: ${input.participants.join(', ')}`
      : 'Who was there: not reported.',
    input.meetingCode ? `Meeting code: ${input.meetingCode}` : null,
    `Live session: ${input.sessionId}`,
    '',
    'What follows is the transcript Cortex heard in the call, in order, with the speaker and the time into the call. Visual events (who shared, what was on screen) sit in the header when we have them.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * La lectura de Cortex va DELANTE del transcript en el documento del Brain:
 * es lo que una búsqueda debe encontrar primero («qué acordamos con Acme»),
 * antes que la frase suelta donde se dijo.
 */
function withTimeline(header: string, events: CallEvent[]): string {
  const visual = events.filter(
    (e) => e.kind === 'presenting' || e.kind === 'presenting-end' || e.caption,
  );
  if (visual.length === 0) return header;
  return `${header}\n\n## Lo que pasó en pantalla\n${formatTimelineForPrompt(visual)}`;
}

function withInsights(header: string, insights: LiveInsights | null): string {
  if (!insights || !insights.summary) return header;
  const block = [
    '',
    '## Lo que Cortex sacó de la reunión',
    insights.summary,
    insights.decisions.length ? `Decisiones: ${insights.decisions.join(' · ')}` : null,
    insights.commitments.length
      ? `Compromisos: ${insights.commitments
          .map((c) => `${c.who} — ${c.what}${c.when ? ` (${c.when})` : ''}`)
          .join(' · ')}`
      : null,
    insights.nextSteps.length ? `Próximos pasos: ${insights.nextSteps.join(' · ')}` : null,
    insights.openQuestions.length ? `Abierto: ${insights.openQuestions.join(' · ')}` : null,
  ].filter((l) => l !== null);
  return `${header}\n${block.join('\n')}`;
}

function fullText(chunks: Array<{ content: string }>): string {
  return chunks.map((c) => c.content).join('\n\n');
}

export async function archiveLiveMeeting(
  ctx: MeetingImportContext,
  input: ArchiveLiveInput,
): Promise<ArchiveLiveResult> {
  const sessionId = input.sessionId.trim();
  const meetCode = parseMeetCode({ hangoutLink: input.meetUrl });
  const startedAt = new Date(input.startedAt).toISOString();
  const endedAt = input.endedAt ? new Date(input.endedAt).toISOString() : new Date().toISOString();
  const title = meetCode
    ? `Meet ${meetCode} — ${formatWhen(input.startedAt)}`
    : `Reunión — ${formatWhen(input.startedAt)}`;
  const names = [
    ...new Set(input.participants.map((p) => p.name.trim()).filter((n) => n.length > 0)),
  ];
  const finals = input.transcript.filter((l) => l.text.trim().length > 0);
  const timeline = normalizeTimeline(input.timeline);

  const { data: saved, error: saveErr } = await ctx.db
    .from('live_calls')
    .upsert(
      {
        session_id: sessionId,
        meet_url: input.meetUrl,
        meet_code: meetCode,
        title,
        bot_name: input.botName ?? null,
        user_id: input.userId ?? ctx.userId,
        started_at: startedAt,
        ended_at: endedAt,
        status: input.status,
        detail: input.detail ?? null,
        participants: input.participants,
        transcript: finals,
        source: input.source ?? 'live',
        timeline,
        recording_path: input.recordingPath ?? null,
        recording_content_type: input.recordingContentType ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,session_id' },
    )
    .select('id, document_id')
    .single();

  if (saveErr || !saved) {
    throw new Error(saveErr?.message ?? 'No se pudo guardar la llamada.');
  }

  const callId = saved.id as string;
  let documentId = (saved.document_id as string | null) ?? null;

  const turns = linesToTurns(finals);
  if (turns.length === 0) {
    await ctx.db
      .from('live_calls')
      .update({
        insights: emptyInsights('No hubo nada que transcribir.'),
        analyzed_at: new Date().toISOString(),
        brain_status: 'skipped',
        brain_reason: 'No hubo nada que transcribir.',
        brain_decided_by: 'cortex',
      })
      .eq('id', callId);
    return {
      callId,
      documentId,
      title,
      lines: 0,
      note: 'La llamada se guardó, pero no hubo nada que transcribir.',
    };
  }

  // LA LECTURA. Cortex lee la llamada una vez: título, resumen, decisiones,
  // compromisos y un veredicto sobre si merece quedar en la memoria de la
  // empresa. Si el modelo falla, la llamada queda guardada con el título
  // genérico y «por decidir» — nunca se pierde la conversación por un resumen.
  let insights: LiveInsights | null = null;
  try {
    insights = await analyzeLiveCall({
      lines: finals,
      participants: input.participants,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? Date.now(),
      botName: input.botName,
      timeline,
    });
  } catch (err) {
    ctx.logger.warn(
      { err: (err as Error).message, sessionId },
      'archiveLiveMeeting: analysis failed',
    );
  }

  const finalTitle = insights?.title ? insights.title : title;
  if (insights) {
    const { error } = await ctx.db
      .from('live_calls')
      .update({
        title: finalTitle,
        insights,
        analyzed_at: new Date().toISOString(),
      })
      .eq('id', callId);
    if (error)
      ctx.logger.warn({ err: error.message }, 'archiveLiveMeeting: could not save insights');
  }

  // Una lectura que decidió que no vale la pena: queda fuera, con su razón,
  // y la persona puede darle la vuelta desde Llamadas.
  if (insights && !insights.worthKeeping) {
    await ctx.db
      .from('live_calls')
      .update({
        brain_status: 'skipped',
        brain_reason: insights.reason,
        brain_decided_by: 'cortex',
      })
      .eq('id', callId);
    return {
      callId,
      documentId,
      title: finalTitle,
      lines: finals.length,
      note: `Guardé "${finalTitle}" (${finals.length} frases) en Llamadas. No la puse en Brain Knowledge: ${insights.reason}`,
    };
  }

  // Sin lectura (el modelo falló) no decidimos por la persona: queda
  // «por decidir» y no se indexa. Con lectura favorable, al Brain.
  if (!insights) {
    return {
      callId,
      documentId,
      title: finalTitle,
      lines: finals.length,
      note: `Guardé "${finalTitle}" (${finals.length} frases). No pude analizarla; decide en Llamadas si va al Brain.`,
    };
  }

  try {
    documentId = await fileInKnowledgeBase(ctx, {
      callId,
      documentId,
      sessionId,
      meetCode,
      title: finalTitle,
      startedAt,
      endedAt,
      names,
      turns,
      insights,
      timeline,
      userId: input.userId ?? ctx.userId,
    });
    await ctx.db
      .from('live_calls')
      .update({ brain_status: 'kept', brain_reason: insights.reason, brain_decided_by: 'cortex' })
      .eq('id', callId);
  } catch (err) {
    ctx.logger.error(
      { err: (err as Error).message, sessionId },
      'archiveLiveMeeting: Brain Knowledge ingest failed; the call row was kept',
    );
    return {
      callId,
      documentId,
      title: finalTitle,
      lines: finals.length,
      note: `La llamada se guardó. No pude indexarla en Brain Knowledge: ${(err as Error).message}`,
    };
  }

  return {
    callId,
    documentId,
    title: finalTitle,
    lines: finals.length,
    note: `Guardé "${finalTitle}" (${finals.length} frases) y la puse en Brain Knowledge: ${insights.reason}`,
  };
}

type LiveCallRow = {
  id: string;
  session_id: string;
  meet_code: string | null;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  participants: LivePerson[] | null;
  transcript: LiveLine[] | null;
  insights: LiveInsights | null;
  document_id: string | null;
  user_id: string | null;
  timeline?: CallEvent[] | null;
};

const ROW_COLS =
  'id, session_id, meet_code, title, started_at, ended_at, participants, transcript, insights, document_id, user_id, timeline';

async function loadCall(ctx: MeetingImportContext, callId: string): Promise<LiveCallRow> {
  const { data, error } = await ctx.db
    .from('live_calls')
    .select(ROW_COLS)
    .eq('id', callId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Esa llamada no está guardada.');
  return data as unknown as LiveCallRow;
}

/**
 * La persona le da la vuelta al veredicto: «sí, guárdala». Indexa el
 * transcript en Brain Knowledge (idempotente por sha) y deja constancia de
 * que lo decidió una persona.
 */
export async function keepLiveCallInBrain(
  ctx: MeetingImportContext,
  callId: string,
): Promise<{ documentId: string }> {
  const row = await loadCall(ctx, callId);
  const finals = (row.transcript ?? []).filter((l) => l.text.trim().length > 0);
  const turns = linesToTurns(finals);
  if (turns.length === 0) throw new Error('No hay nada transcrito que guardar.');
  const names = [...new Set((row.participants ?? []).map((p) => p.name.trim()).filter(Boolean))];
  const title = row.title ?? `Reunión — ${formatWhen(Date.parse(row.started_at))}`;
  const documentId = await fileInKnowledgeBase(ctx, {
    callId,
    documentId: row.document_id,
    sessionId: row.session_id,
    meetCode: row.meet_code,
    title,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? new Date().toISOString(),
    names,
    turns,
    insights: row.insights,
    timeline: normalizeTimeline(row.timeline),
    userId: row.user_id ?? ctx.userId,
  });
  const { error } = await ctx.db
    .from('live_calls')
    .update({
      brain_status: 'kept',
      brain_decided_by: 'person',
      brain_reason: 'La guardaste tú desde Llamadas.',
    })
    .eq('id', callId);
  if (error) throw new Error(error.message);
  return { documentId };
}

/**
 * «Sácala del Brain». Borra el documento (los chunks caen en cascada) y el
 * asiento del ledger; la llamada y su transcript siguen en Llamadas.
 */
export async function dropLiveCallFromBrain(
  ctx: MeetingImportContext,
  callId: string,
): Promise<void> {
  const row = await loadCall(ctx, callId);
  if (row.document_id) {
    const { error: delErr } = await ctx.db.from('kb_documents').delete().eq('id', row.document_id);
    if (delErr) throw new Error(delErr.message);
    await ctx.db
      .from('meeting_imports')
      .delete()
      .eq('conference_record', liveConferenceRecord(row.session_id));
  }
  const { error } = await ctx.db
    .from('live_calls')
    .update({
      document_id: null,
      brain_status: 'skipped',
      brain_decided_by: 'person',
      brain_reason: 'La sacaste tú desde Llamadas.',
    })
    .eq('id', callId);
  if (error) throw new Error(error.message);
}

async function fileInKnowledgeBase(
  ctx: MeetingImportContext,
  args: {
    callId: string;
    documentId: string | null;
    sessionId: string;
    meetCode: string | null;
    title: string;
    startedAt: string;
    endedAt: string;
    names: string[];
    turns: SpeechTurn[];
    insights: LiveInsights | null;
    timeline?: CallEvent[];
    userId: string;
  },
): Promise<string> {
  const conferenceRecord = liveConferenceRecord(args.sessionId);
  const startMs = Date.parse(args.startedAt);
  const endMs = Date.parse(args.endedAt);
  const durationSeconds =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 1000)
      : Math.round((args.turns[args.turns.length - 1]?.endMs ?? 0) / 1000) || null;

  const header = liveHeader({
    title: args.title,
    meetingCode: args.meetCode,
    startedAt: args.startedAt,
    durationSeconds,
    participants: args.names,
    sessionId: args.sessionId,
  });
  const chunks = buildChunks(
    withTimeline(withInsights(header, args.insights), args.timeline ?? []),
    args.turns,
  );
  const sha256 = createHash('sha256').update(fullText(chunks)).digest('hex');

  let documentId = args.documentId;
  let currentSha: string | null = null;
  let currentSpaceId: string | null = null;

  if (documentId) {
    const { data: docRow } = await ctx.db
      .from('kb_documents')
      .select('id, collection_id, sha256, status')
      .eq('id', documentId)
      .maybeSingle();
    if (docRow) {
      currentSpaceId = docRow.collection_id as string;
      currentSha = docRow.status === 'ready' ? ((docRow.sha256 as string | null) ?? null) : null;
    } else {
      documentId = null;
    }
  }

  const destination = currentSpaceId
    ? await ctx.db
        .from('kb_collections')
        .select('id, name')
        .eq('id', currentSpaceId)
        .maybeSingle()
        .then((r) =>
          r.data
            ? { id: r.data.id as string, name: r.data.name as string }
            : ensurePersonalSpace(ctx.db, args.userId),
        )
    : await ensurePersonalSpace(ctx.db, args.userId);

  if (documentId && currentSha === sha256) {
    return documentId;
  }

  const documentFields = {
    collection_id: destination.id,
    source: 'meeting',
    source_ref: conferenceRecord,
    title: args.title,
    mime: 'text/markdown',
    sha256,
    uploaded_by: args.userId,
    status: 'pending',
    error_message: null,
    media_kind: 'meeting',
    recorded_at: args.startedAt,
    duration_seconds: durationSeconds,
    speakers: args.names,
    transcript_status: 'ready',
    transcript_error: null,
  };

  if (documentId) {
    const { error } = await ctx.db.from('kb_documents').update(documentFields).eq('id', documentId);
    if (error) throw new Error(error.message);
    const { error: delErr } = await ctx.db.from('kb_chunks').delete().eq('document_id', documentId);
    if (delErr) throw new Error(delErr.message);
  } else {
    const { data: created, error } = await ctx.db
      .from('kb_documents')
      .insert(documentFields)
      .select('id')
      .single();
    if (error || !created) throw new Error(error?.message ?? 'document row was not created');
    documentId = created.id as string;
  }

  const embedded = await embedDocuments(chunks.map((c) => c.content));
  if (!embedded.ok && embedded.retryable) throw new Error(embedded.reason);

  const { error: chunkErr } = await ctx.db.from('kb_chunks').insert(
    chunks.map((c, i) => ({
      document_id: documentId,
      chunk_index: c.chunkIndex,
      content: c.content,
      tokens: c.tokens ?? approxTokens(c.content),
      embedding: embedded.ok ? embedded.data[i] : null,
      embedding_model: embedded.ok ? embedded.usage.modelId : null,
      metadata: c.metadata,
    })),
  );
  if (chunkErr) throw new Error(chunkErr.message);

  if (embedded.ok) {
    await recordEmbeddingUsage(ctx.db, {
      organizationId: ctx.organizationId,
      documentId,
      source: 'meeting',
      usage: embedded.usage,
    });
  }

  await ctx.db
    .from('kb_documents')
    .update(
      embedded.ok
        ? { status: 'ready', error_message: null }
        : { status: 'pending', error_message: embedded.reason },
    )
    .eq('id', documentId);

  const { error: ledgerErr } = await ctx.db.from('meeting_imports').upsert(
    {
      conference_record: conferenceRecord,
      meeting_code: args.meetCode,
      space_name: null,
      title: args.title,
      started_at: args.startedAt,
      ended_at: args.endedAt,
      participants: args.names,
      document_id: documentId,
      imported_by: args.userId,
      imported_at: new Date().toISOString(),
      status: embedded.ok ? 'ready' : 'failed',
      error: embedded.ok ? null : embedded.reason,
    },
    { onConflict: 'organization_id,conference_record' },
  );
  if (ledgerErr) throw new Error(`meeting_imports upsert failed: ${ledgerErr.message}`);

  const { error: linkErr } = await ctx.db
    .from('live_calls')
    .update({ document_id: documentId })
    .eq('id', args.callId);
  if (linkErr) throw new Error(linkErr.message);

  return documentId;
}
