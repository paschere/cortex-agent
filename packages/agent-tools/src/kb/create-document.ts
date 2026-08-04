import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { ingestMarkdown } from './ingest';
import {
  assertCanWriteToSpace,
  ensurePersonalSpace,
  listVisibleSpaces,
  resolveSpaceByName,
} from './spaces';

export const kbCreateDocument = registerTool({
  id: 'kb.create_document',
  description:
    "Save Markdown into the company's Brain Knowledge so it can be found later. Pass `space` with the name of the space it belongs in; leave it out and it goes into the person's own notes, which only they can see. Saving into a company-wide space needs org admin rights, because everyone's Cortex will answer from it. Tell the person which space it landed in.",
  inputSchema: z.object({
    title: z.string().min(1),
    markdown: z.string().min(1),
    space: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Name of the space to save into — omit for the person's own notes"),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    chunks: z.number().int(),
    space: z.string(),
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

    const { documentId, chunks } = await ingestMarkdown(ctx.db, {
      collectionId: spaceId,
      title: input.title,
      content: input.markdown,
      uploadedBy: ctx.userId,
    });

    return { documentId, chunks, space: spaceName };
  },
});
