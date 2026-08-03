/**
 * Outbound email for tools.
 *
 * `apps/web/lib/email.ts` is the app's sender, but it is `server-only` and
 * lives in the Next app, so a tool cannot import it. This is the same Resend
 * call with the same contract — including the same graceful degradation: with
 * no API key configured we report `sent: false` and a reason instead of
 * throwing, so a digest run reports "email is not configured" rather than
 * failing the whole routine.
 */

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

export async function sendToolEmail(opts: {
  to: string | string[];
  subject: string;
  /** Plain-text fallback. Always send one — some clients never render HTML. */
  text: string;
  html?: string;
  signal?: AbortSignal;
}): Promise<SendMailResult> {
  const to = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (to.length === 0) return { sent: false, reason: 'no recipient address' };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'email sending is not configured' };
  const from = process.env.EMAIL_FROM ?? 'Cortex <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: opts.subject,
      text: opts.text,
      ...(opts.html ? { html: opts.html } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      sent: false,
      reason: `the mail provider refused it (${res.status}) ${body.slice(0, 160)}`.trim(),
    };
  }
  return { sent: true };
}
