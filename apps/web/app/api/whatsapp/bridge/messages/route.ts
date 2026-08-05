import { getOrgScopedClient } from '@/lib/supabase/service';
import { authenticateBridge, decodeBase64 } from '@/lib/whatsapp/bridge';
import { MAX_DOCUMENT_BYTES, MAX_VOICE_BYTES } from '@cortex/agent-tools';
import {
  ingestGroupAttachment,
  isIngestibleDocument,
  shouldStageMessage,
  transcribeVoiceNote,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Where a batch of group messages lands.
 *
 * IT IS A BATCH, AND THAT IS THE POINT. An active dispatch group emits hundreds
 * of messages a day. One HTTP request and one insert per message would be
 * hundreds of round trips, hundreds of rows written one at a time, and — if the
 * documents were built here too — hundreds of embedding calls for text like
 * "listo". The bridge buffers instead, and posts what it has heard every thirty
 * seconds or every fifty messages, whichever comes first. Building the
 * documents is a separate, slower pass (see ../flush), because a conversation
 * cannot be grouped until you can see whether it kept going.
 *
 * THE SECOND LOCK ON "ONLY ENABLED GROUPS". The bridge already drops anything
 * that is not on the allow-list it got from the heartbeat. This checks again,
 * against the database, before a single row is written — so a bridge running a
 * stale configuration, or one that has been tampered with, still cannot archive
 * a group nobody chose. A message from an un-enabled group leaves NO TRACE in
 * this database: not a dropped row, not an orphan, nothing.
 *
 * `archive_from` is the third: switching a group on must not retroactively
 * swallow two years of a conversation that nobody was told about, so anything
 * older than the instant somebody chose is refused as well.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Deepgram is in this path for voice notes; a big batch takes a while. */
export const maxDuration = 300;

type Kind = 'text' | 'voice' | 'image' | 'video' | 'document' | 'location' | 'contact' | 'other';

const KINDS = new Set<Kind>([
  'text',
  'voice',
  'image',
  'video',
  'document',
  'location',
  'contact',
  'other',
]);

interface IncomingMessage {
  groupJid?: string;
  messageId?: string;
  senderJid?: string | null;
  senderName?: string | null;
  sentAt?: string;
  body?: string | null;
  kind?: Kind;
  mediaMime?: string | null;
  mediaFilename?: string | null;
  /** Present only for a voice note or an ingestible file. See ../../../lib. */
  mediaBase64?: string | null;
}

interface GroupRow {
  jid: string;
  subject: string | null;
  space_id: string | null;
  enabled_by: string | null;
  archive_enabled: boolean;
  archive_from: string | null;
}

/**
 * How many voice notes one batch will pay to transcribe.
 *
 * Deepgram is fast but not free and not instant, and a history sync after a
 * long disconnection can deliver hundreds of them at once. Past the cap the
 * message is still archived — with `[voice note — not transcribed]` and a
 * reason on the row — and the group's conversation is intact around it.
 */
const MAX_TRANSCRIPTIONS_PER_BATCH = 25;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { messages?: IncomingMessage[] };
  const incoming = (body.messages ?? []).filter(
    (m) => typeof m.groupJid === 'string' && typeof m.messageId === 'string' && Boolean(m.sentAt),
  );
  if (incoming.length === 0) return NextResponse.json({ stored: 0, ignored: 0 });

  const db = getOrgScopedClient(auth.caller.organizationId);

  const jids = [...new Set(incoming.map((m) => m.groupJid as string))];
  const { data: groupRows } = await db
    .from('whatsapp_groups')
    .select('jid, subject, space_id, enabled_by, archive_enabled, archive_from')
    .in('jid', jids);

  // Keyed by jid regardless of whether archiving is on: `shouldStageMessage`
  // makes that call per message, and it is the ONLY place that does. Since
  // migration 0072 a group can have Cortex answering in it with archiving
  // switched off, and such a group must store nothing whatsoever — not a
  // message, not a stub. Deciding it here as well would be a second copy of
  // that rule, and second copies of rules are how they diverge.
  const groups = new Map<string, GroupRow>();
  for (const row of (groupRows ?? []) as unknown as GroupRow[]) groups.set(row.jid, row);

  // Already stored: re-delivery is routine (Baileys replays after a reconnect
  // and during history sync). Skipping them here is not only about avoiding a
  // duplicate row — it is what stops us paying Deepgram a second time for a
  // voice note we already transcribed.
  const { data: existingRows } = await db
    .from('whatsapp_messages')
    .select('group_jid, message_id')
    .in('group_jid', jids)
    .in(
      'message_id',
      incoming.map((m) => m.messageId as string),
    );
  const seen = new Set(
    ((existingRows ?? []) as Array<{ group_jid: string; message_id: string }>).map(
      (r) => `${r.group_jid}#${r.message_id}`,
    ),
  );

  const rows: Record<string, unknown>[] = [];
  const touched = new Map<string, string>();
  let ignored = 0;
  let transcribed = 0;

  for (const message of incoming) {
    const groupJid = message.groupJid as string;
    const group = groups.get(groupJid);
    if (seen.has(`${groupJid}#${message.messageId}`)) {
      ignored += 1;
      continue;
    }

    const sentAtMs = Date.parse(message.sentAt as string);
    // The whole archiving decision, in one call: is the group switched on, does
    // it have somewhere to put documents and somebody answerable for them, and
    // is this message from after the moment archiving was chosen.
    if (!group || !shouldStageMessage(group, sentAtMs)) {
      ignored += 1;
      continue;
    }

    const kind: Kind = KINDS.has(message.kind as Kind) ? (message.kind as Kind) : 'text';
    const sentAt = new Date(sentAtMs).toISOString();
    const row: Record<string, unknown> = {
      group_jid: groupJid,
      message_id: message.messageId as string,
      sender_jid: message.senderJid ?? null,
      sender_name: message.senderName?.trim() || null,
      sent_at: sentAt,
      // Capped: a message is a message, not a document. Anything longer than
      // this in a WhatsApp group is a pasted export somebody should attach.
      body: (message.body ?? '').slice(0, 8_000) || null,
      kind,
      media_mime: message.mediaMime ?? null,
      media_filename: message.mediaFilename?.slice(0, 200) ?? null,
      transcript: null,
      transcript_error: null,
      attachment_document_id: null,
    };

    if (kind === 'voice' && message.mediaBase64) {
      if (transcribed >= MAX_TRANSCRIPTIONS_PER_BATCH) {
        row.transcript_error =
          'Too many voice notes arrived at once for this batch to transcribe them all; this one was stored without its words.';
      } else {
        const bytes = decodeBase64(message.mediaBase64, MAX_VOICE_BYTES);
        if (!bytes) {
          row.transcript_error = 'The voice note did not arrive in a shape we could read.';
        } else {
          transcribed += 1;
          const result = await transcribeVoiceNote(bytes, message.mediaMime ?? 'audio/ogg');
          row.transcript = result.text;
          row.transcript_error = result.error;
        }
      }
    }

    if (kind === 'document' && message.mediaBase64 && isIngestibleDocument(message.mediaMime)) {
      const bytes = decodeBase64(message.mediaBase64, MAX_DOCUMENT_BYTES);
      if (bytes) {
        const filed = await ingestGroupAttachment(db, {
          spaceId: group.space_id as string,
          uploadedBy: group.enabled_by as string,
          groupSubject: group.subject ?? 'WhatsApp',
          senderName: message.senderName?.trim() || 'alguien del grupo',
          filename: message.mediaFilename ?? 'archivo',
          mime: message.mediaMime ?? 'application/octet-stream',
          bytes,
          sentAt,
        });
        row.attachment_document_id = filed.documentId;
        if (filed.error) {
          logger.warn(`whatsapp: could not file a shared document — ${filed.error}`);
        }
      }
    }

    rows.push(row);
    const previous = touched.get(groupJid);
    if (!previous || previous < sentAt) touched.set(groupJid, sentAt);
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db
      .from('whatsapp_messages')
      .upsert(rows.slice(i, i + 200), { onConflict: 'organization_id,group_jid,message_id' });
    if (error) {
      logger.error(`whatsapp: could not stage a batch of messages — ${error.message}`);
      return NextResponse.json({ error: 'Could not store the messages' }, { status: 500 });
    }
  }

  for (const [jid, at] of touched) {
    await db
      .from('whatsapp_groups')
      .update({ last_message_at: at })
      .eq('jid', jid)
      .then(undefined, () => undefined);
  }

  return NextResponse.json({ stored: rows.length, ignored, transcribed });
}
