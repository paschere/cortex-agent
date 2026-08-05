import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { buildToolContext } from '@/lib/agent';
import { getTool, runTool } from '@cortex/agent-tools';
import { getOrgScopedClient } from '@/lib/supabase/service';

const Body = z.object({
  conversationId: z.string().uuid(),
  toolId: z.string(),
  input: z.unknown(),
  toolCallId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();

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

  const db = getOrgScopedClient(user.organization.id);
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('agent_id')
    .eq('id', parsed.data.conversationId)
    .eq('user_id', user.id)
    .single();

  if (convErr || !conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const toolDef = getTool(parsed.data.toolId);
  if (!toolDef) {
    return NextResponse.json({ error: `Unknown tool: ${parsed.data.toolId}` }, { status: 404 });
  }

  const ctx = buildToolContext({
    organizationId: user.organization.id,
    userId: user.id,
    agentId: conv.agent_id as string,
    conversationId: parsed.data.conversationId,
  });

  let out: unknown;
  try {
    out = await runTool(toolDef, parsed.data.input, ctx, { confirmed: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Replace the persisted __requires_confirmation sentinel on the originating
  // assistant message with the real executed result. Without this, a hard
  // reload would re-render the confirmation prompt and risk a double-execution.
  try {
    const { data: rows } = await db
      .from('messages')
      .select('id, tool_results')
      .eq('conversation_id', parsed.data.conversationId)
      .eq('role', 'assistant')
      .not('tool_results', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10);

    for (const row of rows ?? []) {
      const tr = row.tool_results as Array<Record<string, unknown>> | null;
      if (!Array.isArray(tr)) continue;
      const idx = tr.findIndex((e) => {
        const r = e?.result as { __requires_confirmation?: boolean; toolId?: string } | undefined;
        if (!r?.__requires_confirmation || r.toolId !== parsed.data.toolId) return false;
        return parsed.data.toolCallId ? e.toolCallId === parsed.data.toolCallId : true;
      });
      if (idx !== -1) {
        tr[idx] = { ...tr[idx], result: out };
        await db.from('messages').update({ tool_results: tr }).eq('id', row.id as string);
        break;
      }
    }
  } catch {
    // Non-fatal: the action already ran; persistence rewrite is best-effort.
  }

  return NextResponse.json({ result: out });
}
