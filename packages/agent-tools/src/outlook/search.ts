import { z } from 'zod';
import { registerTool } from '../index';
import { GRAPH_SCOPES } from '../msgraph/client';
import { fetchMessages, groupByConversation, messageBudget } from './threads';

export const outlookSearch = registerTool({
  id: 'outlook.search',
  description:
    'Search the user\'s Outlook / Microsoft 365 mailbox with a KQL query string (e.g. "from:foo AND subject:bar", "received>=2026-01-01", or just words to match anywhere). Returns subject, snippet, from and date per conversation. ' +
    "outlook.list_threads runs the same search and returns the same rows plus the To: header, and takes a contact's address directly instead of making you write the query — prefer it when you are looking at correspondence with a particular person. " +
    'This is the Microsoft 365 twin of gmail.search; use whichever mailbox the person actually has.',
  inputSchema: z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(25).default(10),
  }),
  outputSchema: z.object({
    threads: z.array(
      z.object({
        id: z.string(),
        snippet: z.string(),
        from: z.string().nullable(),
        subject: z.string().nullable(),
        date: z.string().nullable(),
      }),
    ),
  }),
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.MAIL_READ] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const maxResults = input.maxResults ?? 10;
    const messages = await fetchMessages(ctx, {
      search: input.query,
      top: messageBudget(maxResults),
    });
    // The To: header is dropped here and kept in list_threads, matching exactly
    // what gmail.search and gmail.list_threads return. Same shape, same reason
    // to prefer one over the other.
    const threads = groupByConversation(messages, maxResults).map((t) => ({
      id: t.id,
      snippet: t.snippet,
      from: t.from,
      subject: t.subject,
      date: t.date,
    }));
    return { threads };
  },
});
