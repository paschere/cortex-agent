import { mustReadList } from '@/lib/supabase/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Las llamadas que Cortex ya escuchó y guardó — lo que lista «Llamadas»
 * debajo de las que siguen vivas. El bot las olvida a los 30 s; esta tabla
 * es el archivo.
 */
export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const rows = mustReadList(
    await db
      .from('live_calls')
      .select(
        'id, session_id, meet_url, meet_code, title, bot_name, started_at, ended_at, status, detail, participants, document_id',
      )
      .order('started_at', { ascending: false })
      .limit(50),
    'las llamadas guardadas de este espacio',
  );

  return NextResponse.json(
    {
      calls: rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        meetUrl: r.meet_url,
        meetCode: r.meet_code,
        title: r.title,
        botName: r.bot_name,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        status: r.status,
        detail: r.detail,
        participants: r.participants ?? [],
        documentId: r.document_id,
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
