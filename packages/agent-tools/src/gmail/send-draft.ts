import { z } from 'zod';
import { registerTool } from '../index';
import { gmailFetch } from './client';

export const gmailSendDraft = registerTool({
  id: 'gmail.send_draft',
  description:
    'Send an existing Gmail draft by its draftId (the id returned by gmail_draft). Requires user confirmation. Pre-fetches the draft to surface recipient and subject before sending.',
  inputSchema: z.object({
    draftId: z.string().describe('ID returned by gmail_draft'),
  }),
  outputSchema: z.object({
    messageId: z.string(),
    threadId: z.string().nullable(),
    to: z.string().nullable(),
    subject: z.string().nullable(),
    snippet: z.string(),
  }),
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.compose'] }],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // Pre-flight: fetch draft metadata so the confirmation prompt can show to/subject/snippet.
    type DraftMeta = {
      id: string;
      message?: {
        snippet?: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
        };
      };
    };
    const draft = await gmailFetch<DraftMeta>(
      ctx,
      `/drafts/${encodeURIComponent(input.draftId)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`,
    );
    const headers = draft.message?.payload?.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
    const to = hdr('To');
    const subject = hdr('Subject');
    const snippet = draft.message?.snippet ?? '';

    type SendResponse = { id: string; threadId?: string };
    const r = await gmailFetch<SendResponse>(ctx, '/drafts/send', {
      method: 'POST',
      body: JSON.stringify({ id: input.draftId }),
    });

    return {
      messageId: r.id,
      threadId: r.threadId ?? null,
      to,
      subject,
      snippet,
    };
  },
});
