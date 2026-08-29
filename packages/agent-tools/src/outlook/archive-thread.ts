import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { ensurePersonalSpace, resolveSpaceByName } from '../kb/spaces';
import { GRAPH_SCOPES } from '../msgraph/client';
import { fetchOutlookAttachment, listOutlookAttachments } from './attachments';
import { ingestThread } from './ingest-thread';
import { fetchConversation } from './threads';

export const outlookArchiveThread = registerTool({
  id: 'outlook.archive_thread',
  description:
    'Save an Outlook mail thread into Brain Knowledge so it can be searched and quoted months later, with who wrote each message and when. ' +
    'Only correspondence with people OUTSIDE the company — clients, suppliers, brokers, carriers — can be archived; a thread where everyone works here is refused, the same way a WhatsApp direct message is never archived. ' +
    'Re-running it on a thread that has grown refreshes the same document instead of creating a second one.',
  inputSchema: z.object({
    threadId: z
      .string()
      .min(1)
      .describe('Conversation id from outlook.search or outlook.list_threads'),
    spaceName: z
      .string()
      .optional()
      .describe(
        'Brain Knowledge space to file it in, by name. Omitted means your own private space.',
      ),
  }),
  outputSchema: z.object({
    outcome: z.enum(['imported', 'updated', 'unchanged', 'internal', 'empty', 'failed']),
    note: z.string(),
    documentId: z.string().nullable(),
    spaceName: z.string(),
    counterpartDomain: z.string().nullable(),
    clientLinked: z.boolean(),
    chunks: z.number(),
    messages: z.number(),
    participants: z.array(z.string()),
    /**
     * Lo que venía colgando del hilo y entró como documento aparte. `skipped`
     * cuenta lo que se vio y se descartó a propósito — un vídeo, un .zip, un
     * escaneo sin texto — y merece decirse: quien preguntó por «el contrato»
     * necesita saber si se descartó, no sólo si no apareció.
     */
    attachments: z.object({
      archived: z.number(),
      skipped: z.number(),
      failed: z.number(),
    }),
  }),
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.MAIL_READ] }],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // Where it lands, resolved BEFORE anything is fetched. `assertCanWriteToSpace`
    // runs inside ingestThread and refuses a company-wide space to anyone who is
    // not an org admin — so publishing a client thread to everybody stays an
    // explicit act by somebody with the authority.
    const space = input.spaceName
      ? await resolveSpaceByName(ctx.db, ctx.userId, input.spaceName)
      : await ensurePersonalSpace(ctx.db, ctx.userId);
    if (!space) {
      throw new NotFoundError(
        `No Brain Knowledge space called "${input.spaceName}" that you can write to. Ask for the list of spaces, or leave it out to file this in your own notes.`,
      );
    }

    const messages = await fetchConversation(ctx, input.threadId, { withBody: true, top: 100 });
    if (messages.length === 0) {
      throw new ValidationError(
        `No messages in conversation ${input.threadId}. It may have been deleted or moved out of this mailbox — search again and use the id from the result.`,
      );
    }

    const result = await ingestThread(
      {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        db: ctx.db,
        logger: ctx.logger,
      },
      { conversationId: input.threadId, spaceId: space.id, messages },
      // What was hanging off the thread — the contract, the proposal, the
      // quote — enters the brain as its own document instead of as the sentence
      // "please find attached". See mail/attachments.ts.
      {
        attachments: {
          list: (messageId) => listOutlookAttachments(ctx, messageId),
          fetch: (messageId, attachmentId) => fetchOutlookAttachment(ctx, messageId, attachmentId),
        },
      },
    );

    return {
      outcome: result.outcome,
      note: result.note,
      documentId: result.documentId,
      spaceName: space.name,
      counterpartDomain: result.counterpartDomain,
      // The id itself is never returned: it is a database key nobody can act on,
      // and a model that sees one will try to quote it.
      clientLinked: result.clientId !== null,
      chunks: result.chunks,
      messages: result.messages,
      participants: result.participants,
      attachments: result.attachments,
    };
  },
});
