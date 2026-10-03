import type { SupabaseClient } from '@supabase/supabase-js';
import { CLOSE_REMINDER_DAYS, type SnapshotClose } from './autopilot-collect';
import { periodOf, shiftPeriod } from './shape';
import { computeClose } from './store';

/**
 * Lo que el piloto lee del cierre (0192): del día 1 al 5, el mes anterior si
 * no está cerrado. No escribe nada (computeClose).
 */
export async function closeSnapshot(
  db: SupabaseClient,
  today: string,
): Promise<SnapshotClose | undefined> {
  if (Number(today.slice(8, 10)) > CLOSE_REMINDER_DAYS) return undefined;
  const period = shiftPeriod(periodOf(today), -1);
  const view = await computeClose(db, period);
  if (view.status === 'cerrado') return undefined;
  return {
    period,
    pending: view.pending,
    total: view.progress.total,
    missing: view.tasks.filter((t) => !t.ready).map((t) => t.title),
  };
}
