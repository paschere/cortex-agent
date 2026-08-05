import { runChatTurn } from '@/app/api/chat-app/google/turn';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { authenticateBridge } from '@/lib/whatsapp/bridge';
import { humanDelayMs, toWhatsappText } from '@/lib/whatsapp/format';
import {
  UNKNOWN_SENDER_REPLY,
  isGroupJid,
  normalizePhone,
  recordUnknownSender,
  resolveWhatsappSender,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Somebody wrote to Cortex on WhatsApp.
 *
 * ── IDENTITY IS THE WHOLE ROUTE ──────────────────────────────────────────────
 *
 * A turn here runs real tools: it reads payroll, writes to HubSpot, opens pull
 * requests and answers out of Brain Knowledge. So it runs as a PERSON — their
 * integrations, their team permissions, their name on every audit row — or it
 * does not run. A phone number is not an identity claim; it is a string anybody
 * can put in a contact card. An unlinked number therefore gets a short refusal,
 * the attempt is recorded in `security_events`, and nothing else happens. There
 * is no anonymous mode, no read-only mode and no "just answer general
 * questions" mode, because "general questions" is not a category the tool layer
 * can enforce.
 *
 * The link also has to belong to the workspace the bridge says it is acting
 * for. That check costs one comparison and closes the only thing the shared
 * bridge token could otherwise be used for on this route.
 *
 * ── THE BRAIN IS NOT DUPLICATED ──────────────────────────────────────────────
 *
 * `runChatTurn` — the Google Chat engine — does the work, unchanged: same
 * agent row, same system prompt, same retrieval, same tool selection, same
 * conversation and message persistence, so a question asked on WhatsApp and the
 * same question asked on the web share a history and a memory. Two parameters
 * differ (what the model is told about the room, what the audit row calls the
 * surface) and nothing else.
 *
 * ── CONFIRMATIONS ───────────────────────────────────────────────────────────
 *
 * A tool that needs approval is NEVER executed here, and this surface has
 * nowhere to draw an Approve/Decline card. So the posture is the one
 * `schedule-run.ts` takes for unattended routines — when there is no way to ask
 * properly, do not do it — with the addition that the request is still staged
 * and still reaches the person: `runChatTurn` writes it to `mcp_pending_actions`
 * and sends the card by email and Google Chat DM. WhatsApp says, in one line,
 * what it was about to do and that it is waiting. Auto-confirming because the
 * channel is inconvenient would make "needs approval" mean "needs approval
 * unless you ask from your phone".
 *
 * ── SIGNALS ─────────────────────────────────────────────────────────────────
 *
 * This route never starts a conversation. It only ever answers a chat where the
 * other person wrote first, which is both the polite behaviour and the one that
 * looks least like automation to WhatsApp. The short delay and the "typing…"
 * indicator are applied by the bridge, from `delayMs` below.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface IncomingDm {
  /** "573001112233@s.whatsapp.net". */
  jid?: string;
  /** The sender's WhatsApp profile name, for the greeting only. */
  pushName?: string | null;
  text?: string;
  messageId?: string;
}

const EMPTY_REPLY = 'Aquí estoy. ¿Qué necesitas? ⚡';
const BROKEN_REPLY = 'Esa se me rompió antes de terminarla. Vuelve a escribirme en un momento. ⚡';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as IncomingDm;
  const jid = (body.jid ?? '').trim();
  const text = (body.text ?? '').trim();

  // A group message never reaches this route. Groups are archived, not
  // answered: Cortex is a silent member of them, and a bot that starts talking
  // in a room of clients is a different product nobody asked for.
  if (!jid || isGroupJid(jid)) {
    return NextResponse.json({ reply: null, reason: 'not a direct message' });
  }

  const phone = normalizePhone(jid);
  if (!phone) return NextResponse.json({ reply: null, reason: 'not a phone number' });

  // Unscoped, and this is the only unscoped read in the WhatsApp code. The
  // lookup is what DETERMINES the workspace — the same shape as `resolveUser`
  // in the Google Chat route, for the same reason: a query cannot be scoped to
  // the answer it is looking for.
  const sender = await resolveWhatsappSender(getSupabaseServiceClient(), jid);

  if (!sender || sender.organizationId !== auth.caller.organizationId) {
    // Recorded in the workspace the bridge is acting for, which is the one
    // whose line was written to — that is who needs to see it.
    await recordUnknownSender(getOrgScopedClient(auth.caller.organizationId), {
      phone,
      preview: text,
    });
    logger.warn('whatsapp: refused a direct message from an unlinked number');
    return NextResponse.json({ reply: UNKNOWN_SENDER_REPLY, delayMs: humanDelayMs(120) });
  }

  const db = getOrgScopedClient(sender.organizationId);
  await db
    .from('whatsapp_links')
    .update({
      last_seen_at: new Date().toISOString(),
      dm_jid: jid,
      ...(body.pushName?.trim() && !sender.displayName
        ? { display_name: body.pushName.trim() }
        : {}),
    })
    .eq('phone_e164', phone)
    .then(undefined, () => undefined);

  if (!text) {
    return NextResponse.json({ reply: EMPTY_REPLY, delayMs: humanDelayMs(EMPTY_REPLY.length) });
  }

  try {
    const delivery = await runChatTurn({
      organizationId: sender.organizationId,
      userId: sender.userId,
      ...((sender.displayName ?? body.pushName)
        ? { senderName: sender.displayName ?? (body.pushName as string) }
        : {}),
      space: jid,
      // 'dm' is not a convenience: it is what tells `runChatTurn` this is a
      // private conversation, which switches off the space privacy guard that
      // would otherwise try to redirect a sensitive answer "privately" — into
      // the very chat it is already in.
      audience: 'dm',
      // The same `conversations.external_key` mechanism Google Chat uses, with
      // its own prefix. A person's WhatsApp thread is one continuous
      // conversation, visible in their history on the web like any other.
      conversationKey: `whatsapp:${phone}`,
      userText: text,
      surfaceKey: 'whatsapp',
      titlePrefix: 'WhatsApp',
      surfaceNote:
        'You are answering on WhatsApp, in a 1:1 chat with one person, on their phone. Keep it to a few short lines: no headings, no tables, no bullet lists unless they are genuinely a list of three or four things. WhatsApp renders *bold* and _italic_ and nothing else. If an action needs their approval you cannot show them a button here — say in one sentence what you were about to do and that the approval request has been sent to them, and stop.',
    });

    const reply = toWhatsappText(delivery.publicText);
    return NextResponse.json({
      reply,
      delayMs: humanDelayMs(reply.length),
      conversationId: delivery.conversationId,
    });
  } catch (err) {
    logger.error(
      `whatsapp: turn failed — ${(err as Error).name}: ${(err as Error).message}\n${(err as Error).stack ?? ''}`,
    );
    // Never leave a message unanswered: silence from a number somebody just
    // wrote to reads as "it is broken and nobody knows".
    return NextResponse.json({ reply: BROKEN_REPLY, delayMs: humanDelayMs(BROKEN_REPLY.length) });
  }
}
