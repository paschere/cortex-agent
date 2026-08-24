import { z } from 'zod';
import { registerTool } from '../index';
import { gmailFetch } from './client';
// El desenvolvedor de MIME vive en ./mime desde la 0121, porque la ingesta al
// cerebro lee los mismos cuerpos y dos copias acabarían leyendo distinto.
import { type MimePart, extractText } from './mime';

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
