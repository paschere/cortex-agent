import { toChatMessages } from '@/lib/conversation-messages';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * La conversación tal como se dibuja, releída. La consulta el chat mientras una
 * tarea en segundo plano escribe su avance (ver components/chat/useBackgroundTask).
 * Sólo la dueña de la conversación: la misma frontera que la página del chat.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const db = getOrgScopedClient(user.organization.id);
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!conv) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const { data, error } = await db
    .from('messages')
    .select('id, role, content, tool_calls, tool_results, parts, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });
  if (error)
    return NextResponse.json({ error: 'No se pudo leer la conversación.' }, { status: 500 });
  return NextResponse.json({ messages: toChatMessages(data ?? []) });
}
