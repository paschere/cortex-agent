import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotReorder } from './autopilot-collect';
import { buildReorderPlan } from './purchasing';

/** La lectura de la mañana para el piloto (0183): lo que hay que reponer. */
export async function loadReorderSnapshot(
  db: SupabaseClient,
  today: string,
): Promise<SnapshotReorder | undefined> {
  const plan = await buildReorderPlan(db, { today });
  if (!plan.suggestions.length) return undefined;
  const withSupplier = plan.groups.filter((g) => g.supplierId);
  return {
    count: plan.suggestions.length,
    belowMin: plan.suggestions.filter((s) => s.reason === 'bajo_minimo').length,
    orders: withSupplier.length,
    amount: withSupplier.reduce((s, g) => s + g.total, 0),
    currency: plan.currency,
    withoutSupplier: plan.groups
      .filter((g) => !g.supplierId)
      .reduce((s, g) => s + g.lines.length, 0),
    productIds: withSupplier.flatMap((g) => g.lines.map((l) => l.productId)),
    suppliers: withSupplier.map((g) => g.supplierName ?? 'Proveedor'),
  };
}
