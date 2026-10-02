import type { SupabaseClient } from '@supabase/supabase-js';
import type { PulseFact } from './pulse';
import {
  type PulseSnapshot,
  SNAPSHOT_KEEP_DAYS,
  parseSnapshotFacts,
  shiftDay,
  snapshotFacts,
} from './pulse-history';

/**
 * LAS CIFRAS DE CADA DÍA, EN LA BASE (migración 0171; lo puro está en
 * pulse-history.ts).
 *
 * Una fila por vista y día de Bogotá. Guardar dos veces el mismo día pisa la
 * fila (el índice único decide), así que el resumen de las 7:00 y la revisión
 * de las 7:30 del lunes dejan una sola: la última, que es la más fresca.
 *
 * La retención la hace el mismo escritor: al guardar el día se borra lo de esa
 * vista con más de `SNAPSHOT_KEEP_DAYS`. Un borrado acotado por vista y por el
 * índice, una vez al día — no hace falta un trabajo aparte para eso.
 *
 * `db` es siempre un handle con alcance de espacio (0064): `organization_id`
 * lo pone el handle, en la escritura y en cada filtro.
 */

/** Guarda (o pisa) las cifras del día de una vista y poda lo de hace más de un año y un mes. */
export async function savePulseSnapshot(
  db: SupabaseClient,
  input: { viewId: string; day: string; facts: PulseFact[] },
): Promise<void> {
  const facts = snapshotFacts(input.facts);
  if (!facts.length) return;
  const { error } = await db.from('pulse_snapshots').upsert(
    {
      view_id: input.viewId,
      day: input.day,
      facts,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,view_id,day' },
  );
  if (error) throw error;
  const { error: pruneError } = await db
    .from('pulse_snapshots')
    .delete()
    .eq('view_id', input.viewId)
    .lt('day', shiftDay(input.day, -SNAPSHOT_KEEP_DAYS));
  if (pruneError) throw pruneError;
}

/** Los días guardados de una vista entre `from` y `to` (ambos incluidos), el más nuevo primero. */
export async function readPulseSnapshots(
  db: SupabaseClient,
  viewId: string,
  from: string,
  to: string,
): Promise<PulseSnapshot[]> {
  const { data, error } = await db
    .from('pulse_snapshots')
    .select('day, facts')
    .eq('view_id', viewId)
    .gte('day', from)
    .lte('day', to)
    .order('day', { ascending: false })
    .limit(31);
  if (error) throw error;
  return ((data ?? []) as Array<{ day: string; facts: unknown }>).map((r) => ({
    day: String(r.day).slice(0, 10),
    facts: parseSnapshotFacts(r.facts),
  }));
}
