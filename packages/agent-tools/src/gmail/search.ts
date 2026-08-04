import { z } from 'zod';
import { registerTool } from '../index';
import { gmailFetch } from './client';

export const gmailSearch = registerTool({
  id: 'gmail.search',
  description:
    'Search the user\'s Gmail with a Gmail query string (e.g., "from:foo subject:bar newer_than:30d"). Returns subject, snippet, from, and date per thread. ' +
    "gmail.list_threads runs the same search and returns the same rows plus the To: header, and takes a contact's address directly instead of making you write the query — prefer it when you are looking at correspondence with a particular person.",
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
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  ],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type ThreadList = { threads?: Array<{ id: string; snippet?: string }> };
    const list = await gmailFetch<ThreadList>(
      ctx,
      `/threads?q=${encodeURIComponent(input.query)}&maxResults=${input.maxResults}`,
    );

    const out: Array<{
      id: string;
      snippet: string;
      from: string | null;
      subject: string | null;
      date: string | null;
    }> = [];

    for (const t of list.threads ?? []) {
      type ThreadMeta = {
        id: string;
        snippet?: string;
        messages?: Array<{
          payload?: {
            headers?: Array<{ name: string; value: string }>;
          };
        }>;
      };
      const thread = await gmailFetch<ThreadMeta>(ctx, `/threads/${t.id}?format=metadata`);
      const headers = thread.messages?.[0]?.payload?.headers ?? [];
      const hdr = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

      out.push({
        id: thread.id,
        snippet: thread.snippet ?? t.snippet ?? '',
        from: hdr('From'),
        subject: hdr('Subject'),
        date: hdr('Date'),
      });
    }

    return { threads: out };
  },
});
