import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotFleet } from './autopilot-collect';
import { addDaysIso, loadFleetOverview } from './store';

/** Días hacia atrás en que un tanqueo raro todavía es noticia. */
const FUEL_NEWS_DAYS = 14;

/** La lectura de la mañana para el piloto (0196): mantenimiento que toca y consumo raro. */
export async function loadFleetSnapshot(
  db: SupabaseClient,
  today: string,
): Promise<SnapshotFleet | undefined> {
  const overview = await loadFleetOverview(db, today);
  if (!overview.vehicles.length) return undefined;
  const since = addDaysIso(today, -FUEL_NEWS_DAYS);
  const snap: SnapshotFleet = { maintenance: [], fuel: [] };
  for (const v of overview.vehicles) {
    for (const p of v.plans) {
      if (p.due.status !== 'vencido' && p.due.status !== 'pronto') continue;
      snap.maintenance.push({
        vehicleId: v.row.id,
        plate: v.row.plate,
        label: v.row.label,
        task: p.task,
        status: p.due.status,
        reason: p.due.reason,
        dueKey: String(p.due.nextKm ?? p.due.nextOn ?? 'x'),
      });
    }
    for (const a of v.fuel.anomalies) {
      if (a.filledOn < since) continue;
      snap.fuel.push({
        vehicleId: v.row.id,
        plate: v.row.plate,
        logId: a.logId,
        filledOn: a.filledOn,
        message: a.message,
      });
    }
  }
  snap.maintenance.sort((a, b) => (a.status === b.status ? 0 : a.status === 'vencido' ? -1 : 1));
  return snap.maintenance.length || snap.fuel.length ? snap : undefined;
}
