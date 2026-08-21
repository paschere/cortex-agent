import { requireSession } from '@/lib/session';
import { mustRead } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const COLS =
  'id, session_id, meet_url, meet_code, title, bot_name, started_at, ended_at, status, detail, participants, transcript, document_id, insights, analyzed_at, brain_status, brain_reason, brain_decided_by';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LiveCallRow = {
  id: string;
  session_id: string;
  meet_url: string;
  meet_code: string | null;
  title: string | null;
  bot_name: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  detail: string | null;
  participants: unknown;
  transcript: unknown;
  document_id: string | null;
  insights: unknown;
  analyzed_at: string | null;
  brain_status: string;
  brain_reason: string | null;
  brain_decided_by: string | null;
};

/**
 * Una llamada guardada, por id o por el sessionId del bot. La sala de
 * Llamadas la pide cuando la sesión viva ya no está en el bot.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;
  const db = getOrgScopedClient(user.organization.id);

  const bySession = mustRead(
    await db.from('live_calls').select(COLS).eq('session_id', id).maybeSingle(),
    'esa llamada guardada',
  ) as LiveCallRow | null;

  const row =
    bySession ??
    (UUID.test(id)
      ? (mustRead(
          await db.from('live_calls').select(COLS).eq('id', id).maybeSingle(),
          'esa llamada guardada',
        ) as LiveCallRow | null)
      : null);

  if (!row) {
    return NextResponse.json({ error: 'Esa llamada no está guardada.' }, { status: 404 });
  }

  return NextResponse.json(
    {
      id: row.id,
      sessionId: row.session_id,
      meetUrl: row.meet_url,
      meetCode: row.meet_code,
      title: row.title,
      botName: row.bot_name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status,
      detail: row.detail,
      participants: row.participants ?? [],
      transcript: row.transcript ?? [],
      documentId: row.document_id,
      insights: row.insights ?? null,
      analyzedAt: row.analyzed_at,
      brainStatus: row.brain_status,
      brainReason: row.brain_reason,
      brainDecidedBy: row.brain_decided_by,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
