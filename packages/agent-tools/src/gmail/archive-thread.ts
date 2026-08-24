import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { ensurePersonalSpace, resolveSpaceByName } from '../kb/spaces';
import { ingestThread } from './ingest-thread';
import { fetchThreadMessages } from './threads';

export const gmailArchiveThread = registerTool({
  id: 'gmail.archive_thread',
  description:
    'Save a Gmail thread into Brain Knowledge so it can be searched and quoted months later, with who wrote each message and when. ' +
    'Filed in your own private space by default, where anything from your mailbox may go. Into a SHARED space, only correspondence with people outside the company can be filed — a thread where everyone works here is refused, the same way a WhatsApp direct message is never archived. ' +
    'Re-running it on a thread that has grown refreshes the same document instead of creating a second one.',
  inputSchema: z.object({
    threadId: z.string().min(1).describe('Thread id from gmail.search or gmail.list_threads'),
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
    internalOnly: z.boolean(),
    chunks: z.number(),
    messages: z.number(),
    participants: z.array(z.string()),
  }),
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  ],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // Dónde aterriza, resuelto ANTES de traer nada. `assertCanWriteToSpace`
    // corre dentro de `ingestThread` y le niega un espacio de toda la empresa a
    // quien no sea admin — así que publicar un hilo con un cliente para todo el
    // mundo sigue siendo un acto explícito de alguien con autoridad.
    const space = input.spaceName
      ? await resolveSpaceByName(ctx.db, ctx.userId, input.spaceName)
      : await ensurePersonalSpace(ctx.db, ctx.userId);
    if (!space) {
      throw new NotFoundError(
        `No Brain Knowledge space called "${input.spaceName}" that you can write to. Ask for the list of spaces, or leave it out to file this in your own notes.`,
      );
    }

    const messages = await fetchThreadMessages(ctx, input.threadId);
    if (messages.length === 0) {
      throw new ValidationError(
        `No messages in thread ${input.threadId}. It may have been deleted — search again and use the id from the result.`,
      );
    }

    const result = await ingestThread(
      {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        db: ctx.db,
        logger: ctx.logger,
      },
      { threadId: input.threadId, spaceId: space.id, messages },
    );

    return {
      outcome: result.outcome,
      note: result.note,
      documentId: result.documentId,
      spaceName: space.name,
      counterpartDomain: result.counterpartDomain,
      // El id nunca se devuelve: es una clave de base de datos sobre la que
      // nadie puede actuar, y un modelo que ve una la intenta citar.
      clientLinked: result.clientId !== null,
      internalOnly: result.internalOnly,
      chunks: result.chunks,
      messages: result.messages,
      participants: result.participants,
    };
  },
});
