import { z } from 'zod';
import { registerTool } from '../index';
import { gmailFetch } from './client';

/**
 * Exported for `gmail.send_message` (see ./send-message.ts), which composes the
 * same envelope but posts it to /messages/send instead of /drafts. One encoder
 * for both, because a second copy is how the reply headers end up right in one
 * path and wrong in the other.
 */
export function buildRfc822({
  to,
  subject,
  body,
  threadId,
  cc,
  bcc,
}: {
  to: string[];
  subject: string;
  body: string;
  threadId?: string;
  cc?: string[];
  bcc?: string[];
}): string {
  const lines: string[] = [
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (cc && cc.length > 0) lines.push(`Cc: ${cc.join(', ')}`);
  if (bcc && bcc.length > 0) lines.push(`Bcc: ${bcc.join(', ')}`);
  if (threadId) {
    lines.push(`In-Reply-To: ${threadId}`);
    lines.push(`References: ${threadId}`);
  }
  lines.push('', body);
  return lines.join('\r\n');
}

export function b64url(s: string): string {
  return Buffer.from(s, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const gmailDraft = registerTool({
  id: 'gmail.draft',
  description:
    'Create a Gmail draft (never sends). Returns the draft id and a deep link. The user must open Gmail to send.',
  inputSchema: z.object({
    to: z.array(z.string().email()).min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
    threadId: z.string().optional(),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
  }),
  outputSchema: z.object({
    draftId: z.string(),
    messageId: z.string(),
    deepLink: z.string(),
  }),
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.compose'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const raw = b64url(buildRfc822(input));
    type DraftResponse = { id: string; message: { id: string } };

    const payload: { message: { raw: string; threadId?: string } } = {
      message: { raw },
    };
    if (input.threadId) payload.message.threadId = input.threadId;

    const r = await gmailFetch<DraftResponse>(ctx, '/drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      draftId: r.id,
      messageId: r.message.id,
      deepLink: `https://mail.google.com/mail/u/0/#drafts/${r.id}`,
    };
  },
});
