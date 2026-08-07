import { z } from 'zod';
import { registerTool } from '../index';
import { GRAPH_SCOPES, type GraphMessage, graphFetch } from '../msgraph/client';
import { fetchConversation } from './threads';

function recipients(list: string[] | undefined): Array<{ emailAddress: { address: string } }> {
  return (list ?? []).map((address) => ({ emailAddress: { address } }));
}

export const outlookDraft = registerTool({
  id: 'outlook.draft',
  description:
    'Create an Outlook / Microsoft 365 draft (never sends). Returns the draft id and a deep link. The user must open Outlook — or call outlook.send_draft — to send it. The Microsoft 365 twin of gmail.draft.',
  inputSchema: z.object({
    to: z.array(z.string().email()).min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
    threadId: z
      .string()
      .optional()
      .describe('Conversation id from outlook.search — makes this a reply in that thread'),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
  }),
  outputSchema: z.object({
    draftId: z.string(),
    messageId: z.string(),
    deepLink: z.string(),
  }),
  // Mail.ReadWrite rather than Mail.Send: creating a draft is a write to the
  // user's own mailbox and delivers nothing. Sending is a separate permission
  // asked for by a separate tool, so a workspace that only wants Cortex to
  // PREPARE mail can consent to this and withhold that.
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.MAIL_READ_WRITE] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const payload = {
      subject: input.subject,
      // Plain text, like the RFC822 the Gmail side builds. Cortex writes prose,
      // not layouts, and text cannot carry a tracking pixel or a broken style.
      body: { contentType: 'Text', content: input.body },
      toRecipients: recipients(input.to),
      ccRecipients: recipients(input.cc),
      bccRecipients: recipients(input.bcc),
    };

    let draft: GraphMessage;

    if (input.threadId) {
      // A REPLY, not a new message with a copied subject. Gmail takes a
      // threadId on the draft itself; Graph needs a specific message to reply
      // to, so we take the last one in the conversation. That is what makes the
      // reply thread correctly in everyone else's client: Outlook sets
      // In-Reply-To/References from the message, not from the subject line.
      const thread = await fetchConversation(ctx, input.threadId, { top: 50 });
      const last = thread.filter((m) => !m.isDraft).pop() ?? thread[thread.length - 1];
      if (!last) {
        throw new Error(
          `No message found in conversation ${input.threadId}. It may have been deleted or moved out of this mailbox — search again and use the id from the result.`,
        );
      }
      const reply = await graphFetch<GraphMessage>(
        ctx,
        `/me/messages/${encodeURIComponent(last.id)}/createReply`,
        { method: 'POST' },
      );
      // createReply pre-fills the recipients and quotes the original. The PATCH
      // replaces both with what the caller actually asked for, so `to` means
      // the same thing here as it does in gmail.draft.
      draft = await graphFetch<GraphMessage>(ctx, `/me/messages/${encodeURIComponent(reply.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      draft = await graphFetch<GraphMessage>(ctx, '/me/messages', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }

    return {
      draftId: draft.id,
      // In Graph a draft IS a message, so these are the same id — unlike Gmail,
      // where a draft wraps a message. Both are returned so a caller written
      // against the Gmail shape keeps working.
      messageId: draft.id,
      deepLink: draft.webLink ?? `https://outlook.office.com/mail/drafts/id/${draft.id}`,
    };
  },
});
