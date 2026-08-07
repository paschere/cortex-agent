import { z } from 'zod';
import { registerTool } from '../index';
import { GRAPH_SCOPES } from '../msgraph/client';
import { fetchMessages, groupByConversation, messageBudget } from './threads';

export const outlookListThreads = registerTool({
  id: 'outlook.list_threads',
  description:
    'List recent Outlook / Microsoft 365 conversations for a contact or a KQL query string. Provide contactEmail (everything to or from that address) and/or query (raw KQL). Returns subject, from, to, date and snippet per conversation. ' +
    'This is the same underlying search as outlook.search, with the To: header included and a shortcut for "everything with this person" — so there is no reason to call both. ' +
    'The Microsoft 365 twin of gmail.list_threads.',
  inputSchema: z
    .object({
      contactEmail: z.string().email().optional(),
      query: z.string().optional(),
      maxResults: z.number().int().min(1).max(20).default(10),
    })
    .refine((data) => Boolean(data.contactEmail) || Boolean(data.query), {
      message: 'Provide either contactEmail or query',
    }),
  outputSchema: z.object({
    threads: z.array(
      z.object({
        id: z.string(),
        snippet: z.string(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        subject: z.string().nullable(),
        date: z.string().nullable(),
      }),
    ),
  }),
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.MAIL_READ] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    // `participants:` is KQL's own "from OR to OR cc", which is what
    // `(from:x OR to:x)` spells out on the Gmail side. One term instead of two
    // also keeps the expression inside what Graph will accept alongside a
    // caller-supplied query.
    const parts = [
      input.contactEmail ? `participants:${input.contactEmail}` : '',
      input.query ?? '',
    ].filter(Boolean);
    const search = parts.length > 1 ? parts.map((p) => `(${p})`).join(' AND ') : parts[0];

    const maxResults = input.maxResults ?? 10;
    const messages = await fetchMessages(ctx, { search, top: messageBudget(maxResults) });
    return { threads: groupByConversation(messages, maxResults) };
  },
});
