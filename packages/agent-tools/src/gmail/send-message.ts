import { z } from 'zod';
import { registerTool } from '../index';
import { gmailFetch } from './client';
import { b64url, buildRfc822 } from './draft';

/**
 * Send exactly this text, now.
 *
 * WHY THIS EXISTS ALONGSIDE `gmail.send_draft`. They answer different
 * questions. `gmail.send_draft` sends something that lives in Gmail, named by
 * an id: the content is on Google's side, a person can open the draft and
 * rewrite it, and the tool's input — `{draftId}` — says nothing about what will
 * leave. That is exactly right for "I wrote a draft, send it", and exactly
 * wrong for an approval, where the whole point is that the bytes approved are
 * the bytes sent. An approval of `{draftId: "r-8813"}` is an approval of
 * whatever that draft happens to contain at send time, which is not a thing
 * anybody can meaningfully agree to.
 *
 * Here the payload IS the message. The subject and body a person read on the
 * card are the subject and body in `tool_input`, fingerprinted, carried through
 * the claim, and handed to this tool unchanged. Nothing in between can
 * substitute them, because there is nothing in between.
 *
 * Confirmation-gated like every send. Reached two ways, both of which end in a
 * human having said yes to this exact text: the approval of a proposed action
 * (packages/agent-tools/src/actions), and the ordinary in-chat confirmation
 * prompt when the model calls it directly.
 */
export const gmailSendMessage = registerTool({
  id: 'gmail.send_message',
  description:
    'Send an email with EXACTLY this subject and body, from the user\'s Gmail. Requires confirmation. Unlike gmail_send_draft (which sends whatever a stored draft currently contains), the message is the input — use this whenever the text being approved must be the text that goes out. Pass threadId to reply inside an existing conversation.',
  inputSchema: z.object({
    to: z.array(z.string().email()).min(1).max(10),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000).describe('Plain text, exactly as it will be sent'),
    cc: z.array(z.string().email()).max(10).optional(),
    bcc: z.array(z.string().email()).max(10).optional(),
    threadId: z
      .string()
      .optional()
      .describe('Gmail thread id to reply inside, so the answer lands in the same conversation'),
  }),
  outputSchema: z.object({
    messageId: z.string(),
    threadId: z.string().nullable(),
    to: z.array(z.string()),
    subject: z.string(),
  }),
  requiresConfirmation: true,
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.compose'] },
  ],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const raw = b64url(buildRfc822(input));

    type SendResponse = { id: string; threadId?: string };
    const payload: { raw: string; threadId?: string } = { raw };
    // Gmail needs the thread on the request as well as In-Reply-To in the
    // headers; without it the reply is delivered but shows up as a new
    // conversation, which is how a client ends up with two threads about one
    // invoice.
    if (input.threadId) payload.threadId = input.threadId;

    const r = await gmailFetch<SendResponse>(ctx, '/messages/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      messageId: r.id,
      threadId: r.threadId ?? null,
      to: input.to,
      subject: input.subject,
    };
  },
});
