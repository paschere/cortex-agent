import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type WhatsappGroupRef,
  type WhatsappIngestContext,
  type WindowIngestResult,
  ingestWindow,
} from './ingest-window';
import {
  DEFAULT_IDLE_GAP_MINUTES,
  DEFAULT_MAX_WINDOW_HOURS,
  DEFAULT_TIME_ZONE,
  type StagedMessage,
  planWindows,
} from './windows';

/**
 * The pass that turns staged messages into documents.
 *
 * WHY IT IS A PASS AND NOT A TRIGGER. Ingesting on arrival would mean a
 * document write, a chunking run and an embedding call per message — for a
 * group that emits eight hundred a day, per group. It would also be wrong even
 * if it were free: a conversation cannot be grouped until you can see whether
 * it kept going, so the earliest honest moment to write it down is after it has
 * stopped. The bridge therefore buffers, posts batches, and separately asks
 * Cortex to flush on a timer; this is what runs then.
 *
 * WHAT IT COSTS TO RUN OFTEN. Almost nothing when nothing has happened: the
 * pass starts from "messages with no document yet", and a group with none is
 * one indexed query and out. That is deliberate — the alternative, re-planning
 * every group's whole history on every tick, is the kind of thing that works
 * for a month and then quietly becomes the most expensive query in the system.
 */

export interface FlushOptions {
  idleGapMinutes?: number;
  maxWindowHours?: number;
  timeZone?: string;
  /** Supplied rather than read, so tests are not time-dependent. */
  nowMs?: number;
  /** Ceiling on messages examined per group per pass. */
  maxMessages?: number;
}

export interface GroupFlushResult {
  groupJid: string;
  subject: string | null;
  /** Windows that were closed and written. */
  windows: WindowIngestResult[];
  /** True while the group is still mid-conversation; nothing was written for it. */
  stillTalking: boolean;
  pendingMessages: number;
}

interface GroupRow {
  jid: string;
  subject: string | null;
  space_id: string | null;
  archive_enabled: boolean;
  enabled_by: string | null;
}

interface MessageRow {
  id: string;
  message_id: string;
  sender_jid: string | null;
  sender_name: string | null;
  sent_at: string;
  body: string | null;
  kind: string;
  transcript: string | null;
  media_filename: string | null;
  attachment_document_id: string | null;
  document_id: string | null;
}

const MESSAGE_COLUMNS =
  'id, message_id, sender_jid, sender_name, sent_at, body, kind, transcript, media_filename, attachment_document_id, document_id';

function toStaged(row: MessageRow): StagedMessage {
  return {
    id: row.id,
    messageId: row.message_id,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    sentAt: row.sent_at,
    body: row.body,
    kind: row.kind as StagedMessage['kind'],
    transcript: row.transcript,
    mediaFilename: row.media_filename,
    attachmentDocumentId: row.attachment_document_id,
  };
}

/**
 * Fold one group's finished conversations into Brain Knowledge.
 *
 * Refuses outright for a group that is not switched on. That check is here as
 * well as at the ingest route because this function can be called from
 * anywhere, and "a group nobody enabled was archived" is the single failure
 * this feature is least allowed to have. The route stops the messages being
 * stored at all; this stops anything already staged — from a group that was
 * switched OFF after the fact — from becoming a document.
 */
export async function flushGroup(
  ctx: { organizationId: string; db: SupabaseClient; logger: Logger },
  group: GroupRow,
  opts: FlushOptions = {},
): Promise<GroupFlushResult> {
  const db = ctx.db;
  const idleGapMinutes = opts.idleGapMinutes ?? DEFAULT_IDLE_GAP_MINUTES;
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const nowMs = opts.nowMs ?? Date.now();
  const maxMessages = opts.maxMessages ?? 5_000;

  const empty: GroupFlushResult = {
    groupJid: group.jid,
    subject: group.subject,
    windows: [],
    stillTalking: false,
    pendingMessages: 0,
  };

  if (!group.archive_enabled || !group.space_id || !group.enabled_by) return empty;

  // The oldest message that is not yet part of a document. Everything the pass
  // does is anchored on this instant.
  const { data: oldestRows } = await db
    .from('whatsapp_messages')
    .select('sent_at')
    .eq('group_jid', group.jid)
    .is('document_id', null)
    .order('sent_at', { ascending: true })
    .limit(1);
  const oldest = (oldestRows ?? [])[0] as { sent_at: string } | undefined;
  if (!oldest) return empty;

  // Reach back one idle gap before it. A pending message may belong to a window
  // that ALREADY has a document — the conversation carried on past the last
  // flush — and planning without its earlier half would cut the same episode
  // into two documents.
  const fromMs = Date.parse(oldest.sent_at) - idleGapMinutes * 60_000;
  const { data: rows } = await db
    .from('whatsapp_messages')
    .select(MESSAGE_COLUMNS)
    .eq('group_jid', group.jid)
    .gte('sent_at', new Date(fromMs).toISOString())
    .order('sent_at', { ascending: true })
    .limit(maxMessages);

  const messageRows = (rows ?? []) as unknown as MessageRow[];
  if (messageRows.length === 0) return empty;

  const pendingCount = messageRows.filter((r) => r.document_id == null).length;
  const staged = messageRows.map(toStaged);
  const alreadyFiled = new Set(messageRows.filter((r) => r.document_id != null).map((r) => r.id));

  const planned = planWindows(staged, {
    idleGapMinutes,
    maxWindowHours: opts.maxWindowHours ?? DEFAULT_MAX_WINDOW_HOURS,
    timeZone,
    nowMs,
  });

  const ref: WhatsappGroupRef = {
    jid: group.jid,
    subject: group.subject,
    spaceId: group.space_id,
  };
  const ingestCtx: WhatsappIngestContext = {
    organizationId: ctx.organizationId,
    userId: group.enabled_by,
    db,
    logger: ctx.logger,
  };

  const windows: WindowIngestResult[] = [];
  for (const window of planned.closed) {
    // Nothing new in this one: it was pulled in only as context for a window
    // further along. Re-ingesting it would produce 'unchanged' at the cost of a
    // document read and a ledger read, every tick, forever.
    if (window.messages.every((m) => alreadyFiled.has(m.id))) continue;
    windows.push(await ingestWindow(ingestCtx, ref, window, { timeZone }));
  }

  return {
    groupJid: group.jid,
    subject: group.subject,
    windows,
    stillTalking: planned.open !== null,
    pendingMessages: pendingCount,
  };
}

/** Every switched-on group in the workspace, folded. */
export async function flushWorkspace(
  ctx: { organizationId: string; db: SupabaseClient; logger: Logger },
  opts: FlushOptions = {},
): Promise<GroupFlushResult[]> {
  const { data } = await ctx.db
    .from('whatsapp_groups')
    .select('jid, subject, space_id, archive_enabled, enabled_by')
    .eq('archive_enabled', true);

  const results: GroupFlushResult[] = [];
  for (const group of (data ?? []) as unknown as GroupRow[]) {
    try {
      results.push(await flushGroup(ctx, group, opts));
    } catch (err) {
      // One broken group must not stop the others being remembered.
      ctx.logger.error(
        { err: (err as Error).message, group: group.jid },
        'whatsapp: group flush failed',
      );
    }
  }
  return results;
}
