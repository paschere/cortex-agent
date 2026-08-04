import { z } from 'zod';
import { registerTool } from '../index';
import { gmailFetch } from './client';

type MimePart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: MimePart[];
};

function decodeBase64Url(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm, 'base64').toString('utf-8');
}

function extractText(payload: MimePart | undefined): string {
  if (!payload) return '';
  if (payload.body?.data && payload.mimeType?.startsWith('text/plain')) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return '';
}

export const gmailReadThread = registerTool({
  id: 'gmail.read_thread',
  description:
    'Read a full Gmail thread by threadId — returns ordered messages with from/to/date/body.',
  inputSchema: z.object({ threadId: z.string() }),
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
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  ],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type GmailThread = {
      id: string;
      messages: Array<{
        id: string;
        payload: MimePart & { headers: Array<{ name: string; value: string }> };
      }>;
    };

    const thread = await gmailFetch<GmailThread>(ctx, `/threads/${input.threadId}?format=full`);

    const hdr = (headers: Array<{ name: string; value: string }>, name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

    const firstHeaders = thread.messages[0]?.payload.headers ?? [];
    const subject = hdr(firstHeaders, 'Subject');

    const messages = thread.messages.map((m) => ({
      from: hdr(m.payload.headers, 'From'),
      to: hdr(m.payload.headers, 'To'),
      date: hdr(m.payload.headers, 'Date'),
      body: extractText(m.payload),
    }));

    return { thread: { id: thread.id, subject, messages } };
  },
});
