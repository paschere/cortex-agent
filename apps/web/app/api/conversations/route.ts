import { firstRealRequest, looksBadTitle } from '@/lib/conversation-title';
import { generateConversationTitle } from '@/lib/conversation-title-gen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse, after } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  // MCP sessions (Claude tool-call logs) are excluded from the sidebar: they
  // are records, not chats to resume. They remain visible in /conversations
  // via ?surface=mcp and in the audit log.
  const { data } = await db
    .from('conversations')
    .select('id, title, created_at, updated_at, agents(name)')
    .eq('user_id', user.id)
    .neq('surface', 'mcp')
    .order('updated_at', { ascending: false })
    .limit(100);
  const baseRows = data ?? [];

  // Estado de la tarea en segundo plano de cada chat (la más reciente), para los
  // filtros y los puntos de la lista. Si la lectura falla, la lista sigue igual.
  const taskByConversation = new Map<string, string>();
  try {
    const { data: tasks } = await db
      .from('background_tasks')
      .select('conversation_id, status, updated_at')
      .eq('user_id', user.id)
      .not('conversation_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(200);
    for (const t of (tasks ?? []) as { conversation_id: string; status: string }[]) {
      if (!taskByConversation.has(t.conversation_id)) {
        taskByConversation.set(t.conversation_id, t.status);
      }
    }
  } catch {
    /* sin estados: la lista se pinta sin puntos */
  }
  const rows = baseRows.map((r) => ({
    ...r,
    task_status: taskByConversation.get((r as { id: string }).id) ?? null,
  }));

  // Retitulado perezoso y barato: los chats con título en inglés, con markdown o
  // sacado de un mensaje de control («Aprobé…», «sigue») se corrigen en segundo
  // plano, de a pocos por lectura. La lista de la próxima lectura ya viene bien.
  const bad = rows.filter((r) => looksBadTitle((r as { title?: string | null }).title)).slice(0, 3);
  if (bad.length > 0) {
    after(async () => {
      for (const row of bad) {
        try {
          const { data: msgs } = await db
            .from('messages')
            .select('role, content')
            .eq('conversation_id', row.id)
            .eq('role', 'user')
            .order('created_at', { ascending: true })
            .limit(12);
          const request = firstRealRequest((msgs ?? []) as { role: string; content: string }[]);
          if (!request) {
            // Sólo mensajes de control: no hay de qué titular; se asienta para no reintentar.
            await db.from('conversations').update({ title: 'Conversación' }).eq('id', row.id);
            continue;
          }
          const title = await generateConversationTitle(request);
          await db.from('conversations').update({ title }).eq('id', row.id);
        } catch {
          /* no es grave: se reintenta en la próxima lectura */
        }
      }
    });
  }

  return NextResponse.json({ conversations: rows });
}
