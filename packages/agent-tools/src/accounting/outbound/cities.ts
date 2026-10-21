import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug } from '../../trackers/store';
import { accountingTableSlug } from '../tables';
import { setSyncedCities } from './shape';

/**
 * LAS CIUDADES DANE COMPLETAS (0235). Si el programa entrega su listado de
 * ciudades (tabla sincronizada «Ciudades (DANE)»), se carga en memoria para que
 * la creación de clientes reconozca cualquier municipio y no sólo la lista a
 * mano de unas cincuenta. Los códigos DANE son públicos y iguales para todas
 * las empresas, así que la copia en memoria se comparte y se renueva cada hora.
 */

let loadedAt = 0;
const TTL_MS = 60 * 60_000;

export async function ensureSyncedCities(db: SupabaseClient, provider = 'siigo'): Promise<void> {
  if (Date.now() - loadedAt < TTL_MS) return;
  try {
    const tracker = await getTrackerBySlug(db, accountingTableSlug(provider, 'cities'));
    if (!tracker) return;
    const list: Array<{ name: string; stateName?: string; code: string }> = [];
    for (let from = 0; from < 5000; from += 1000) {
      const { data, error } = await db
        .from('tracker_rows')
        .select('values')
        .eq('tracker_id', tracker.id)
        .range(from, from + 999);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ values: Record<string, unknown> }>;
      for (const r of rows) {
        const code = String(r.values?.codigo ?? '');
        const name = String(r.values?.nombre ?? '');
        if (/^\d{5}$/.test(code) && name)
          list.push({ name, code, stateName: r.values?.tipo ? String(r.values.tipo) : undefined });
      }
      if (rows.length < 1000) break;
    }
    if (list.length) {
      setSyncedCities(list);
      loadedAt = Date.now();
    }
  } catch {
    // Sin la lista completa se sigue con la de respaldo.
  }
}
