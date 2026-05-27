import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { embed } from '@zipdev/agent-tools/src/kb/embedder';
import { z } from 'zod';
import type { CollectionScope } from '@zipdev/core';

const SearchBody = z.object({
  query: z.string().min(1).max(1000),
  scopes: z
    .array(z.enum(['global', 'team', 'user', 'conversation']))
    .optional(),
  collection_ids: z.array(z.string().uuid()).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const sb = getSupabaseServiceClient();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = SearchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { query, scopes, collection_ids, limit = 8 } = parsed.data;

  // Resolve collection IDs from explicit list or scope filter
  let collectionIds: string[];

  if (collection_ids && collection_ids.length > 0) {
    collectionIds = collection_ids;
  } else {
    // Build scope filter — default to all visible scopes
    const targetScopes: CollectionScope[] = scopes ?? [
      'global',
      'team',
      'user',
      'conversation',
    ];

    let colQuery = sb.from('kb_collections').select('id, scope, scope_id');

    if (session.role !== 'org_admin') {
      const { data: memberships } = await sb
        .from('team_members')
        .select('team_id')
        .eq('user_id', session.id);
      const teamIds = (memberships ?? []).map((m) => m.team_id as string);

      const filters: string[] = [];
      if (targetScopes.includes('global')) {
        filters.push('scope.eq.global');
      }
      if (targetScopes.includes('user')) {
        filters.push(`and(scope.eq.user,scope_id.eq.${session.id})`);
      }
      if (targetScopes.includes('team') && teamIds.length > 0) {
        filters.push(
          `and(scope.eq.team,scope_id.in.(${teamIds.join(',')}))`,
        );
      }
      if (targetScopes.includes('conversation')) {
        // Conversation-scoped: scope_id is the conversation id; we trust the caller
        // to provide explicit collection_ids for conversation scope when possible.
        // For broad search, include all conversation collections (scoped by other means).
        filters.push('scope.eq.conversation');
      }

      if (filters.length === 0) {
        return NextResponse.json({ hits: [] });
      }
      colQuery = colQuery.or(filters.join(','));
    }

    if (targetScopes.length < 4) {
      colQuery = colQuery.in('scope', targetScopes);
    }

    const { data: cols } = await colQuery;
    collectionIds = (cols ?? []).map((c) => c.id as string);
  }

  if (collectionIds.length === 0) {
    return NextResponse.json({ hits: [] });
  }

  // Embed the query
  const [queryEmbedding] = await embed([query]);
  if (!queryEmbedding) {
    return NextResponse.json({ error: 'Embedding failed' }, { status: 500 });
  }

  // Run hybrid search RPC
  const { data, error } = await sb.rpc('kb_hybrid_search', {
    p_collection_ids: collectionIds,
    p_query_embedding: queryEmbedding,
    p_query_text: query,
    p_limit: limit,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type HybridSearchRow = {
    document_id: string;
    document_title: string;
    chunk_index: number;
    content: string;
    score: number;
  };

  // Map snake_case DB columns to camelCase for API consumers
  const rows = (data as HybridSearchRow[] | null) ?? [];
  const hits = rows.map((row) => ({
    documentId: row.document_id,
    documentTitle: row.document_title,
    chunkIndex: row.chunk_index,
    content: row.content,
    score: row.score,
  }));

  return NextResponse.json({ hits });
}
