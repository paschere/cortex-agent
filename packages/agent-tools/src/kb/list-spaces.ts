import { z } from 'zod';
import { registerTool } from '../index';
import { listVisibleSpaces } from './spaces';

export const kbListSpaces = registerTool({
  id: 'kb.list_spaces',
  description:
    'List the Brain Knowledge spaces the person can reach, each with what they may DO there. Use it before saving something, so you can say where it went — and so you never offer to save into a space they can only read. Never read the ids back to anyone; refer to spaces by name. ' +
    "`kind` says who else is in there, and it changes how you may quote what you find: 'global' is the whole company, 'shared' is a space given to some teams or people (material from it must not be repeated to somebody outside that circle), 'personal' is this person's own notebook. " +
    "`can` is 'view' (search and read), 'contribute' (also save here) or 'admin' (also decide who else gets in).",
  inputSchema: z.object({}),
  outputSchema: z.object({
    spaces: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        kind: z.enum(['global', 'shared', 'personal']),
        /** Lo que esta persona puede hacer aquí. Ver la migración 0123. */
        can: z.enum(['view', 'contribute', 'admin']),
        description: z.string().nullable(),
        documents: z.number().int(),
      }),
    ),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (_input, ctx) => {
    const spaces = await listVisibleSpaces(ctx.db, ctx.userId);
    if (spaces.length === 0) return { spaces: [] };

    // One grouped count rather than a count per space: the list is short, but
    // it is fetched on most turns that touch the KB.
    const { data: docs, error } = await ctx.db
      .from('kb_documents')
      .select('collection_id')
      .in(
        'collection_id',
        spaces.map((s) => s.id),
      );
    if (error) throw error;

    const counts = new Map<string, number>();
    for (const d of docs ?? []) {
      const id = d.collection_id as string;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    return {
      spaces: spaces.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        can: s.level,
        description: s.description,
        documents: counts.get(s.id) ?? 0,
      })),
    };
  },
});
