import 'server-only';
import { logger } from '@zipdev/core';
import { sendEmail } from '@/lib/email';
import { confirmationReason } from '@/lib/confirmation-notes';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

/**
 * "Zippy needs your approval" notification.
 *
 * A confirmation is only useful if the person sees it. In the web chat they
 * do — the prompt is right there. Over MCP (Claude, Claude Code) and from a
 * scheduled run the request can land while nobody is looking at that surface,
 * so it also goes out by email, pointing at /approvals where it can be
 * approved or declined.
 *
 * Best-effort by design: a mail failure must never break the tool call that
 * triggered it.
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
  surface?: 'mcp' | 'schedule' | 'web';
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

    const base = (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
    let payload = JSON.stringify(opts.input, null, 2);
    if (payload.length > MAX_PAYLOAD_CHARS) {
      payload = `${payload.slice(0, MAX_PAYLOAD_CHARS)}\n… (truncated — see the full payload in the app)`;
    }

    const where =
      opts.surface === 'schedule'
        ? 'a scheduled routine'
        : opts.surface === 'mcp'
          ? 'your Claude conversation'
          : 'Zipdev OS';

    const text = [
      `${user?.name ? `${String(user.name).split(' ')[0]}, ` : ''}Zippy needs your approval before it does this.`,
      '',
      `What: ${humanizeToolId(opts.toolId)}`,
      `Where it came from: ${where}`,
      '',
      `Why it needs approval: ${confirmationReason(opts.toolId)}`,
      '',
      'Exactly what will run:',
      payload,
      '',
      base ? `Approve or decline: ${base}/approvals` : 'Approve or decline it in Zipdev OS.',
      '',
      'Nothing has happened yet — it only runs if you approve. The request expires in 15 minutes.',
    ].join('\n');

    const result = await sendEmail({
      to,
      subject: `[Zippy] Approval needed: ${humanizeToolId(opts.toolId)}`,
      text,
    });
    if (!result.sent) {
      logger.warn('approval email not sent', { reason: result.reason, toolId: opts.toolId });
    }
  } catch (err) {
    logger.error('approval email failed', { error: (err as Error).message });
  }
}
