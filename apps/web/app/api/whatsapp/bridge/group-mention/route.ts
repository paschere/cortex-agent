import { runChatTurn } from '@/app/api/chat-app/google/turn';
import { sendEmail } from '@/lib/email';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { authenticateBridge } from '@/lib/whatsapp/bridge';
import { humanDelayMs, toWhatsappText } from '@/lib/whatsapp/format';
import {
  GROUP_SURFACE_NOTE,
  type GroupContextMessage,
  type GroupReplyRow,
  type GroupReplyScope,
  UNKNOWN_GROUP_SENDER_REPLY,
  groupToolFilter,
  handleGroupMention,
  isGroupReplyScope,
  resolveWhatsappSender,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Cortex was mentioned in a WhatsApp group.
 *
 * Everything about whether and how to answer lives in `handleGroupMention`
 * (packages/agent-tools/src/whatsapp/group-reply.ts), where the order of the
 * gates is written down and tested without a model. This route is the wiring:
 * it loads the group, hands over the two things that must run here — resolving
 * the sender against every workspace, and running an actual agent turn — and
 * delivers whatever comes back.
 *
 * ── WHERE A WITHHELD ANSWER GOES ────────────────────────────────────────────
 *
 * The turn runs with `audience: 'space'`, which switches on the privacy guard
 * the Google Chat surface has used since it shipped: an answer that touched
 * payroll, personal data, anything the security classifier rates high, or one
 * of the asker's own memories is REMOVED from the public reply and handed back
 * separately. In the group Cortex then says only that it answered privately.
 *
 * That guard was written for a Google Chat space — a room inside the company.
 * A WhatsApp group is a harder room: the client the question is about is often
 * in it. So the guard is the LAST line here, not the only one. Before it, the
 * group's own `reply_scope` has already decided what the turn could reach at
 * all, and `kbSpaceIds` has already made the asker's private notes
 * unretrievable. The guard catches what is left.
 *
 * The private half is delivered by WhatsApp DM only to somebody who has already
 * written to this number (`whatsapp_links.dm_jid`), and by EMAIL otherwise —
 * the same fallback the Google Chat route uses, and for a second reason here:
 * this account does not start conversations, and messaging a chat that has
 * never been opened would be starting one.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface Body {
  groupJid?: string;
  messageId?: string;
  senderJid?: string | null;
  senderName?: string | null;
  text?: string;
  mentionedJids?: string[];
  quotedAuthorJid?: string | null;
  /** Every way WhatsApp writes this account, as the bridge sees it. */
  selfJids?: string[];
  /** The bridge's in-memory ring buffer. Never read from the database. */
  recent?: GroupContextMessage[];
}

const SILENT = NextResponse.json({ reply: null });

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as Body;
  const groupJid = body.groupJid?.trim();
  const messageId = body.messageId?.trim();
  if (!groupJid?.endsWith('@g.us') || !messageId) return SILENT;

  const organizationId = auth.caller.organizationId;
  const db = getOrgScopedClient(organizationId);

  const { data: groupRow } = await db
    .from('whatsapp_groups')
    .select('jid, subject, reply_enabled, reply_scope, reply_space_id, reply_limit_per_hour')
    .eq('jid', groupJid)
    .maybeSingle();
  if (!groupRow) return SILENT;

  const group = groupRow as unknown as GroupReplyRow;

  const result = await handleGroupMention(
    {
      organizationId,
      db,
      logger,
      runTurn: async (turn) => {
        const delivery = await runChatTurn({
          organizationId: turn.organizationId,
          userId: turn.userId,
          ...(turn.senderName ? { senderName: turn.senderName } : {}),
          space: turn.groupJid,
          ...(turn.groupSubject ? { spaceDisplayName: turn.groupSubject } : {}),
          // 'space' is what arms the privacy guard. A group is a broadcast, and
          // calling it a DM here would deliver a compensation figure to a room.
          audience: 'space',
          conversationKey: turn.conversationKey,
          userText: turn.userText,
          surfaceKey: 'whatsapp',
          titlePrefix: 'WhatsApp',
          surfaceNote: GROUP_SURFACE_NOTE,
          // The recent conversation rides in as the turn's extra instruction —
          // it is exactly that, context folded into the system prompt for one
          // turn and never persisted.
          directive: turn.contextBlock,
          toolFilter: groupToolFilter(turn.scope),
          ...(turn.kbSpaceIds ? { kbSpaceIds: turn.kbSpaceIds } : {}),
        });
        return {
          publicText: toWhatsappText(delivery.publicText),
          privateText: delivery.privateText ? toWhatsappText(delivery.privateText) : null,
          withheldReason: delivery.withheldReason,
        };
      },
    },
    group,
    {
      groupJid,
      messageId,
      senderJid: body.senderJid ?? null,
      senderName: body.senderName ?? null,
      text: body.text ?? '',
      mentionedJids: body.mentionedJids ?? [],
      quotedAuthorJid: body.quotedAuthorJid ?? null,
      selfJids: body.selfJids ?? [],
      recent: body.recent ?? [],
    },
    // Unscoped, for the same reason the DM route is: the number is what names
    // the workspace, so the lookup cannot already be scoped to its own answer.
    // The result is then checked against the workspace the bridge is acting for
    // — a person linked in another company is not a person here.
    async () => {
      const sender = await resolveWhatsappSender(getSupabaseServiceClient(), body.senderJid ?? '');
      if (!sender || sender.organizationId !== organizationId) return null;
      return { userId: sender.userId, phone: sender.phone, displayName: sender.displayName };
    },
    (raw) => (isGroupReplyScope(raw) ? raw : ('plain' as GroupReplyScope)),
    UNKNOWN_GROUP_SENDER_REPLY,
  );

  if (result.outcome !== 'answered' && result.outcome !== 'withheld') {
    logger.info(`whatsapp group mention: ${result.outcome} — ${result.note}`);
  }

  const dm = result.privateReply
    ? await deliverPrivately(organizationId, result.privateReply)
    : null;

  const reply = result.reply?.trim() || null;
  return NextResponse.json({
    reply,
    ...(reply ? { delayMs: humanDelayMs(reply.length) } : {}),
    // The bridge sends this one, because it is the only thing here holding a
    // socket. Null when it went out by email instead.
    dm,
    outcome: result.outcome,
  });
}

