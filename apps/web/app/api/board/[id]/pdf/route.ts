import { boardPdfResponse } from '@/lib/board/pdf';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getBoardReport } from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/** El PDF de un informe para socios, para el equipo (con sesión). */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession().catch(() => null);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const db = getOrgScopedClient(user.organization.id);
  const report = await getBoardReport(db, id);
  if (!report) return new Response('Not found', { status: 404 });
  return boardPdfResponse(db, report, user.organization.name ?? 'Cortex');
}
