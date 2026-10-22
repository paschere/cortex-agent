import type { SupabaseClient } from '@supabase/supabase-js';
import { daysBetween } from '../../commitments/shape';
import { type CombinedSummary, combineKind, loadBaseRecords } from './read';

/**
 * POR PAGAR CON LAS HOJAS (0239): lo que las hojas o tablas declaradas como
 * fuente de compras y gastos suman a lo que ya hay en el libro de pagos, sin
 * repetir (mismo número y NIT). Devuelve datos simples para la pantalla:
 * la mezcla por origen, las diferencias, lo descartado y las facturas abiertas
 * que sólo están en una hoja (no pasan por el flujo de aprobación).
 * Nunca lanza; sin fuentes devuelve null.
 */

export interface SheetPayableItem {
  id: string;
  supplier: string;
  number: string;
  dueOn: string | null;
  /** Positivo = días vencida. */
  daysOverdue: number | null;
  balance: number;
  currency: string;
  origin: string;
}

export interface SheetPayables {
  summary: CombinedSummary;
  /** Origen → lo que se debe (abierto, en pesos). */
  items: Array<{ origin: string; amount: number; count: number }>;
  open: SheetPayableItem[];
  openTotal: number;
  overdueTotal: number;
}

export async function readSheetPayables(
  db: SupabaseClient,
  today: string,
): Promise<SheetPayables | null> {
  try {
    const base = await loadBaseRecords(db, 'compras');
    const c = await combineKind(db, 'compras', base);
    if (!c.batches.length) return null;
    const open: SheetPayableItem[] = c.result.records
      .filter((r) => r.sourceId !== 'base' && !r.creditNote && (r.balance ?? r.total) > 0.005)
      .map((r) => ({
        id: r.rowId,
        supplier: r.party || 'Sin proveedor',
        number: r.number,
        dueOn: r.due,
        daysOverdue: r.due ? daysBetween(r.due, today) : null,
        balance: r.balance ?? r.total,
        currency: r.currency,
        origin: r.origin,
      }))
      .sort((a, b) => (b.daysOverdue ?? -9999) - (a.daysOverdue ?? -9999) || b.balance - a.balance);
    const cop = open.filter((o) => o.currency === 'COP');
    // Por origen sólo lo abierto: lo que ya está cerrado en el libro (base) no debe nada.
    const byOrigin = new Map<string, { origin: string; amount: number; count: number }>();
    for (const r of c.result.records) {
      if (r.currency !== 'COP' || r.creditNote) continue;
      const bal = r.balance ?? r.total;
      if (bal <= 0.005) continue;
      const o = byOrigin.get(r.origin) ?? { origin: r.origin, amount: 0, count: 0 };
      o.amount += bal;
      o.count += 1;
      byOrigin.set(r.origin, o);
    }
    return {
      summary: c.summary,
      items: [...byOrigin.values()].sort((a, b) => b.amount - a.amount),
      open,
      openTotal: cop.reduce((s, o) => s + o.balance, 0),
      overdueTotal: cop.filter((o) => (o.daysOverdue ?? 0) > 0).reduce((s, o) => s + o.balance, 0),
    };
  } catch {
    return null;
  }
}
