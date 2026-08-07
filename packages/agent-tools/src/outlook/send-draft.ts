import { z } from 'zod';
import { registerTool } from '../index';
import {
  GRAPH_SCOPES,
  type GraphMessage,
  MESSAGE_SELECT,
  formatRecipients,
  graphFetch,
} from '../msgraph/client';

export const outlookSendDraft = registerTool({
  id: 'outlook.send_draft',
  description:
    'Send an existing Outlook / Microsoft 365 draft by its draftId (the id returned by outlook.draft). Requires user confirmation. Pre-fetches the draft to surface recipient and subject before sending. The Microsoft 365 twin of gmail.send_draft.',
  inputSchema: z.object({
    draftId: z.string().min(1).describe('ID returned by outlook.draft'),
  }),
  outputSchema: z.object({
    messageId: z.string(),
    threadId: z.string().nullable(),
    to: z.string().nullable(),
    subject: z.string().nullable(),
    snippet: z.string(),
  }),
  requiresConfirmation: true,
  // Mail.Send only. Sending does not need to read the mailbox, and this tool is
  // the single place in the family where something actually leaves the company.
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.MAIL_SEND] }],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // Pre-flight, exactly as the Gmail tool does it: the confirmation prompt has
    // to show WHO this is going to before a human approves it. Reading the
    // draft needs Mail.Read/ReadWrite, which the drafting half of the family
    // already required to create it.
    const draft = await graphFetch<GraphMessage>(
      ctx,
      `/me/messages/${encodeURIComponent(input.draftId)}?$select=${MESSAGE_SELECT}`,
    );

    // Graph answers 204 with no body. The ids below therefore come from the
    // pre-flight read, not from the send.
    await graphFetch<void>(ctx, `/me/messages/${encodeURIComponent(input.draftId)}/send`, {
      method: 'POST',
    });

    return {
      messageId: draft.id,
      threadId: draft.conversationId ?? null,
      to: formatRecipients(draft.toRecipients),
      subject: draft.subject ?? null,
      snippet: (draft.bodyPreview ?? '').trim(),
    };
  },
});
