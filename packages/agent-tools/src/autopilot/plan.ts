import { collectAll } from './collectors';
import type { AutopilotSnapshot } from './collectors';
import { type PolicyContext, decidePlan } from './policy';
import type { AutopilotPlan, DecidedItem } from './types';

/**
 * EL PLAN DEL DÍA: recolectar, quitar lo que ya se decidió otro día, decidir.
 *
 * Es UNA función y la usan los dos caminos: «Probar sin hacer nada» (la
 * pantalla y `autopilot.plan`) y la corrida de verdad. Por eso el ensayo es el
 * plan real menos la ejecución, y no una imitación que se parece.
 */

/** Lo que pasó otros días con las mismas cosas (de `autopilot_items`). */
export interface PlanHistory {
  /**
   * Claves resueltas hace poco (hechas o descartadas dentro del enfriamiento):
   * no se vuelven a plantear. La misma factura en un escalón nuevo de mora
   * lleva otra clave y sí vuelve.
   */
  settled: Set<string>;
  /** Claves que siguen esperando una decisión de un día anterior. */
  openAsks: Set<string>;
}

export const EMPTY_HISTORY: PlanHistory = { settled: new Set(), openAsks: new Set() };

/** Cuántos días se recuerda lo ya hecho o descartado. */
export const COOLDOWN_DAYS = 7;

export function buildPlan(
  snapshot: AutopilotSnapshot,
  ctx: PolicyContext & { history?: PlanHistory; sourceErrors?: AutopilotPlan['sourceErrors'] },
): AutopilotPlan & { stillWaiting: number } {
  const now = ctx.now ?? new Date();
  const { items, errors } = collectAll(snapshot, now);
  const history = ctx.history ?? EMPTY_HISTORY;
  let suppressed = 0;
  let stillWaiting = 0;
  const fresh = items.filter((item) => {
    if (history.settled.has(item.dedupeKey)) {
      suppressed += 1;
      return false;
    }
    // Lo que ya está esperando tu decisión desde otro día no se vuelve a
    // pedir: se cuenta, y la pantalla lo enseña donde ya está.
    if (history.openAsks.has(item.dedupeKey)) {
      stillWaiting += 1;
      return false;
    }
    return true;
  });
  const decided: DecidedItem[] = decidePlan(fresh, { ...ctx, now });
  const counts = { do: 0, ask: 0, tell: 0 };
  for (const d of decided) counts[d.decision] += 1;
  return {
    day: snapshot.today,
    items: decided,
    counts,
    sourceErrors: [...(ctx.sourceErrors ?? []), ...errors],
    suppressed,
    stillWaiting,
  };
}

/** Los ids de herramienta del plan, para leer sólo los mandatos que importan. */
export function toolIdsOf(snapshot: AutopilotSnapshot, now: Date): string[] {
  const { items } = collectAll(snapshot, now);
  return [
    ...new Set(
      items.map((i) => i.proposedAction?.toolId).filter((id): id is string => Boolean(id)),
    ),
  ];
}
