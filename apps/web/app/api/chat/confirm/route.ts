import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { buildToolContext } from '@/lib/agent';
import { getTool, runTool } from '@zipdev/agent-tools';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

const Body = z.object({
  conversationId: z.string().uuid(),
  toolId: z.string(),
  input: z.unknown(),
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

  const db = getSupabaseServiceClient();
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

  await db.from('messages').insert({
    conversation_id: parsed.data.conversationId,
    role: 'tool',
    content: `Confirmed and executed ${parsed.data.toolId}`,
    tool_results: { [parsed.data.toolId]: out } as object,
  });

  return NextResponse.json({ result: out });
}
