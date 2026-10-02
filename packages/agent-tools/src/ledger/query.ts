import { categoryLabel, monthOf, normalizeText, round2 } from './shape';
import type { CashAccount, LedgerDirection, LedgerMovement } from './types';

/**
 * LAS PREGUNTAS DE PLATA, COMO SUMAS PURAS SOBRE EL LIBRO.
 *
 * Todo aquí recibe movimientos que YA cuentan (store.ts › listMovements filtra
 * duplicados, anulados y en disputa) y de UNA sola moneda: quien llama separa
 * por moneda antes, porque 3.000 USD más 12.000.000 COP no es ninguna cifra.
 *
 * QUÉ SIGNIFICA CADA NÚMERO, para que el agente lo diga bien:
 *
 *   ingresos   plata que ENTRÓ (ingresos ya liquidados), menos devoluciones.
 *              Es caja, no facturación.
 *   gastos     plata que SALIÓ (gastos ya liquidados), menos reintegros.
 *   margen     ingresos − gastos del mes: el margen de CAJA, no el contable.
 *   facturado  lo que se facturó (cuentas por cobrar emitidas ese mes), se
 *              haya cobrado o no: la venta en sentido contable.
 *   compras    las facturas de proveedores emitidas ese mes (por pagar).
 *
 * Los traslados entre cuentas propias no son ni ingreso ni gasto.
 */

export interface MonthSummary {
  month: string;
  ingresos: number;
  gastos: number;
  margen: number;
  facturado: number;
  compras: number;
  movimientos: number;
}

function signedCash(m: LedgerMovement): { ingresos: number; gastos: number } {
  if (m.status !== 'settled') return { ingresos: 0, gastos: 0 };
  if (m.kind === 'income')
    return { ingresos: m.direction === 'in' ? m.amount : -m.amount, gastos: 0 };
  if (m.kind === 'expense')
    return { ingresos: 0, gastos: m.direction === 'out' ? m.amount : -m.amount };
  return { ingresos: 0, gastos: 0 };
}

/** Los meses de `from` a `to` (AAAA-MM), aunque alguno no tenga movimientos. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const [ty, tm] = to.slice(0, 7).split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 120) break;
  }
  return out;
}

export function monthlySummary(
  movements: LedgerMovement[],
  range: { from: string; to: string },
): MonthSummary[] {
  const months = new Map<string, MonthSummary>(
    monthsBetween(range.from, range.to).map((month) => [
      month,
      { month, ingresos: 0, gastos: 0, margen: 0, facturado: 0, compras: 0, movimientos: 0 },
    ]),
  );
  for (const m of movements) {
    if (m.date < range.from || m.date > range.to || m.status === 'cancelled') continue;
    const bucket = months.get(monthOf(m.date));
    if (!bucket) continue;
    const cash = signedCash(m);
    bucket.ingresos += cash.ingresos;
    bucket.gastos += cash.gastos;
    if (m.kind === 'receivable') bucket.facturado += m.amount;
    if (m.kind === 'payable') bucket.compras += m.amount;
    if (m.kind !== 'transfer') bucket.movimientos += 1;
  }
  return [...months.values()].map((b) => ({
    ...b,
    ingresos: round2(b.ingresos),
    gastos: round2(b.gastos),
    margen: round2(b.ingresos - b.gastos),
    facturado: round2(b.facturado),
    compras: round2(b.compras),
  }));
}

export interface CategoryTotal {
  category: string;
  label: string;
  total: number;
  count: number;
  share: number;
}

/**
 * Cuánto entró (`in`) o salió (`out`) por categoría, de lo ya liquidado. Lo
 * que aún no tiene categoría sale como «Sin categoría», no se esconde.
 */
