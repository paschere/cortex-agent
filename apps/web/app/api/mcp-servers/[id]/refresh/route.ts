import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { syncExternalServerManifest } from '@cortex/agent-tools';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  // Verify ownership.
  const { data: existing, error: ownErr } = await db
    .from('user_mcp_servers')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (ownErr || !existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Synchronously re-sync (this never throws; it records last_error on failure).
  await syncExternalServerManifest(db, user.id, id);

  const { data: server } = await db
    .from('user_mcp_servers')
    .select('tool_count, last_error')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  const { data: toolRows } = await db
    .from('user_mcp_tools')
    .select('tool_name, tool_description')
    .eq('server_id', id);

  const tools = (toolRows ?? []).map((t) => ({
    name: t.tool_name as string,
    description: (t.tool_description as string | null) ?? '',
  }));

  return NextResponse.json({
    tools,
    toolCount: (server?.tool_count as number | undefined) ?? tools.length,
    lastError: (server?.last_error as string | null | undefined) ?? null,
  });
}
