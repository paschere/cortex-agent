import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotBudget } from './autopilot-collect';
import { budgetOverruns } from './shape';
import { loadBudgetReport } from './store';

/**
 * Lo que el piloto lee del presupuesto (0191). Sin quien mire, la nómina va
 * doblada en un total, que cuadra igual contra su línea.
 */
export async function budgetSnapshot(
  db: SupabaseClient,
  today: string,
): Promise<SnapshotBudget | undefined> {
  const r = await loadBudgetReport(db, { year: Number(today.slice(0, 4)), today, viewerId: null });
  if (!r.budget || !r.vs) return undefined;
  const overruns = budgetOverruns(r.vs);
  if (!overruns.length) return undefined;
  return {
    budgetName: r.budget.name,
    year: r.budget.year,
    month: r.vs.throughMonth,
    currency: r.budget.currency,
    overruns,
  };
}
