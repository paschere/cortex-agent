import { readFirstRunSnapshot } from '@/lib/first-run/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lo que el recorrido de los primeros 15 minutos consulta cada pocos segundos:
 * qué se leyó hasta ahora y, si se pide, los hallazgos del primer resumen.
 * Todo con el espacio de quien pregunta; conteos y consultas con tope.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const withFindings = new URL(req.url).searchParams.get('hallazgos') === '1';
  const snapshot = await readFirstRunSnapshot(db, user.id, { withFindings });
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
}