/**
 * The half of an answer that must not be in the room.
 *
 * WhatsApp DM first, but ONLY to somebody who has already written to this
 * number — `dm_jid` is set the first time they do. Messaging a chat that has
 * never been opened would be this account starting a conversation, which is the
 * one thing it does not do. Email otherwise, exactly as the Google Chat route
 * falls back.
 */
async function deliverPrivately(
  organizationId: string,
  privateReply: { text: string; userId: string; phone: string },
): Promise<{ jid: string; text: string } | null> {
  const db = getOrgScopedClient(organizationId);

  const { data: link } = await db
    .from('whatsapp_links')
    .select('dm_jid')
    .eq('phone_e164', privateReply.phone)
    .maybeSingle();

  const dmJid = link?.dm_jid as string | null | undefined;
  if (dmJid) return { jid: dmJid, text: privateReply.text };

  const { data: person } = await db
    .from('users')
    .select('email, name')
    .eq('id', privateReply.userId)
    .maybeSingle();
  const to = person?.email as string | undefined;
  if (!to) {
    logger.warn('whatsapp: an answer was withheld from a group but the asker has no address');
    return null;
  }

  await sendEmail({
    to,
    subject: '[Cortex] Tu respuesta de WhatsApp',
    text: `${privateReply.text}\n\n(Preguntaste esto en un grupo de WhatsApp. La respuesta llevaba información que no debía quedar en el grupo, así que te la mando por aquí. Escríbeme por WhatsApp alguna vez y la próxima te llega por ahí.)`,
  }).catch(() => undefined);
  return null;
}
