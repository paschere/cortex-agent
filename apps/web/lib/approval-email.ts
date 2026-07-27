import 'server-only';
import { confirmationReason } from '@/lib/confirmation-notes';
import { sendEmail } from '@/lib/email';
import { renderApprovalRequestEmail } from '@/lib/email-templates';
import { sendChatDm, toChatText } from '@/lib/google-chat';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@zipdev/core';

/**
 * "Zippy needs your approval" notification.
 *
 * A confirmation is only useful if the person sees it. In the web chat they
 * do — the prompt is right there. Over MCP (Claude, Claude Code), from a
 * scheduled run, or from Google Chat the request can land while nobody is
 * looking at that surface, so it also goes out by email, pointing at
 * /approvals where it can be approved or declined.
 *
 * When the person has linked Google Chat (they have DMed the Zippy Chat app at
 * least once) the same request is ALSO delivered as a Chat DM — same content,
 * Chat-formatted. Approvals expire in 15 minutes, so reaching the surface the
 * person actually has open matters more than tidiness.
 *
 * Best-effort by design: neither a mail failure nor a Chat failure may break
 * the tool call that triggered it.
 */

const MAX_PAYLOAD_CHARS = 1500;

function humanizeToolId(toolId: string): string {
  const [family = '', ...rest] = toolId.split('.');
  const action = rest
    .join('.')
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
  const familyTitle = family ? family[0]!.toUpperCase() + family.slice(1) : family;
  return action ? `${familyTitle} · ${action}` : familyTitle;
}

export async function sendApprovalRequestEmail(opts: {
  userId: string;
  toolId: string;
  input: unknown;
  /** Where the request came from, for the subject line. */
  surface?: 'mcp' | 'schedule' | 'web' | 'chat';
}): Promise<void> {
  try {
    const db = getSupabaseServiceClient();
    const { data: user } = await db
      .from('users')
      .select('email, name')
      .eq('id', opts.userId)
      .maybeSingle();
    const to = user?.email as string | undefined;
    if (!to) return;

    const base = (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(
      /\/+$/,
      '',
    );
    let payload = JSON.stringify(opts.input, null, 2);
    if (payload.length > MAX_PAYLOAD_CHARS) {
      payload = `${payload.slice(0, MAX_PAYLOAD_CHARS)}\n… (truncated — see the full payload in the app)`;
    }

    const where =
      opts.surface === 'schedule'
        ? 'a scheduled routine'
        : opts.surface === 'mcp'
          ? 'your Claude conversation'
          : opts.surface === 'chat'
            ? 'Google Chat'
            : 'Zipdev OS';

    const mail = renderApprovalRequestEmail({
      toolLabel: humanizeToolId(opts.toolId),
      origin: where,
      reason: confirmationReason(opts.toolId),
      payload,
      firstName: user?.name ? String(user.name).split(' ')[0] : null,
      expiresInMinutes: 15,
    });

    const result = await sendEmail({
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (!result.sent) {
      logger.warn('approval email not sent', { reason: result.reason, toolId: opts.toolId });
    }

    // Second channel, not a replacement: someone who lives in Chat should not
    // have to notice an email inside a 15-minute window. `sendChatDm` returns
    // `{ sent: false, reason: 'not linked' }` for anyone without a DM space, so
    // this is a no-op for people who have never used the Chat app.
    const chatText = toChatText(
      [
        `⏸️ **Approval needed — ${humanizeToolId(opts.toolId)}**`,
        '',
        `Where it came from: ${where}`,
        `Why it needs approval: ${confirmationReason(opts.toolId)}`,
        '',
        'Exactly what will run:',
        '```',
        payload,
        '```',
        '',
        base
          ? `Approve or decline: [${base}/approvals](${base}/approvals)`
          : 'Approve or decline it in Zipdev OS.',
        '',
        'Nothing has happened yet — it only runs if you approve. The request expires in 15 minutes.',
      ].join('\n'),
    );
    const chat = await sendChatDm({ userId: opts.userId, text: chatText });
    if (!chat.sent && chat.reason !== 'not linked') {
      logger.warn('approval Chat DM not sent', { reason: chat.reason, toolId: opts.toolId });
    }
  } catch (err) {
    logger.error('approval notification failed', { error: (err as Error).message });
  }
}
