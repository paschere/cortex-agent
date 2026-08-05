import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { ingestMarkdown } from './ingest';
import {
  assertCanWriteToSpace,
  ensurePersonalSpace,
  getVisibleDocument,
  listVisibleSpaces,
  resolveSpaceByName,
} from './spaces';

export const kbCreateDocument = registerTool({
  id: 'kb.create_document',
  description:
    "Save Markdown into the company's Brain Knowledge so it can be found later. Pass `space` with the name of the space it belongs in; leave it out and it goes into the person's own notes, which only they can see. Saving into a company-wide space needs org admin rights, because everyone's Cortex will answer from it. Tell the person which space it landed in. " +
    'When what you are saving REPLACES something already in there — a new rate card over the old one, a renewed policy over the expired one — pass `replaces` with the id of the old document (search returns it as `documentId`). The old one stays searchable, but every future answer that cites it will say it was replaced by this one, instead of quoting it as if it were still in force. Only use it for a genuine replacement of the same thing: two rate cards for two different clients are not versions of each other.',
  inputSchema: z.object({
    title: z.string().min(1),
    markdown: z.string().min(1),
    space: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Name of the space to save into — omit for the person's own notes"),
    replaces: z
      .string()
      .uuid()
      .optional()
      .describe('documentId of the document this one supersedes — only for a real replacement'),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    chunks: z.number().int(),
    space: z.string(),
    /** Set when this document was recorded as the replacement of another. */
    replaced: z.string().optional(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    let spaceId: string;
    let spaceName: string;

    if (input.space) {
      const target = await resolveSpaceByName(ctx.db, ctx.userId, input.space);
      if (!target) {
        const names = (await listVisibleSpaces(ctx.db, ctx.userId)).map((s) => s.name);
        throw new ValidationError(
          `There is no space called "${input.space}". You can save to: ${names.join(', ')}.`,
        );
      }
      // Being able to read a space is not being able to add to it: everyone
      // sees the company-wide ones, only an admin writes to them.
      await assertCanWriteToSpace(ctx.db, ctx.userId, target.id);
      spaceId = target.id;
      spaceName = target.name;
    } else {
      // The unnamed default is the private one on purpose. Something saved to
      // the wrong private space is a move; something saved to the wrong shared
      // space has already been read by other people's answers.
      const own = await ensurePersonalSpace(ctx.db, ctx.userId);
      spaceId = own.id;
      spaceName = own.name;
    }

    // Checked BEFORE anything is written: pointing at a document the caller
    // cannot see must fail as "no such document", and it must fail before a
    // half-done replacement exists.
    const replaced = input.replaces
      ? await getVisibleDocument(ctx.db, ctx.userId, input.replaces)
      : null;

    const { documentId, chunks } = await ingestMarkdown(ctx.db, {
      collectionId: spaceId,
      title: input.title,
      content: input.markdown,
      uploadedBy: ctx.userId,
    });

    if (replaced) {
      if (replaced.id === documentId) {
        throw new ValidationError('A document cannot replace itself.');
      }
      // Recorded on the OLD document, so retrieval finds it without a second
      // lookup: every hit already knows whether something newer exists. A
      // failure here must not lose the document that was just saved — it is
      // stored and searchable, it simply is not yet marked as the replacement.
      const { error } = await ctx.db
        .from('kb_documents')
        .update({ superseded_by: documentId, superseded_at: new Date().toISOString() })
        .eq('id', replaced.id);
      if (error) {
        ctx.logger.warn(
          { err: error.message, documentId, replaces: replaced.id },
          'saved the document but could not mark the old one as replaced',
        );
        return { documentId, chunks, space: spaceName };
      }
    }

    return {
      documentId,
      chunks,
      space: spaceName,
      ...(replaced ? { replaced: replaced.title } : {}),
    };
  },
});
