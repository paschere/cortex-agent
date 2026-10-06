import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cuándo se tocó por última vez una fila de cada tabla: lo que el índice de
 * Tablas pregunta cada rato para poner el punto «nuevo». Una sola lectura
 * acotada (las 2.000 filas más recientes), igual que la página.
 */
export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const { data, error } = await db
      .from('tracker_rows')
      .select('tracker_id, updated_at')
      .order('updated_at', { ascending: false })
      .limit(2000);
    if (error) throw error;
    const latest: Record<string, string> = {};
    for (const r of (data ?? []) as Array<{ tracker_id: string; updated_at: string }>)
      latest[r.tracker_id] ??= r.updated_at;
    return NextResponse.json({ latest }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    logger.warn({ err }, 'tablas: no se pudo leer la actividad');
    return NextResponse.json({ error: 'No se pudo leer la actividad.' }, { status: 503 });
  }
}
