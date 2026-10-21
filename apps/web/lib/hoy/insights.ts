/**
 * «HOY»: LO QUE EL DUEÑO NECESITA AL EMPEZAR EL DÍA, ARMADO. Puro y sin base
 * de datos: recibe lo ya leído (cartera, libro, proyección, estados de Siigo,
 * facturas con su estado ante la DIAN, vuelos) y lo deja listo para dibujar.
 *
 * TODO es serializable (números, textos, fechas): ninguna función cruza del
 * servidor al navegador. Las cifras viajan como número y se escriben en el
 * componente con el formateador común (`format/display.ts`).
 *
 * Qué mide cada bloque (y qué NO):
 *   - Esta semana: cuatro tarjetas con el mismo criterio que sus pantallas
 *     (cartera, por pagar, DIAN). «Entra» cuenta las facturas abiertas que
 *     vencen en los próximos 7 días, con el plazo por defecto de la empresa
 *     para las que no traen uno propio; no es un pronóstico de cuándo pagan.
 *   - Entradas y salidas: la proyección de caja semana a semana (la misma de
 *     Finanzas), con su rango probable.
 *   - Resultado del mes: los estados de resultados de Siigo (base causación).
 *     El mes en curso no ha terminado: se dice, para no comparar medio mes
 *     contra un mes entero sin avisar.
 *   - Cartera: el modelo de «Cartera y pagos» (`buildCartera`).
 *   - DIAN: el estado de la factura electrónica que trae Siigo.
 *   - Operación: vuelos y prealertas de las tablas de la operación.
 */

