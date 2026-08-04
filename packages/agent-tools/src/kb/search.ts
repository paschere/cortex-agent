import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { listVisibleSpaces, resolveSpaceByName, searchSpaces } from './spaces';

const HitSchema = z.object({
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  space: z.string(),
  spaceKind: z.enum(['global', 'personal']),
  chunkIndex: z.number().int(),
  content: z.string(),
  score: z.number(),
});

/**
 * The tool no longer takes "which scopes to search". It used to, and that was
 * the bug: the model chose the breadth of its own retrieval, and one of the
 * choices ('conversation') reached across users. What is searchable is now a
 * fact about who is asking, decided in Postgres from `ctx.userId`. The only
 * thing the caller can express is a NARROWING, by name, to a space it can
 * already see.
 */
export const kbSearch = registerTool({
  id: 'kb.search',
  description:
    "Search the company's Knowledge Base — client notes, playbooks, rates, past proposals, anything saved to it. ONE query in, raw matching excerpts out. Searches every company-wide space plus the asker's own personal spaces, and nobody else's. Pass `space` with a space name to look in just one. Each result says which space it came from, so you can tell the person whether what you found is company knowledge or their own note. " +
    'Use this to look one specific thing up. When you are about to WRITE something that should reflect what the company knows — a proposal, a client email, a rate answer — use kb.context instead: it runs several angles at once and hands back grouped, citable sources. Do not call this three times in a row to do that by hand.',
  inputSchema: z.object({
    query: z.string().min(1),
    space: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Name of a single space to search in, e.g. "Rates" — omit to search everything'),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    hits: z.array(HitSchema),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    let spaceIds: string[] | undefined;

    if (input.space) {
      const space = await resolveSpaceByName(ctx.db, ctx.userId, input.space);
      if (!space) {
        const names = (await listVisibleSpaces(ctx.db, ctx.userId)).map((s) => s.name);
        throw new ValidationError(
          names.length > 0
            ? `There is no space called "${input.space}". You can search: ${names.join(', ')}.`
            : `There is no space called "${input.space}", and nothing has been shared with you yet.`,
        );
      }
      spaceIds = [space.id];
    }

    const hits = await searchSpaces(ctx.db, {
      userId: ctx.userId,
      query: input.query,
      ...(spaceIds ? { spaceIds } : {}),
      limit: input.limit,
    });

    return {
      hits: hits.map((h) => ({
        documentId: h.documentId,
        documentTitle: h.documentTitle,
        space: h.spaceName,
        spaceKind: h.spaceKind,
        chunkIndex: h.chunkIndex,
        content: h.content,
        score: h.score,
      })),
    };
  },
});
