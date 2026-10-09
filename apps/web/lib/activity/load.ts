import 'server-only';
import { mustReadList } from '@/lib/supabase/read';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type Viewer, applyActivityFilter, applyActivityScope } from './scope';
import { isTimelineEvent } from './sentences';
import type { ActivityEvent, ActivityFilter } from './types';

const COLUMNS =
  'id,user_id,conversation_id,tool_id,status,decision,surface,mandate_id,created_at,metadata';
const BATCH = 100;
const MAX_BATCHES = 4;

export interface ActivityPage {
  events: ActivityEvent[];
  /** `created_at` desde el que seguir; `null` = no hay más. */
  nextCursor: string | null;
}

/**
 * Una página de eventos de la línea de tiempo, con el alcance de quien mira ya
 * puesto en la consulta. Lee en tandas porque la mitad de las filas de
 * auditoría son lecturas que no se cuentan: se sigue hasta juntar `limit` o
 * agotar el tope de tandas.
 */
export async function loadActivity(
  db: SupabaseClient,
  viewer: Viewer,
  opts: { filter: ActivityFilter; cursor?: string | null; limit?: number; mandateId?: string },
): Promise<ActivityPage> {
  const limit = opts.limit ?? 40;
  const events: ActivityEvent[] = [];
  let cursor = opts.cursor ?? null;
  let exhausted = false;
  for (let i = 0; i < MAX_BATCHES && events.length < limit; i += 1) {
    let q = db.from('audit_events').select(COLUMNS);
    q = applyActivityScope(q, viewer);
    q = applyActivityFilter(q, opts.filter);
    if (opts.mandateId) q = q.eq('mandate_id', opts.mandateId);
    if (cursor) q = q.lt('created_at', cursor);
    const rows = mustReadList<ActivityEvent>(
      await q.order('created_at', { ascending: false }).limit(BATCH),
      'lo que hizo Cortex',
    );
    for (const row of rows) if (isTimelineEvent(row)) events.push(row);
    if (rows.length < BATCH) {
      exhausted = true;
      break;
    }
    cursor = rows[rows.length - 1]?.created_at ?? null;
  }
  return { events, nextCursor: exhausted ? null : cursor };
}

/** Los ids de eventos que ya se deshicieron (cada deshacer deja su propia fila). */
export async function loadUndoneIds(db: SupabaseClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = mustReadList<{ metadata: { undoes?: string } | null }>(
    await db
      .from('audit_events')
      .select('metadata')
      .eq('tool_id', 'activity.undo')
      .eq('status', 'ok')
      .in('metadata->>undoes', ids)
      .limit(500),
    'lo que ya se deshizo',
  );
  return new Set(rows.flatMap((r) => (r.metadata?.undoes ? [r.metadata.undoes] : [])));
}

/** Eventos de los últimos 7 días para el resumen de la semana. */
export async function loadWeek(db: SupabaseClient, viewer: Viewer): Promise<ActivityEvent[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  let q = db.from('audit_events').select(COLUMNS).gte('created_at', since);
  q = applyActivityScope(q, viewer);
  q = applyActivityFilter(q, 'all');
  return mustReadList<ActivityEvent>(
    await q.order('created_at', { ascending: false }).limit(1000),
    'el resumen de la semana',
  );
}
