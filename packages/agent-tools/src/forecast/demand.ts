import { median, normalizeName } from '../ledger/forecast-shared';
import { round2 } from '../ledger/shape';
import { addMonths } from './pnl';

/**
 * VENTAS POR CLIENTE Y DEMANDA POR PRODUCTO (0191). Puro.
 *
 * Por cliente, de las facturas de venta de los últimos 12 meses (la cartera,
 * cobrada o no): quien facturó en 4 o más de los últimos 6 meses completos es
 * «recurrente» y se espera la mediana de sus meses con factura; los demás son
 * «ocasionales» y se espera su promedio anual repartido (lo facturado en 12
 * meses ÷ 12). Así el pronóstico dice qué parte de las ventas descansa en
 * clientes que compran casi todos los meses.
 *
 * Por producto, de las salidas del inventario (0183): con 12 meses de
 * historia, el mismo mes del año pasado ajustado por el ritmo reciente; si
 * no, el promedio de los últimos 3 meses. Con la existencia de hoy, cuántos
 * meses alcanza.
 */

export interface InvoiceLike {
  counterpartyName: string | null;
  date: string;
  amount: number;
}

export interface ClientForecast {
  name: string;
  /** Meses con factura de los últimos 6 completos. */
  activeMonths: number;
  monthly: number;
  recurring: boolean;
  lastInvoice: string;
  total12: number;
}

export interface ClientsForecast {
  clients: ClientForecast[];
  recurringMonthly: number;
  occasionalMonthly: number;
  /** Clientes con ventas en 12 meses. */
  count: number;
}

export function clientSalesForecast(
  invoices: InvoiceLike[],
  today: string,
  limit = 25,
): ClientsForecast {
  const current = today.slice(0, 7);
  const last6 = Array.from({ length: 6 }, (_, i) => addMonths(current, -(i + 1)));
  const from12 = addMonths(current, -12);
  const by = new Map<
    string,
    { name: string; months: Map<string, number>; last: string; total: number }
  >();
  for (const inv of invoices) {
    const month = inv.date.slice(0, 7);
    if (month < from12 || month >= current) continue;
    const name = inv.counterpartyName?.trim();
    if (!name || inv.amount <= 0) continue;
    const key = normalizeName(name);
    const e = by.get(key) ?? { name, months: new Map(), last: inv.date, total: 0 };
    e.months.set(month, (e.months.get(month) ?? 0) + inv.amount);
    e.total += inv.amount;
    if (inv.date > e.last) e.last = inv.date;
    by.set(key, e);
  }
  const clients = [...by.values()].map((e) => {
    const active = last6.filter((m) => (e.months.get(m) ?? 0) > 0);
    const recurring = active.length >= 4;
    const monthly = recurring ? median(active.map((m) => e.months.get(m) ?? 0)) : e.total / 12;
    return {
      name: e.name,
      activeMonths: active.length,
      monthly: round2(monthly),
      recurring,
      lastInvoice: e.last,
      total12: round2(e.total),
    };
  });
  clients.sort((a, b) => b.monthly - a.monthly);
  return {
    clients: clients.slice(0, limit),
    recurringMonthly: round2(clients.filter((c) => c.recurring).reduce((s, c) => s + c.monthly, 0)),
    occasionalMonthly: round2(
      clients.filter((c) => !c.recurring).reduce((s, c) => s + c.monthly, 0),
    ),
    count: clients.length,
  };
}

export interface ProductLike {
  id: string;
  name: string;
  unit: string;
  onHand: number;
}

export interface Outflow {
  productId: string;
  /** Positiva: lo que salió. */
  qty: number;
  occurredOn: string;
}

export interface ProductDemand {
  productId: string;
  name: string;
  unit: string;
  onHand: number;
  method: 'estacional' | 'ritmo';
  /** Salidas de los últimos 12 meses completos, del más viejo al más nuevo. */
  history: number[];
  /** Lo que se espera que salga los próximos meses. */
  next: Array<{ month: string; qty: number }>;
  /** Cuántos meses alcanza la existencia de hoy. */
  monthsOfCover: number | null;
  /** El mes en que se acabaría sin reponer. */
  runsOutIn: string | null;
}

export function productDemandForecast(
  products: ProductLike[],
  outflows: Outflow[],
  today: string,
  opts: { horizon?: number; limit?: number } = {},
): ProductDemand[] {
  const current = today.slice(0, 7);
  const horizon = Math.min(Math.max(opts.horizon ?? 3, 1), 12);
  const window = Array.from({ length: 12 }, (_, i) => addMonths(current, i - 12));
  const byProduct = new Map<string, Map<string, number>>();
  for (const o of outflows) {
    const month = o.occurredOn.slice(0, 7);
    if (month < (window[0] as string) || month >= current) continue;
    const m = byProduct.get(o.productId) ?? new Map<string, number>();
    m.set(month, (m.get(month) ?? 0) + Math.abs(o.qty));
    byProduct.set(o.productId, m);
  }
  const out: ProductDemand[] = [];
  for (const p of products) {
    const series = byProduct.get(p.id);
    if (!series) continue;
    const history = window.map((m) => series.get(m) ?? 0);
    const firstUse = history.findIndex((q) => q > 0);
    if (firstUse < 0) continue;
    const span = history.length - firstUse;
    const last3 = history.slice(-3);
    const recent = last3.reduce((s, q) => s + q, 0) / last3.length;
    const avg12 = history.reduce((s, q) => s + q, 0) / 12;
    const method: ProductDemand['method'] = span >= 12 ? 'estacional' : 'ritmo';
    const next = Array.from({ length: horizon }, (_, i) => {
      const month = addMonths(current, i);
      if (method === 'ritmo') return { month, qty: round2(recent) };
      // El mismo mes del año pasado, escalado por el ritmo reciente frente al año.
      const sameMonthLastYear = history[i] ?? avg12;
      const trend = avg12 > 0 ? Math.min(Math.max(recent / avg12, 0.5), 2) : 1;
      return { month, qty: round2(sameMonthLastYear * trend) };
    });
    const firstNext = next[0]?.qty ?? 0;
    let remaining = p.onHand;
    let runsOutIn: string | null = null;
    for (const n of next) {
      remaining -= n.qty;
      if (remaining < 0) {
        runsOutIn = n.month;
        break;
      }
    }
    out.push({
      productId: p.id,
      name: p.name,
      unit: p.unit,
      onHand: p.onHand,
      method,
      history,
      next,
      monthsOfCover: firstNext > 0 ? round2(p.onHand / firstNext) : null,
      runsOutIn,
    });
  }
  out.sort(
    (a, b) =>
      (a.monthsOfCover ?? Number.POSITIVE_INFINITY) -
        (b.monthsOfCover ?? Number.POSITIVE_INFINITY) ||
      (b.next[0]?.qty ?? 0) - (a.next[0]?.qty ?? 0),
  );
  return out.slice(0, opts.limit ?? 50);
}
