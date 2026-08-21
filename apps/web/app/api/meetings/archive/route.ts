import { requireSession } from '@/lib/session';
import { mustReadList } from '@/lib/supabase/read';
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
        'id, session_id, meet_url, meet_code, title, bot_name, started_at, ended_at, status, detail, participants, document_id, insights, analyzed_at, brain_status, brain_reason, brain_decided_by',
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
        // Solo lo que la lista necesita de la lectura; el detalle trae todo.
        summary: (r.insights as { summary?: string } | null)?.summary ?? null,
        analyzedAt: r.analyzed_at,
        brainStatus: r.brain_status,
        brainReason: r.brain_reason,
        brainDecidedBy: r.brain_decided_by,
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
