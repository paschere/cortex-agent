import { z } from 'zod';
import { registerTool } from '../index';
import { embed } from './embedder';

const Scope = z.enum(['global', 'team', 'user', 'conversation']);

const HitSchema = z.object({
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  chunkIndex: z.number().int(),
  content: z.string(),
  score: z.number(),
});

export const kbSearch = registerTool({
  id: 'kb.search',
  description:
    'Semantic + keyword hybrid search over visible KB collections. Returns top chunks with document titles for citation.',
  inputSchema: z.object({
    query: z.string().min(1),
    scopes: z.array(Scope).optional(),
    teamId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    hits: z.array(HitSchema),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    const scopes = input.scopes ?? ['global', 'team', 'user', 'conversation'];
    const collectionIds: string[] = [];

    // Resolve global collections
    if (scopes.includes('global')) {
      const { data, error } = await ctx.db
        .from('kb_collections')
        .select('id')
        .eq('scope', 'global');
      if (error) throw error;
      for (const c of data ?? []) collectionIds.push(c.id as string);
    }

    // Resolve team collections — need user's teams first
    if (scopes.includes('team')) {
      const { data: memberships, error: memErr } = await ctx.db
        .from('team_members')
        .select('team_id')
        .eq('user_id', ctx.userId);
      if (memErr) throw memErr;

      const teamIds = (memberships ?? []).map((m) => m.team_id as string);
      // Narrow to a specific team if provided and the user is a member
      const effectiveTeamIds =
        input.teamId && teamIds.includes(input.teamId) ? [input.teamId] : teamIds;

      if (effectiveTeamIds.length > 0) {
        const { data, error } = await ctx.db
          .from('kb_collections')
          .select('id')
          .eq('scope', 'team')
          .in('scope_id', effectiveTeamIds);
        if (error) throw error;
        for (const c of data ?? []) collectionIds.push(c.id as string);
      }
    }

    // Resolve user-scoped collections
    if (scopes.includes('user')) {
      const { data, error } = await ctx.db
        .from('kb_collections')
        .select('id')
        .eq('scope', 'user')
        .eq('scope_id', ctx.userId);
      if (error) throw error;
      for (const c of data ?? []) collectionIds.push(c.id as string);
    }

    // Resolve conversation-scoped collections
    if (scopes.includes('conversation')) {
      const effectiveConvId = input.conversationId ?? ctx.conversationId;
      if (effectiveConvId) {
        const { data, error } = await ctx.db
          .from('kb_collections')
          .select('id')
          .eq('scope', 'conversation')
          .eq('scope_id', effectiveConvId);
        if (error) throw error;
        for (const c of data ?? []) collectionIds.push(c.id as string);
      }
    }

    if (collectionIds.length === 0) return { hits: [] };

    const [embedding] = await embed([input.query]);
    const { data: rows, error: rpcErr } = await ctx.db.rpc('kb_hybrid_search', {
      p_collection_ids: collectionIds,
      p_query_embedding: embedding,
      p_query_text: input.query,
      p_limit: input.limit,
    });
    if (rpcErr) throw rpcErr;

    type Row = {
      document_id: string;
      document_title: string;
      chunk_index: number;
      content: string;
      score: number;
    };

    return {
      hits: ((rows as Row[]) ?? []).map((r) => ({
        documentId: r.document_id,
        documentTitle: r.document_title,
        chunkIndex: r.chunk_index,
        content: r.content,
        score: Number(r.score),
      })),
    };
  },
});
