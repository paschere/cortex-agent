import 'server-only';
import { logger } from '@zipdev/core';

/**
 * Minimal outbound email via the Resend HTTP API. Deliberately optional: when
 * RESEND_API_KEY is not configured we log and report `sent: false` instead of
 * throwing, so callers (e.g. scheduled-job delivery) degrade gracefully.
 */
export async function sendEmail(opts: {
  /** A single address or an explicit recipient list (all get one email). */
  to: string | string[];
  subject: string;
  /**
   * Plain-text body. Required even when `html` is supplied: it is the part
   * text-only clients, notification previews and corporate gateways show, so
   * it has to read well on its own — never a stub like "view in HTML".
   */
  text: string;
  /**
   * Optional HTML body (see `lib/email-templates`). Sent as a multipart
   * alternative alongside `text`; every client picks exactly one.
   */
  html?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const to = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);
  if (to.length === 0) {
    logger.warn('sendEmail skipped: no recipients');
    return { sent: false, reason: 'no recipients' };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('sendEmail skipped: RESEND_API_KEY not configured', { to });
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }
  const from = process.env.EMAIL_FROM ?? 'Zippy <onboarding@resend.dev>';

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
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error('sendEmail failed', { status: res.status, body: body.slice(0, 300) });
    return { sent: false, reason: `Resend ${res.status}` };
  }
  return { sent: true };
}
