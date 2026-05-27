import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { z } from 'zod';
import type { CollectionScope } from '@zipdev/core';

const CreateCollectionBody = z.object({
  name: z.string().min(1).max(200),
  scope: z.enum(['global', 'team', 'user', 'conversation']),
  scope_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  gdrive_folder_id: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const sb = getSupabaseServiceClient();
  const url = new URL(req.url);
  const scopeFilter = url.searchParams.get('scope') as CollectionScope | null;

  let query = sb.from('kb_collections').select('*');

  if (scopeFilter) {
    query = query.eq('scope', scopeFilter);
  } else {
    // Return all collections visible to this user:
    // - global collections
    // - user-scoped collections owned by this user
    // - team-scoped collections for teams the user belongs to
    // For MVP, org_admins see everything
    if (session.role !== 'org_admin') {
      const { data: memberships } = await sb
        .from('team_members')
        .select('team_id')
        .eq('user_id', session.id);
      const teamIds = (memberships ?? []).map((m) => m.team_id as string);

      // Fetch global + user-scoped + teams the user belongs to
      const filters = [
        `scope.eq.global`,
        `and(scope.eq.user,scope_id.eq.${session.id})`,
      ];
      if (teamIds.length > 0) {
        filters.push(
          `and(scope.eq.team,scope_id.in.(${teamIds.join(',')}))`,
        );
      }
      query = query.or(filters.join(','));
    }
  }

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ collections: data });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const sb = getSupabaseServiceClient();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = CreateCollectionBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { name, scope, scope_id, agent_id, gdrive_folder_id } = parsed.data;

  // Authorization gates per scope
  if (scope === 'global' && session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Only org admins can create global collections' },
      { status: 403 },
    );
  }

  if (scope === 'user') {
    // User-scoped collections must be owned by the requesting user (or org_admin)
    if (scope_id && scope_id !== session.id && session.role !== 'org_admin') {
      return NextResponse.json(
        { error: 'Cannot create user collection for another user' },
        { status: 403 },
      );
    }
  }

  if (scope === 'team' && scope_id) {
    if (session.role !== 'org_admin') {
      // Check that user is a member (or team_admin) of the target team
      const { data: membership } = await sb
        .from('team_members')
        .select('role')
        .eq('team_id', scope_id)
        .eq('user_id', session.id)
        .maybeSingle();
      if (!membership) {
        return NextResponse.json(
          { error: 'Not a member of the specified team' },
          { status: 403 },
        );
      }
    }
  }

  // Resolve scope_id for user scope
  const resolvedScopeId =
    scope === 'global' ? null : (scope_id ?? (scope === 'user' ? session.id : null));

  if (scope !== 'global' && !resolvedScopeId) {
    return NextResponse.json(
      { error: 'scope_id is required for non-global collections' },
      { status: 422 },
    );
  }

  // For scope='conversation' and scope='user', findOrCreate by (scope, scope_id, name) to avoid duplicates.
  if (scope === 'conversation' || scope === 'user') {
    const { data: existing } = await sb
      .from('kb_collections')
      .select('id, scope, scope_id, name, agent_id, gdrive_folder_id, created_at')
      .eq('scope', scope)
      .eq('scope_id', resolvedScopeId!)
      .eq('name', name)
      .maybeSingle();
    if (existing) {
      return Response.json({ collection: existing }, { status: 200 });
    }
  }

  const { data, error } = await sb
    .from('kb_collections')
    .insert({
      name,
      scope,
      scope_id: resolvedScopeId,
      agent_id: agent_id ?? null,
      gdrive_folder_id: gdrive_folder_id ?? null,
    })
    .select('*')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ collection: data }, { status: 201 });
}
