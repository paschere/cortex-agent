import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { buildToolContext } from '@/lib/agent';
import { getTool, runTool } from '@zipdev/agent-tools';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

const Body = z.object({
  action: z.enum(['approve', 'decline']),
});

const Id = z.string().uuid();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireSession();

  const { id: rawId } = await params;
  const idParsed = Id.safeParse(rawId);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const id = idParsed.data;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = getSupabaseServiceClient();

  // Ownership check: the pending action must belong to the signed-in user.
  const { data: row } = await db
    .from('mcp_pending_actions')
    .select('id, tool_id, agent_id, input, expires_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: 'Pending action not found' }, { status: 403 });
  }

  if (parsed.data.action === 'decline') {
    await db.from('mcp_pending_actions').delete().eq('id', id).eq('user_id', user.id);
    return NextResponse.json({ ok: true, declined: true });
  }

  if (new Date(row.expires_at as string).getTime() <= Date.now()) {
    // Stale row: clean it up and tell the user to re-stage.
    await db.from('mcp_pending_actions').delete().eq('id', id).eq('user_id', user.id);
    return NextResponse.json(
      { error: 'This confirmation has expired. Ask Zippy to stage the action again.' },
      { status: 410 },
    );
  }

  const toolDef = getTool(row.tool_id as string);
  if (!toolDef) {
    return NextResponse.json({ error: `Unknown tool: ${row.tool_id}` }, { status: 404 });
  }

  // Consume (delete + return) BEFORE executing so the action is single-use
  // even under concurrent clicks: whoever loses the delete race gets a 409.
  const { data: consumed } = await db
    .from('mcp_pending_actions')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('tool_id, agent_id, input')
    .maybeSingle();

  if (!consumed) {
    return NextResponse.json(
      { error: 'This action was already handled (approved or declined elsewhere).' },
      { status: 409 },
    );
  }

  const ctx = buildToolContext({
    userId: user.id,
    agentId: consumed.agent_id as string,
  });

  let out: unknown;
  try {
    out = await runTool(toolDef, consumed.input, ctx, { confirmed: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ result: out });
}
