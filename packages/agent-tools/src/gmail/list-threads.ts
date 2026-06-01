import { z } from 'zod';
import { registerTool } from '../index';
import { gmailFetch } from './client';

export const gmailListThreads = registerTool({
  id: 'gmail.list_threads',
  description:
    'List recent Gmail threads for a contact or a Gmail query string. Provide contactEmail (filters to/from that address) and/or query (raw Gmail search syntax). Returns subject, from, to, date, and snippet per thread.',
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
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const q = [
      input.contactEmail ? `(from:${input.contactEmail} OR to:${input.contactEmail})` : '',
      input.query ?? '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    type ThreadList = { threads?: Array<{ id: string; snippet?: string }> };
    const list = await gmailFetch<ThreadList>(
      ctx,
      `/threads?q=${encodeURIComponent(q)}&maxResults=${input.maxResults}`,
    );

    type ThreadMeta = {
      id: string;
      snippet?: string;
      messages?: Array<{
        payload?: {
          headers?: Array<{ name: string; value: string }>;
        };
      }>;
    };

    const threads = await Promise.all(
      (list.threads ?? []).map(async (t) => {
        const thread = await gmailFetch<ThreadMeta>(
          ctx,
          `/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
        );
        const headers = thread.messages?.[0]?.payload?.headers ?? [];
        const hdr = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
        return {
          id: thread.id,
          snippet: thread.snippet ?? t.snippet ?? '',
          from: hdr('From'),
          to: hdr('To'),
          subject: hdr('Subject'),
          date: hdr('Date'),
        };
      }),
    );

    return { threads };
  },
});