export function totalsByCategory(
  movements: LedgerMovement[],
  direction: LedgerDirection,
): CategoryTotal[] {
  const kind = direction === 'in' ? 'income' : 'expense';
  const map = new Map<string, { total: number; count: number }>();
  for (const m of movements) {
    if (m.status !== 'settled' || m.kind !== kind) continue;
    const sign = m.direction === direction ? 1 : -1;
    const key = m.category ?? 'sin_categoria';
    const entry = map.get(key) ?? { total: 0, count: 0 };
    entry.total += sign * m.amount;
    entry.count += 1;
    map.set(key, entry);
  }
  const grand = [...map.values()].reduce((s, e) => s + e.total, 0);
  return [...map.entries()]
    .map(([category, e]) => ({
      category,
      label: category === 'sin_categoria' ? 'Sin categoría' : categoryLabel(category),
      total: round2(e.total),
      count: e.count,
      share: grand > 0 ? Math.round((e.total / grand) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

export interface CounterpartyTotal {
  counterparty: string;
  total: number;
  count: number;
  lastDate: string;
}

/** A quién se le paga más (`out`) o quién paga más (`in`), de lo ya liquidado. */
export function totalsByCounterparty(
  movements: LedgerMovement[],
  direction: LedgerDirection,
  limit = 15,
): CounterpartyTotal[] {
  const map = new Map<string, CounterpartyTotal>();
  for (const m of movements) {
    if (m.status !== 'settled' || m.direction !== direction) continue;
    if (m.kind !== 'income' && m.kind !== 'expense') continue;
    const name = m.counterpartyName?.trim() || 'Sin contraparte';
    const key = normalizeText(name) || 'sin contraparte';
    const entry = map.get(key) ?? { counterparty: name, total: 0, count: 0, lastDate: m.date };
    entry.total += m.amount;
    entry.count += 1;
    if (m.date > entry.lastDate) entry.lastDate = m.date;
    map.set(key, entry);
  }
  return [...map.values()]
    .map((e) => ({ ...e, total: round2(e.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export interface DueItem {
  id: string;
  kind: LedgerMovement['kind'];
  direction: LedgerDirection;
  counterparty: string | null;
  description: string;
  dueDate: string | null;
  pending: number;
  daysToDue: number | null;
}

export interface DueSummary {
  receivable: { overdue: number; next7: number; next30: number; later: number; noDate: number };
  payable: { overdue: number; next7: number; next30: number; later: number; noDate: number };
  items: DueItem[];
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Lo que está por cobrar y por pagar (facturas y lo esperado), por cuándo
 * vence: vencido, próximos 7 días, próximos 30, después, sin fecha. Lo
 * pendiente de una factura es su saldo, no su total.
 */
export function dueSummary(movements: LedgerMovement[], today: string, limit = 40): DueSummary {
  const empty = () => ({ overdue: 0, next7: 0, next30: 0, later: 0, noDate: 0 });
  const out: DueSummary = { receivable: empty(), payable: empty(), items: [] };
  for (const m of movements) {
    if (m.status !== 'expected' || m.kind === 'transfer') continue;
    const pending = m.outstanding ?? m.amount;
    if (pending <= 0.004) continue;
    const side = m.direction === 'in' ? out.receivable : out.payable;
    const due = m.dueDate ?? (m.kind === 'income' || m.kind === 'expense' ? m.date : null);
    const days = due ? dayDiff(today, due) : null;
    if (days == null) side.noDate += pending;
    else if (days < 0) side.overdue += pending;
    else if (days <= 7) side.next7 += pending;
    else if (days <= 30) side.next30 += pending;
    else side.later += pending;
    out.items.push({
      id: m.id,
      kind: m.kind,
      direction: m.direction,
      counterparty: m.counterpartyName ?? null,
      description: m.description,
      dueDate: due,
      pending: round2(pending),
      daysToDue: days,
    });
  }
  for (const side of [out.receivable, out.payable]) {
    for (const k of Object.keys(side) as Array<keyof typeof side>) side[k] = round2(side[k]);
  }
  out.items.sort(
    (a, b) =>
      (a.daysToDue ?? Number.MAX_SAFE_INTEGER) - (b.daysToDue ?? Number.MAX_SAFE_INTEGER) ||
      b.pending - a.pending,
  );
  out.items = out.items.slice(0, limit);
  return out;
}

export interface CashLine {
  id: string;
  name: string;
  currency: string;
  balance: number;
  balanceAt: string;
  daysOld: number;
  stale: boolean;
}

/** Un saldo de hace más de esto se dice «viejo» en la respuesta. */
export const STALE_BALANCE_DAYS = 7;

export function cashByAccount(
  accounts: CashAccount[],
  today: string,
): { lines: CashLine[]; totals: Array<{ currency: string; total: number }> } {
  const lines = accounts
    .map((a) => {
      const daysOld = Math.max(0, dayDiff(a.balanceAt, today));
      return {
        id: a.id,
        name: a.name,
        currency: a.currency,
        balance: round2(a.balance),
        balanceAt: a.balanceAt,
        daysOld,
        stale: daysOld > STALE_BALANCE_DAYS,
      };
    })
    .sort((a, b) => b.balance - a.balance);
  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.currency, (totals.get(l.currency) ?? 0) + l.balance);
  return {
    lines,
    totals: [...totals.entries()].map(([currency, total]) => ({ currency, total: round2(total) })),
  };
}

/** El primer día del mes `months - 1` meses antes del de `today`. */
export function monthsBack(today: string, months: number): string {
  const [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) - Math.max(0, months - 1);
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}
