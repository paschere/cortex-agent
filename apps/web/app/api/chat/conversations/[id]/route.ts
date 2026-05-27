import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireSession();
  const { id } = await params;
  const db = getSupabaseServiceClient();

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, agent_id, title, surface')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (convErr || !conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const { data: msgs } = await db
    .from('messages')
    .select('id, role, content, tool_calls, tool_results, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  return NextResponse.json({ conversation: conv, messages: msgs ?? [] });
}
