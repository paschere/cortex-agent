import type { AccRecord } from './shape';

/**
 * RESULTADOS MENSUALES A PARTIR DE LAS HOJAS (0239). Puro.
 *
 * No es un estado de resultados contable: son las ventas y las compras/gastos
 * que traen las hojas declaradas como fuente, mes a mes, sin IVA cuando la hoja
 * lo trae. Sirve cuando no hay programa contable (o como complemento marcado a
 * su lado) y SIEMPRE se rotula así.
 */

export interface SheetMonth {
  /** AAAA-MM. */
  month: string;
  sales: number;
  purchases: number;
  /** Ventas − compras y gastos. */
  result: number;
  salesCount: number;
  purchaseCount: number;
}

export interface SheetMonthly {
  months: SheetMonth[];
  /** Hojas que alimentan la cifra, por tipo. */
  origins: { sales: string[]; purchases: string[] };
  /** Registros que no cuentan por estar en otra moneda sin TRM. */
  skippedForeign: number;
  /** Ventas o compras de hojas que no traen IVA mapeado: su total incluye IVA. */
  taxUnknown: { sales: boolean; purchases: boolean };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function net(r: AccRecord): number | null {
  const value = r.currency === 'COP' ? r.total : r.totalCop;
  if (value === null) return null;
  const taxCop = r.tax === null ? 0 : r.currency === 'COP' ? r.tax : r.trm ? r.tax * r.trm : 0;
  return value - taxCop;
}

export function monthlyFromRecords(
  sales: readonly AccRecord[],
  purchases: readonly AccRecord[],
  range?: { from: string; to: string },
): SheetMonthly {
  const map = new Map<string, SheetMonth>();
  let skipped = 0;
  const origins = { sales: new Set<string>(), purchases: new Set<string>() };
  const taxUnknown = { sales: false, purchases: false };
  const add = (side: 'sales' | 'purchases', list: readonly AccRecord[]) => {
    for (const r of list) {
      if (range && (r.date < range.from || r.date > range.to)) continue;
      const v = net(r);
      if (v === null) {
        skipped += 1;
        continue;
      }
      const month = r.date.slice(0, 7);
      const m = map.get(month) ?? {
        month,
        sales: 0,
        purchases: 0,
        result: 0,
        salesCount: 0,
        purchaseCount: 0,
      };
      if (side === 'sales') {
        m.sales += v;
        m.salesCount += 1;
      } else {
        m.purchases += v;
        m.purchaseCount += 1;
      }
      if (r.tax === null) taxUnknown[side] = true;
      origins[side].add(r.origin);
      map.set(month, m);
    }
  };
  add('sales', sales);
  add('purchases', purchases);
  const months = [...map.values()]
    .map((m) => ({
      ...m,
      sales: r2(m.sales),
      purchases: r2(m.purchases),
      result: r2(m.sales - m.purchases),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
  return {
    months,
    origins: { sales: [...origins.sales], purchases: [...origins.purchases] },
    skippedForeign: skipped,
    taxUnknown,
  };
}
