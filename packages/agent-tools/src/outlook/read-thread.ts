import { z } from 'zod';
import { registerTool } from '../index';
import { GRAPH_SCOPES, formatRecipient, formatRecipients } from '../msgraph/client';
import { fetchConversation, messageMoment } from './threads';

export const outlookReadThread = registerTool({
  id: 'outlook.read_thread',
  description:
    'Read a full Outlook / Microsoft 365 conversation by threadId (the id returned by outlook.search or outlook.list_threads) — returns the messages in order with from/to/date/body. The Microsoft 365 twin of gmail.read_thread.',
  inputSchema: z.object({ threadId: z.string().min(1) }),
  outputSchema: z.object({
    thread: z.object({
      id: z.string(),
      subject: z.string().nullable(),
      messages: z.array(
        z.object({
          from: z.string().nullable(),
          to: z.string().nullable(),
          date: z.string().nullable(),
          body: z.string(),
        }),
      ),
    }),
  }),
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.MAIL_READ] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    const messages = await fetchConversation(ctx, input.threadId, { withBody: true });
    return {
      thread: {
        id: input.threadId,
        subject: messages[0]?.subject ?? null,
        messages: messages.map((m) => ({
          from: formatRecipient(m.from ?? m.sender),
          to: formatRecipients(m.toRecipients),
          date: messageMoment(m),
          // Graph returned text because fetchConversation asked for it; the
          // preview is the fallback for a message whose body never loaded.
          body: (m.body?.content ?? m.bodyPreview ?? '').trim(),
        })),
      },
    };
  },
});
