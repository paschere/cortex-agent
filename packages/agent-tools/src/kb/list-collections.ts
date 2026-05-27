import { z } from 'zod';
import { registerTool } from '../index';

export const kbListCollections = registerTool({
  id: 'kb.list_collections',
  description: 'List KB collections visible to the current user.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    collections: z.array(
      z.object({
        id: z.string().uuid(),
        scope: z.enum(['global', 'team', 'user', 'conversation']),
        name: z.string(),
        docCount: z.number().int(),
      }),
    ),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (_input, ctx) => {
    // Collect visible collection IDs per scope (service-role bypasses RLS, so we
    // must enforce visibility manually)

    const collectionIds: string[] = [];

    // Global
    {
      const { data, error } = await ctx.db
        .from('kb_collections')
        .select('id')
        .eq('scope', 'global');
      if (error) throw error;
      for (const c of data ?? []) collectionIds.push(c.id as string);
    }

    // Team — resolve user's memberships first
    {
      const { data: memberships, error: memErr } = await ctx.db
        .from('team_members')
        .select('team_id')
        .eq('user_id', ctx.userId);
      if (memErr) throw memErr;

      const teamIds = (memberships ?? []).map((m) => m.team_id as string);
      if (teamIds.length > 0) {
        const { data, error } = await ctx.db
          .from('kb_collections')
          .select('id')
          .eq('scope', 'team')
          .in('scope_id', teamIds);
        if (error) throw error;
        for (const c of data ?? []) collectionIds.push(c.id as string);
      }
    }

    // User-scoped
    {
      const { data, error } = await ctx.db
        .from('kb_collections')
        .select('id')
        .eq('scope', 'user')
        .eq('scope_id', ctx.userId);
      if (error) throw error;
      for (const c of data ?? []) collectionIds.push(c.id as string);
    }

    // Conversation-scoped
    if (ctx.conversationId) {
      const { data, error } = await ctx.db
        .from('kb_collections')
        .select('id')
        .eq('scope', 'conversation')
        .eq('scope_id', ctx.conversationId);
      if (error) throw error;
      for (const c of data ?? []) collectionIds.push(c.id as string);
    }

    if (collectionIds.length === 0) return { collections: [] };

    // Fetch full details + doc count for visible collections
    const { data: colData, error: colErr } = await ctx.db
      .from('kb_collections')
      .select('id, scope, name, kb_documents(count)')
      .in('id', collectionIds);
    if (colErr) throw colErr;

    type ColRow = {
      id: string;
      scope: 'global' | 'team' | 'user' | 'conversation';
      name: string;
      kb_documents: Array<{ count: number }> | [{ count: number }];
    };

    return {
      collections: ((colData as ColRow[]) ?? []).map((c) => ({
        id: c.id,
        scope: c.scope,
        name: c.name,
        docCount: Array.isArray(c.kb_documents) ? (c.kb_documents[0]?.count ?? 0) : 0,
      })),
    };
  },
});