import type { ChartTone } from '@/components/charts/colors';
import { addDaysIso, diffDays } from '@/components/charts/interactive';
import { deltaRatio } from '@/components/charts/scales';
import { isPayroll } from '@/lib/finance/dashboard-shape';
import { foldText, formatMoney } from '@cortex/agent-tools/src/format/display';
import type { ForecastResult, LedgerMovement } from '@cortex/agent-tools/src/ledger/types';
import type { CarteraModel } from '@cortex/agent-tools/src/payments/cartera';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dayShort = (iso: string) =>
  `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const monthName = (month: string) => MONTHS_LONG[Number(month.slice(5, 7)) - 1] ?? month;

/** Cambio relativo, sin base cuando lo anterior es cero (un «+∞ %» no dice nada). */
export function ratioOf(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || !(Math.abs(prev) >= 0.5)) return null;
  const r = deltaRatio(cur, prev);
  return r === null || !Number.isFinite(r) || Math.abs(r) > 100 ? null : r;
}

export function monthShift(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// La DIAN
// ---------------------------------------------------------------------------

export type DianState = 'accepted' | 'rejected' | 'pending';

const fold = (s: string) => foldText(s).trim();

/** El estado de la factura electrónica, según lo que escribe Siigo. Vacío = no aplica. */
export function dianStateOf(raw: unknown): DianState | null {
  const s = fold(typeof raw === 'string' ? raw : raw == null ? '' : String(raw));
  if (!s) return null;
  if (s.includes('rechaz') || s.includes('error') || s.includes('fall')) return 'rejected';
  if (s.includes('acept') || s.includes('autoriz') || s.includes('aprob')) return 'accepted';
  return 'pending';
}

export interface DianInvoiceRow {
  numero: string;
  cliente: string;
  total: number;
  fecha: string;
  estado: string;
  factura_electronica: string;
  mensaje_dian?: string | null;
  enlace?: string | null;
}

export interface DianProblem {
  number: string;
  client: string;
  amount: number;
  date: string;
  state: Exclude<DianState, 'accepted'>;
  /** Lo que dijo la DIAN, si Siigo lo trae. */
  message: string | null;
  url: string | null;
}

export interface DianView {
  currency: string;
  accepted: number;
  rejected: number;
  pending: number;
  total: number;
  /** Primero las rechazadas, de la más reciente a la más vieja. */
  problems: DianProblem[];
  href: string;
}

export function buildDian(
  rows: readonly DianInvoiceRow[],
  opts: { currency?: string; limit?: number } = {},
): DianView | null {
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  const problems: DianProblem[] = [];
  for (const r of rows) {
    if (fold(r.estado ?? '').startsWith('anul')) continue;
    const state = dianStateOf(r.factura_electronica);
    if (!state) continue;
    if (state === 'accepted') {
      accepted += 1;
      continue;
    }
    if (state === 'rejected') rejected += 1;
    else pending += 1;
    problems.push({
      number: r.numero,
      client: r.cliente,
      amount: Number(r.total) || 0,
      date: String(r.fecha ?? '').slice(0, 10),
      state,
      message: r.mensaje_dian?.trim() ? r.mensaje_dian.trim() : null,
      url: r.enlace?.trim() ? r.enlace.trim() : null,
    });
  }
  const total = accepted + rejected + pending;
  if (total === 0) return null;
  problems.sort(
    (a, b) =>
      Number(b.state === 'rejected') - Number(a.state === 'rejected') ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0),
  );
  return {
    currency: opts.currency ?? 'COP',
    accepted,
    rejected,
    pending,
    total,
    problems: problems.slice(0, opts.limit ?? 5),
    href: '/trackers/siigo_facturas',
  };
}

// ---------------------------------------------------------------------------
// Esta semana: cuatro tarjetas
// ---------------------------------------------------------------------------

export interface WeekCard {
  id: 'vencido' | 'entra' | 'paga' | 'dian';
  label: string;
  value: number;
  fmt: 'money' | 'count';
  currency: string;
  hint: string;
  tone: ChartTone;
  alert: boolean;
  href: string;
  /** Cambio contra la referencia; `null` = sin base. */
  ratio: number | null;
  /** ¿Ese cambio es bueno? `null` = neutro. */
  good: boolean | null;
  deltaLabel: string | null;
}

function isPayableOpen(m: LedgerMovement, isAdmin: boolean): boolean {
  if (m.direction !== 'out' || m.status !== 'expected') return false;
  if (m.kind !== 'payable' && m.kind !== 'expense') return false;
  if (!isAdmin && isPayroll(m.category)) return false;
  return true;
}

/** Lo que hay que pagar en los próximos 7 días y lo que ya se pasó de fecha. */
export function payablesWeek(
  movements: readonly LedgerMovement[],
  today: string,
  isAdmin: boolean,
  currency = 'COP',
) {
  const end = addDaysIso(today, 6);
  const out = { week: 0, weekCount: 0, overdue: 0, overdueCount: 0 };
  for (const m of movements) {
    if (m.currency.toUpperCase() !== currency.toUpperCase()) continue;
    if (!isPayableOpen(m, isAdmin)) continue;
    const day = (m.dueDate ?? m.date).slice(0, 10);
    const pending = m.outstanding ?? m.amount;
    if (!(pending > 0.5)) continue;
    if (day < today) {
      out.overdue += pending;
      out.overdueCount += 1;
    } else if (day <= end) {
      out.week += pending;
      out.weekCount += 1;
    }
  }
  return {
    week: Math.round(out.week),
    weekCount: out.weekCount,
    overdue: Math.round(out.overdue),
    overdueCount: out.overdueCount,
  };
}

/** Facturas abiertas que vencen de hoy a 6 días adelante. */
export function collectionsWeek(cartera: CarteraModel, today: string) {
  const end = addDaysIso(today, 6);
  let amount = 0;
  let count = 0;
  let assumed = 0;
  for (const i of cartera.invoices) {
    if (!i.dueOn || i.balance <= 0.5 || i.bucket === 'no_term') continue;
    if (i.dueOn < today || i.dueOn > end) continue;
    amount += i.balance;
    count += 1;
    if (i.dueBasis === 'plazo_supuesto') assumed += 1;
  }
  return { amount: Math.round(amount), count, assumed };
}

export interface WeekInput {
  today: string;
  currency: string;
  cartera: CarteraModel | null;
  defaultTermDays: number | null;
  movements: readonly LedgerMovement[] | null;
  isAdmin: boolean;
  dian: DianView | null;
}

export function buildWeekCards(input: WeekInput): WeekCard[] {
  const { cartera, currency } = input;
  const cards: WeekCard[] = [];
  const money = (n: number) => formatMoney(n, currency);

  if (cartera && (cartera.invoices.length > 0 || cartera.payments.length > 0)) {
    const o = cartera.kpis.overdue;
    const r = ratioOf(o.value, o.prev);
    cards.push({
      id: 'vencido',
      label: 'Te deben vencido',
      value: Math.round(o.value),
      fmt: 'money',
      currency,
      hint:
        o.value > 0.5
          ? `${plural(o.invoices, 'factura', 'facturas')} · ${Math.round(o.pct * 100)} % de lo que te deben`
          : 'Nada vencido: estás al día',
      tone: 'rose',
      alert: o.value > 0.5,
      href: '/payments',
      ratio: r,
      good: r === null || Math.abs(r) < 0.005 ? null : r < 0,
      deltaLabel: 'vs. hace 30 días',
    });
    const c = collectionsWeek(cartera, input.today);
    cards.push({
      id: 'entra',
      label: 'Entra esta semana',
      value: c.amount,
      fmt: 'money',
      currency,
      hint:
        c.count === 0
          ? 'Ninguna factura vence en 7 días'
          : `${plural(c.count, 'factura vence', 'facturas vencen')} en 7 días${
              c.assumed > 0 && input.defaultTermDays
                ? ` · ${c.assumed} con plazo de ${input.defaultTermDays} días`
                : ''
            }`,
      tone: 'emerald',
      alert: false,
      href: '/payments',
      ratio: null,
      good: null,
      deltaLabel: null,
    });
  }

  if (input.movements) {
    const p = payablesWeek(input.movements, input.today, input.isAdmin, currency);
    cards.push({
      id: 'paga',
      label: 'Por pagar esta semana',
      value: p.week,
      fmt: 'money',
      currency,
      hint:
        p.overdue > 0
          ? `${plural(p.weekCount, 'pago', 'pagos')} · y ${money(p.overdue)} ya vencido`
          : p.weekCount === 0
            ? 'Ningún pago vence en 7 días'
            : plural(p.weekCount, 'pago vence', 'pagos vencen'),
      tone: 'amber',
      alert: p.overdue > 0,
      href: '/pagar',
      ratio: null,
      good: null,
      deltaLabel: null,
    });
  }

  if (input.dian) {
    const d = input.dian;
    const bad = d.rejected + d.pending;
    cards.push({
      id: 'dian',
      label: 'Facturas con la DIAN',
      value: bad,
      fmt: 'count',
      currency,
      hint:
        d.rejected > 0
          ? `${plural(d.rejected, 'rechazada', 'rechazadas')}${d.pending ? ` y ${d.pending} sin respuesta` : ''}: toca corregirlas`
          : d.pending > 0
            ? `${plural(d.pending, 'espera', 'esperan')} respuesta de la DIAN`
            : `Las ${d.accepted} están aceptadas`,
      tone: 'sky',
      alert: d.rejected > 0,
      href: d.href,
      ratio: null,
      good: null,
      deltaLabel: null,
    });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Entradas y salidas por semana
// ---------------------------------------------------------------------------

export interface FlowItem {
  label: string;
  direction: 'in' | 'out';
  amount: number;
}

export interface FlowWeek {
  start: string;
  label: string;
  inflow: number;
  outflow: number;
  closing: number;
  /** Rango probable del saldo al cierre. */
  lo: number;
  hi: number;
  /** Lo que más pesa esa semana (tres por lado). */
  top: FlowItem[];
}

export interface FlowView {
  currency: string;
  startingCash: number;
  minimum: number | null;
  weeks: FlowWeek[];
  lowest: { start: string; label: string; closing: number } | null;
  href: string;
}

export function buildFlow(
  forecast: ForecastResult,
  minimumCash: number | null,
  limit = 13,
): FlowView | null {
  if (forecast.weeks.length === 0) return null;
  let cumDown = 0;
  let cumUp = 0;
  const weeks = forecast.weeks.slice(0, limit).map<FlowWeek>((w) => {
    for (const it of w.items) {
      const miss = Math.max(0, it.amount * (1 - it.probability));
      if (it.direction === 'in') cumDown += miss;
      else cumUp += miss;
    }
    const pick = (dir: 'in' | 'out') =>
      w.items
        .filter((i) => i.direction === dir)
        .sort((a, b) => b.expectedAmount - a.expectedAmount)
        .slice(0, 3)
        .map<FlowItem>((i) => ({
          label: (i.counterpartyName?.trim() || i.label).slice(0, 48),
          direction: dir,
          amount: Math.round(i.expectedAmount),
        }));
    return {
      start: w.start,
      label: dayShort(w.start),
      inflow: Math.round(w.inflows),
      outflow: Math.round(w.outflows),
      closing: Math.round(w.closing),
      lo: Math.round(w.closing - cumDown),
      hi: Math.round(w.closing + cumUp),
      top: [...pick('in'), ...pick('out')],
    };
  });
  const low = weeks.reduce((a, b) => (b.closing < a.closing ? b : a), weeks[0] as FlowWeek);
  return {
    currency: forecast.currency,
    startingCash: Math.round(forecast.startingCash),
    minimum: minimumCash !== null && minimumCash > 0 ? minimumCash : null,
    weeks,
    lowest: { start: low.start, label: low.label, closing: low.closing },
    href: '/finance',
  };
}

/** Lo que entra, lo que sale y lo que queda en las primeras `n` semanas. */
export function flowTotals(flow: FlowView, n: number) {
  const ws = flow.weeks.slice(0, n);
  const inflow = ws.reduce((s, w) => s + w.inflow, 0);
  const outflow = ws.reduce((s, w) => s + w.outflow, 0);
  const last = ws.at(-1);
  return { inflow, outflow, net: inflow - outflow, closing: last?.closing ?? flow.startingCash };
}

// ---------------------------------------------------------------------------
// Resultado del mes (estados de resultados de Siigo)
// ---------------------------------------------------------------------------

export interface StatementRow {
  periodo: string;
  estado: string;
  seccion: string;
  renglon: string;
  valor: number;
  en_curso?: string | null;
}

export interface ResultMonth {
  month: string;
  label: string;
  income: number;
  expenses: number;
  profit: number;
  inProgress: boolean;
}

export interface ResultView {
  currency: string;
  months: ResultMonth[];
  current: ResultMonth;
  /** El mes de antes y el mismo mes del año anterior (`null` si no hay cifras). */
  prev: ResultMonth | null;
  yearAgo: ResultMonth | null;
  incomeVsPrev: number | null;
  expensesVsPrev: number | null;
  profitVsPrev: number | null;
  incomeVsYear: number | null;
  profitVsYear: number | null;
  monthName: string;
  prevName: string | null;
  href: string;
}

/**
 * Ingresos = ventas + otros ingresos; utilidad = la utilidad neta de Siigo;
 * gastos = ingresos − utilidad (costos, gastos y otros gastos juntos), así las
 * tres cifras siempre cuadran entre sí.
 */
export function buildResult(
  rows: readonly StatementRow[],
  today: string,
  currency = 'COP',
): ResultView | null {
  const by = new Map<string, { sales: number; other: number; profit: number; live: boolean }>();
  for (const r of rows) {
    if (r.estado !== 'Estado de resultados' || r.seccion !== 'Resumen') continue;
    const e = by.get(r.periodo) ?? { sales: 0, other: 0, profit: 0, live: false };
    const v = Number(r.valor) || 0;
    if (r.renglon === 'Ventas') e.sales = v;
    else if (r.renglon === 'Otros ingresos') e.other = v;
    else if (r.renglon === 'Utilidad neta') e.profit = v;
    else continue;
    if (r.en_curso === 'Sí') e.live = true;
    by.set(r.periodo, e);
  }
  const thisMonth = today.slice(0, 7);
  const toMonth = (month: string): ResultMonth | null => {
    const e = by.get(month);
    if (!e) return null;
    const income = Math.round(e.sales + e.other);
    return {
      month,
      label: month.endsWith('-01')
        ? `${MONTHS[0]} ${month.slice(2, 4)}`
        : (MONTHS[Number(month.slice(5, 7)) - 1] ?? month),
      income,
      expenses: Math.round(income - e.profit),
      profit: Math.round(e.profit),
      inProgress: e.live || month === thisMonth,
    };
  };
  // El mes a mirar: el actual si Siigo ya trae cifras; si no, el último con datos.
  const withData = [...by.keys()]
    .filter((m) => m <= thisMonth && (toMonth(m)?.income !== 0 || toMonth(m)?.profit !== 0))
    .sort();
  const focus = withData.at(-1);
  if (!focus) return null;
  const months: ResultMonth[] = [];
  for (let i = -7; i <= 0; i++) {
    const m = toMonth(monthShift(focus, i));
    if (m && (m.income !== 0 || m.expenses !== 0 || months.length > 0)) months.push(m);
  }
  const current = months.at(-1) as ResultMonth;
  const nonZero = (m: ResultMonth | null) => (m && (m.income !== 0 || m.profit !== 0) ? m : null);
  const prev = nonZero(toMonth(monthShift(focus, -1)));
  const yearAgo = nonZero(toMonth(monthShift(focus, -12)));
  return {
    currency,
    months,
    current,
    prev,
    yearAgo,
    incomeVsPrev: prev ? ratioOf(current.income, prev.income) : null,
    expensesVsPrev: prev ? ratioOf(current.expenses, prev.expenses) : null,
    profitVsPrev: prev ? ratioOf(current.profit, prev.profit) : null,
    incomeVsYear: yearAgo ? ratioOf(current.income, yearAgo.income) : null,
    profitVsYear: yearAgo ? ratioOf(current.profit, yearAgo.profit) : null,
    monthName: monthName(focus),
    prevName: prev ? monthName(prev.month) : null,
    href: '/estados',
  };
}

// ---------------------------------------------------------------------------
// Cartera: antigüedad y quién debe
// ---------------------------------------------------------------------------

export interface AgingSegment {
  key: string;
  label: string;
  amount: number;
  count: number;
  tone: ChartTone;
}

export interface DebtorRow {
  key: string;
  name: string;
  open: number;
  overdue: number;
  invoices: number;
}

export interface ReceivableView {
  currency: string;
  total: number;
  overdue: number;
  overduePct: number;
  totalVsPrev: number | null;
  overdueVsPrev: number | null;
  dso: number | null;
  dsoPrev: number | null;
  collectedMonth: number;
  collectedVsPrev: number | null;
  aging: AgingSegment[];
  clients: DebtorRow[];
  clientsMore: number;
  /** El cliente con más plata vencida (para la frase de arriba). */
  topOverdue: string | null;
  noTerm: { count: number; amount: number };
  href: string;
}

const AGING_TONE: Record<string, ChartTone> = {
  current: 'emerald',
  d1_30: 'amber',
  d31_60: 'rose',
  d61_90: 'rose',
  d90_plus: 'rose',
  no_term: 'ink',
};

export function buildReceivable(cartera: CarteraModel, limit = 6): ReceivableView | null {
  const k = cartera.kpis;
  if (k.outstanding.value <= 0.5 && cartera.clients.every((c) => c.open <= 0.5)) return null;
  const withDebt = cartera.clients.filter((c) => c.open > 0.5);
  return {
    currency: cartera.currency,
    total: Math.round(k.outstanding.value),
    overdue: Math.round(k.overdue.value),
    overduePct: k.overdue.pct,
    totalVsPrev: ratioOf(k.outstanding.value, k.outstanding.prev),
    overdueVsPrev: ratioOf(k.overdue.value, k.overdue.prev),
    dso: k.dso.value,
    dsoPrev: k.dso.prev,
    collectedMonth: Math.round(k.collectedMonth.value),
    collectedVsPrev: ratioOf(k.collectedMonth.value, k.collectedMonth.prev),
    aging: cartera.aging
      .filter((a) => a.amount > 0.5)
      .map((a) => ({
        key: a.key,
        label: a.label,
        amount: Math.round(a.amount),
        count: a.count,
        tone: AGING_TONE[a.key] ?? 'ink',
      })),
    clients: withDebt.slice(0, limit).map((c) => ({
      key: c.key,
      name: c.name,
      open: Math.round(c.open),
      overdue: Math.round(c.overdue),
      invoices: c.openInvoices,
    })),
    clientsMore: Math.max(0, withDebt.length - limit),
    topOverdue:
      [...withDebt].sort((a, b) => b.overdue - a.overdue).find((c) => c.overdue > 0.5)?.name ??
      null,
    noTerm: {
      count: cartera.projection.noTermCount,
      amount: Math.round(cartera.projection.noTerm),
    },
    href: '/payments',
  };
}

// ---------------------------------------------------------------------------
// Operación: vuelos y prealertas
// ---------------------------------------------------------------------------

export interface FlightRow {
  fecha?: string | null;
  estado?: string | null;
  aerolinea?: string | null;
  numero_vuelo?: string | null;
}

export interface FlightLine {
  label: string;
  airline: string;
  when: string;
  status: string;
  late: boolean;
}

export interface OperationView {
  flights: null | {
    today: number;
    landedToday: number;
    landedWeek: number;
    upcoming: number;
    delayed: number;
    /** De fecha pasada y sin cerrar (ni aterrizó ni se canceló): hay que revisarlos. */
    stale: number;
    next: FlightLine[];
    href: string;
  };
  prealerts: null | {
    today: number;
    week: number;
    spark: number[];
    sparkLabels: string[];
    last: string | null;
    href: string;
  };
}

export function buildOperation(input: {
  today: string;
  flights: readonly FlightRow[] | null;
  /** Día (Bogotá) en que se creó cada prealerta. */
  prealertDays: readonly string[] | null;
}): OperationView | null {
  const { today } = input;
  const out: OperationView = { flights: null, prealerts: null };
  if (input.flights && input.flights.length > 0) {
    const closed = (s: string) => s.includes('aterriz') || s.includes('cancel');
    let todayN = 0;
    let landedToday = 0;
    let landedWeek = 0;
    let delayed = 0;
    let stale = 0;
    const upcoming: Array<FlightLine & { day: string }> = [];
    for (const f of input.flights) {
      const day = String(f.fecha ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const status = fold(f.estado ?? '');
      const landed = status.includes('aterriz');
      if (day === today) {
        todayN += 1;
        if (landed) landedToday += 1;
      }
      if (landed && day <= today && day >= addDaysIso(today, -6)) landedWeek += 1;
      if (closed(status)) continue;
      if (day < today) stale += 1;
      else
        upcoming.push({
          day,
          label: (f.numero_vuelo ?? '').toString().toUpperCase() || 'Sin número',
          airline: (f.aerolinea ?? '').toString(),
          when: day === today ? 'hoy' : diffDays(day, today) === 1 ? 'mañana' : dayShort(day),
          status: f.estado?.toString() || 'Programado',
          late: status.includes('demor'),
        });
      if (status.includes('demor')) delayed += 1;
    }
    upcoming.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    out.flights = {
      today: todayN,
      landedToday,
      landedWeek,
      upcoming: upcoming.length,
      delayed,
      stale,
      next: upcoming.slice(0, 4).map(({ day: _d, ...l }) => l),
      href: '/trackers/vuelos',
    };
  }
  if (input.prealertDays && input.prealertDays.length > 0) {
    const days = Array.from({ length: 14 }, (_, i) => addDaysIso(today, i - 13));
    const counts = new Map<string, number>();
    for (const d of input.prealertDays) counts.set(d, (counts.get(d) ?? 0) + 1);
    const spark = days.map((d) => counts.get(d) ?? 0);
    const last = [...counts.keys()].sort().at(-1) ?? null;
    out.prealerts = {
      today: counts.get(today) ?? 0,
      week: spark.slice(-7).reduce((a, b) => a + b, 0),
      spark,
      sparkLabels: days.map(dayShort),
      last: last ? (last === today ? 'hoy' : dayShort(last)) : null,
      href: '/trackers/prealertas',
    };
  }
  return out.flights || out.prealerts ? out : null;
}

// ---------------------------------------------------------------------------
// Todo junto
// ---------------------------------------------------------------------------

export interface HoyInsights {
  currency: string;
  week: WeekCard[];
  flow: FlowView | null;
  result: ResultView | null;
  receivable: ReceivableView | null;
  dian: DianView | null;
  operation: OperationView | null;
}

export function hasInsights(i: HoyInsights | undefined | null): i is HoyInsights {
  return (
    !!i &&
    (i.week.length > 0 || !!i.flow || !!i.result || !!i.receivable || !!i.dian || !!i.operation)
  );
}
