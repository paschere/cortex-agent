import { TRACKER_SLUG_PATTERN } from '@/lib/datagrid/trackers';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getTrackerBySlug } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tope por respuesta: más allá, `truncated` y la pantalla pregunta otra vez. */
const LIMIT = 200;

/**
 * Las filas de una tabla que se crearon o cambiaron desde `since`, para que la
 * pantalla las muestre en vivo sin recargar. Devuelve también `now` (hora del
 * servidor) para el siguiente `since`: así no depende del reloj del navegador.
 * No cubre filas borradas.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await ctx.params;
  const slug = decodeURIComponent(raw).trim();
  if (!TRACKER_SLUG_PATTERN.test(slug))
    return NextResponse.json({ error: 'Tabla no encontrada.' }, { status: 404 });
  const sinceRaw = req.nextUrl.searchParams.get('since');
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
  if (Number.isNaN(sinceMs))
    return NextResponse.json({ error: 'Falta `since` (fecha ISO).' }, { status: 400 });

  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    // La hora se toma antes de leer: un cambio que entre durante la lectura
    // cae en el traslape de la próxima pregunta, no se pierde.
    const now = new Date().toISOString();
    const tracker = await getTrackerBySlug(db, slug);
    if (!tracker) return NextResponse.json({ error: 'Tabla no encontrada.' }, { status: 404 });
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, label, created_at, updated_at, duplicate_flagged, values')
      .eq('tracker_id', tracker.id)
      .gt('updated_at', new Date(sinceMs).toISOString())
      .order('updated_at', { ascending: true })
      .limit(LIMIT + 1);
    if (error) throw error;
    const list = (data ?? []) as Array<Record<string, unknown>>;
    const truncated = list.length > LIMIT;
    const rows = list.slice(0, LIMIT).map((r) => ({
      id: String(r.id),
      label: String(r.label ?? ''),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      duplicate_flagged: r.duplicate_flagged === true,
      values: r.values && typeof r.values === 'object' && !Array.isArray(r.values) ? r.values : {},
    }));
    // Si hubo más que el tope, el siguiente `since` es la última fila entregada
    // (no `now`), para que la pantalla siga desde donde quedó.
    const last = rows[rows.length - 1];
    return NextResponse.json(
      { rows, truncated, now: truncated && last ? last.updated_at : now },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    logger.warn({ err, slug }, 'tablas: no se pudieron leer los cambios en vivo');
    return NextResponse.json({ error: 'No se pudieron leer los cambios.' }, { status: 503 });
  }
}
