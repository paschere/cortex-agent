/**
 * «HOY»: EL TABLERO DE DATOS, ARMADO. Puro y sin base de datos.
 *
 * Aquí se convierten los movimientos del libro, la proyección de caja, la
 * cartera y las corridas del piloto en las series que dibujan los gráficos
 * (`MetricModel`), la tira de indicadores y la frase de arriba. Lo usan el
 * cargador del servidor (`read.ts`), el escaparate `/v/hoy-showcase` y las
 * pruebas; no importa nada del navegador ni del servidor.
 *
 * Qué mide cada serie (y qué NO):
 *   - Caja: el saldo de hoy menos lo que se movió después, día por día. Es una
 *     reconstrucción desde los movimientos liquidados, no un extracto.
 *   - Te deben vencido: facturas por cobrar cuyo vencimiento ya pasó y que no
 *     estaban pagadas ese día.
 *   - Por pagar: lo que vence cada día (facturas por pagar y gastos esperados).
 *   - Ventas: lo facturado o ingresado cada día (por fecha de emisión).
 *   - Cortex hizo: cosas que el piloto resolvió cada mañana.
 *
 * LA NÓMINA es confidencial para quien no administra: sus movimientos nunca
 * entran a los registros que se pueden abrir, y en la proyección ya viene
 * fundida por semana (ver `maskPayroll`).
 */

import type { ChartTone } from '@/components/charts/colors';
import {
  addDaysIso,
  bucketize,
  dayLabel,
  diffDays,
  periodSummary,
  rangeById,
  rangeWindow,
} from '@/components/charts/interactive';
import type { DayPoint, DrillRecord, ProjectionPoint } from '@/components/charts/interactive';
import { metricFormatters } from '@/components/charts/metric-format';
import type { MetricEvent, MetricModel } from '@/components/charts/metric-types';
import { isPayroll } from '@/lib/finance/dashboard-shape';
import { formatMoney } from '@cortex/agent-tools/src/ledger/forecast-shared';
import type { ForecastResult, LedgerMovement } from '@cortex/agent-tools/src/ledger/types';

// ---------------------------------------------------------------------------
// Fechas y selección de movimientos
// ---------------------------------------------------------------------------

/** El día en que cuenta un movimiento: cuando se liquidó o cuando vence. */
export function effectiveDay(m: LedgerMovement): string {
  if (m.status === 'settled') return (m.settledAt ?? m.date).slice(0, 10);
  return (m.dueDate ?? m.date).slice(0, 10);
}

function signed(m: LedgerMovement): number {
  return m.direction === 'in' ? m.amount : -m.amount;
}

const HISTORY_DAYS = 730;

function sumByDay(
  items: Array<{ date: string; value: number }>,
  from: string,
  to: string,
): DayPoint[] {
  const map = new Map<string, number>();
  for (const it of items) {
    if (it.date < from || it.date > to) continue;
    map.set(it.date, (map.get(it.date) ?? 0) + it.value);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, value }));
}

// ---------------------------------------------------------------------------
// Caja
// ---------------------------------------------------------------------------

/**
 * El saldo de cada día hacia atrás: el de hoy menos lo que se movió después.
 * Devuelve un punto por día desde `from` hasta hoy (los días sin movimientos
 * repiten el saldo).
 */
export function cashHistory(
  settled: ReadonlyArray<{ date: string; net: number }>,
  currentCash: number,
  today: string,
  days = HISTORY_DAYS,
): DayPoint[] {
  const from = addDaysIso(today, -days);
  const netByDay = new Map<string, number>();
  for (const s of settled) netByDay.set(s.date, (netByDay.get(s.date) ?? 0) + s.net);
  const out: DayPoint[] = [];
  let balance = currentCash;
  for (let d = today; d >= from; d = addDaysIso(d, -1)) {
    out.push({ date: d, value: Math.round(balance) });
    // Para ayer, se deshace lo que pasó hoy.
    balance -= netByDay.get(d) ?? 0;
  }
  return out.reverse();
}

/**
 * La proyección semana a semana, repartida por días y con su rango probable.
 * El rango: lo que entra con certeza < 100 % puede no llegar (baja) y lo que
 * sale con certeza < 100 % puede no salir (sube); se acumula semana a semana.
 */
export function projectionFromForecast(forecast: ForecastResult, today: string): ProjectionPoint[] {
  const anchors: Array<{ date: string; value: number; lo: number; hi: number }> = [
    {
      date: today,
      value: forecast.startingCash,
      lo: forecast.startingCash,
      hi: forecast.startingCash,
    },
  ];
  let cumDown = 0;
  let cumUp = 0;
  for (const w of forecast.weeks) {
    for (const it of w.items) {
      const miss = Math.max(0, it.amount * (1 - it.probability));
      if (it.direction === 'in') cumDown += miss;
      else cumUp += miss;
    }
    const end = addDaysIso(w.start, 6);
    if (end <= today) continue;
    anchors.push({ date: end, value: w.closing, lo: w.closing - cumDown, hi: w.closing + cumUp });
  }
  const out: ProjectionPoint[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1] as (typeof anchors)[number];
    const b = anchors[i] as (typeof anchors)[number];
    const span = diffDays(b.date, a.date);
    for (let k = 1; k <= span; k++) {
      const t = k / span;
      out.push({
        date: addDaysIso(a.date, k),
        value: Math.round(a.value + (b.value - a.value) * t),
        lo: Math.round(a.lo + (b.lo - a.lo) * t),
        hi: Math.round(a.hi + (b.hi - a.hi) * t),
      });
    }
  }
  return out;
}

function shortName(name: string, max = 16): string {
  const t = name
    .replace(/\s+(S\.?A\.?S\.?|S\.?A\.?|LTDA\.?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Nómina, pagos grandes y cobros grandes: lo que explica un salto de la caja. */
export function cashEvents(
  forecast: ForecastResult | null,
  movements: readonly LedgerMovement[],
  today: string,
  currency: string,
): MetricEvent[] {
  const events: MetricEvent[] = [];
  const seen = new Set<string>();
  const add = (e: MetricEvent) => {
    const k = `${e.date}|${e.label}`;
    if (!seen.has(k)) {
      seen.add(k);
      events.push(e);
    }
  };
  // Lo que ya pasó: la nómina liquidada.
  for (const m of movements) {
    if (m.status === 'settled' && m.direction === 'out' && isPayroll(m.category))
      add({ date: effectiveDay(m), label: 'Nómina', tone: 'amber' });
  }
  if (forecast) {
    const horizon = addDaysIso(today, 75);
    const items = forecast.weeks
      .flatMap((w) => w.items)
      .filter((i) => i.expectedDate > today && i.expectedDate <= horizon);
    for (const it of items)
      if (it.direction === 'out' && isPayroll(it.category))
        add({ date: it.expectedDate.slice(0, 10), label: 'Nómina', tone: 'amber' });
    const big = (dir: 'in' | 'out') =>
      items
        .filter((i) => i.direction === dir && !isPayroll(i.category))
        .sort((a, b) => b.expectedAmount - a.expectedAmount)
        .slice(0, 2);
    for (const it of big('out'))
      add({
        date: it.expectedDate.slice(0, 10),
        label: `Pago ${shortName(it.counterpartyName ?? it.label, 14)}`,
        tone: 'rose',
      });
    for (const it of big('in'))
      add({
        date: it.expectedDate.slice(0, 10),
        label: `Cobro ${shortName(it.counterpartyName ?? it.label, 14)}`,
        tone: 'emerald',
      });
  }
  void currency;
  return events.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Registros que se abren al hacer clic
// ---------------------------------------------------------------------------

function titleOf(m: LedgerMovement): string {
  return m.counterpartyName?.trim() || m.description.trim() || 'Sin descripción';
}

function recordBase(m: LedgerMovement) {
  return { id: m.id, title: titleOf(m), amount: Math.round(signed(m)) };
}

export function cashRecords(movements: readonly LedgerMovement[], isAdmin: boolean): DrillRecord[] {
  const out: DrillRecord[] = [];
  for (const m of movements) {
    if (m.kind === 'transfer' || m.status === 'cancelled') continue;
    if (!isAdmin && m.direction === 'out' && isPayroll(m.category)) continue;
    out.push({
      ...recordBase(m),
      date: effectiveDay(m),
      subtitle: m.status === 'settled' ? (m.category ?? 'Movimiento') : 'Esperado',
      tone: m.direction === 'in' ? 'emerald' : 'rose',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cartera vencida
// ---------------------------------------------------------------------------

function isReceivable(m: LedgerMovement): boolean {
  return (
    m.direction === 'in' &&
    (m.kind === 'receivable' || m.kind === 'income') &&
    m.status !== 'cancelled'
  );
}

/** Cada factura por cobrar, con el tramo en que estuvo vencida. */
export function overdueIntervals(movements: readonly LedgerMovement[]) {
  const out: Array<{ m: LedgerMovement; from: string; until: string | null; amount: number }> = [];
  for (const m of movements) {
    if (!isReceivable(m) || m.kind !== 'receivable') continue;
    if (!m.dueDate) continue;
    const from = addDaysIso(m.dueDate.slice(0, 10), 1);
    const until = m.status === 'settled' ? (m.settledAt ?? m.date).slice(0, 10) : null;
    const amount = m.status === 'expected' ? (m.outstanding ?? m.amount) : m.amount;
    if (until && until < from) continue;
    out.push({ m, from, until, amount });
  }
  return out;
}

export function overdueSeries(
  movements: readonly LedgerMovement[],
  today: string,
  days = HISTORY_DAYS,
): DayPoint[] {
  const first = addDaysIso(today, -days);
  const n = days + 1;
  const diff = new Array<number>(n + 1).fill(0);
  const idx = (d: string) => Math.min(n, Math.max(0, diffDays(d, first)));
  for (const iv of overdueIntervals(movements)) {
    if (iv.from > today) continue;
    diff[idx(iv.from)] = (diff[idx(iv.from)] ?? 0) + iv.amount;
    // Un día liquidado ya no cuenta desde ese día.
    const end = iv.until ? idx(iv.until) : n;
    diff[end] = (diff[end] ?? 0) - iv.amount;
  }
  const out: DayPoint[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += diff[i] ?? 0;
    out.push({ date: addDaysIso(first, i), value: Math.round(Math.max(0, run)) });
  }
  return out;
}

export function overdueRecords(movements: readonly LedgerMovement[]): DrillRecord[] {
  return overdueIntervals(movements).map(({ m, from, until, amount }) => ({
    id: m.id,
    title: titleOf(m),
    amount: Math.round(amount),
    date: from,
    until,
    subtitle: `Venció el ${dayLabel(addDaysIso(from, -1))}`,
    tone: 'rose' as const,
  }));
}

// ---------------------------------------------------------------------------
// Por pagar y ventas
// ---------------------------------------------------------------------------

function isPayable(m: LedgerMovement, isAdmin: boolean): boolean {
  if (m.direction !== 'out' || m.status === 'cancelled') return false;
  if (m.kind !== 'payable' && !(m.kind === 'expense' && m.status === 'expected')) return false;
  if (!isAdmin && isPayroll(m.category)) return false;
  return true;
}

export function payablesDaily(
  movements: readonly LedgerMovement[],
  today: string,
  isAdmin: boolean,
): DayPoint[] {
  return sumByDay(
    movements
      .filter((m) => isPayable(m, isAdmin))
      .map((m) => ({ date: effectiveDay(m), value: m.amount })),
    addDaysIso(today, -HISTORY_DAYS),
    addDaysIso(today, 150),
  );
}

export function payablesRecords(
  movements: readonly LedgerMovement[],
  isAdmin: boolean,
): DrillRecord[] {
  return movements
    .filter((m) => isPayable(m, isAdmin))
    .map((m) => ({
      id: m.id,
      title: titleOf(m),
      amount: -Math.round(m.amount),
      date: effectiveDay(m),
      subtitle: m.status === 'settled' ? 'Pagada' : 'Vence',
      tone: 'rose' as const,
    }));
}

function isSale(m: LedgerMovement): boolean {
  return (
    m.direction === 'in' &&
    (m.kind === 'receivable' || m.kind === 'income') &&
    m.status !== 'cancelled'
  );
}

export function salesDaily(movements: readonly LedgerMovement[], today: string): DayPoint[] {
  return sumByDay(
    movements.filter(isSale).map((m) => ({ date: m.date.slice(0, 10), value: m.amount })),
    addDaysIso(today, -HISTORY_DAYS),
    today,
  );
}

export function salesRecords(movements: readonly LedgerMovement[]): DrillRecord[] {
  return movements.filter(isSale).map((m) => ({
    id: m.id,
    title: titleOf(m),
    amount: Math.round(m.amount),
    date: m.date.slice(0, 10),
    subtitle: m.kind === 'receivable' ? 'Factura' : 'Ingreso',
    tone: 'emerald' as const,
  }));
}

// ---------------------------------------------------------------------------
// Los indicadores de la tira
// ---------------------------------------------------------------------------

export interface KpiView {
  id: string;
  label: string;
  hint?: string;
  /** La cifra, escrita («$ 48,2 M»). */
  value: string;
  /** Cambio relativo; `null` si no hay base. */
  ratio: number | null;
  /** ¿Ese cambio es bueno? `null` = neutro. */
  good: boolean | null;
  /** «vs. hace 30 días». */
  deltaLabel: string;
  spark: number[];
  sparkLabels: string[];
  tone: ChartTone;
  /** Pide atención (rosa): lo vencido, la caja bajo el mínimo. */
  alert: boolean;
}

function sumRange(points: readonly DayPoint[], from: string, to: string): number {
  let s = 0;
  for (const p of points) if (p.date >= from && p.date <= to) s += p.value;
  return s;
}

function pct(cur: number, prev: number): number | null {
  if (!(Math.abs(prev) >= 0.5)) return null;
  const r = (cur - prev) / Math.abs(prev);
  return Math.abs(r) > 100 ? null : r;
}

export function kpiOf(metric: MetricModel, today: string, opts: { alert?: boolean } = {}): KpiView {
  const fmt = metricFormatters(metric);
  const r30 = rangeById('30d');
  const win = rangeWindow(today, r30);
  const mode = metric.kind === 'stock' ? 'last' : 'sum';
  const b = bucketize(metric.daily, win, r30, { mode, today });
  const spark = b.map((x) => x.value ?? 0);
  const sparkLabels = b.map((x) => x.title);
  const last = (metric.daily.filter((p) => p.date <= today).at(-1)?.value ?? 0) as number;
  let value = last;
  let ratio: number | null;
  let deltaLabel = 'vs. hace 30 días';
  switch (metric.id) {
    case 'ventas': {
      const monthStart = `${today.slice(0, 7)}-01`;
      const elapsed = diffDays(today, monthStart);
      const prevStart = addMonthsClamped(monthStart, -1);
      value = sumRange(metric.daily, monthStart, today);
      ratio = pct(value, sumRange(metric.daily, prevStart, addDaysIso(prevStart, elapsed)));
      deltaLabel = 'vs. el mes pasado a esta altura';
      break;
    }
    case 'por-pagar': {
      value =
        sumRange(metric.daily, today, addDaysIso(today, 6)) + overdueUnpaidBefore(metric, today);
      ratio = pct(
        sumRange(metric.daily, today, addDaysIso(today, 6)),
        sumRange(metric.daily, addDaysIso(today, -7), addDaysIso(today, -1)),
      );
      deltaLabel = 'vs. los 7 días anteriores';
      break;
    }
    case 'cortex': {
      value = sumRange(metric.daily, addDaysIso(today, -6), today);
      ratio = pct(value, sumRange(metric.daily, addDaysIso(today, -13), addDaysIso(today, -7)));
      deltaLabel = 'vs. la semana anterior';
      break;
    }
    default: {
      const s = periodSummary(b, [], mode);
      ratio = s.ratio;
    }
  }
  const good = ratio === null || Math.abs(ratio) < 0.005 ? null : ratio >= 0 === metric.goodWhenUp;
  return {
    id: metric.id,
    label: metric.label,
    hint: metric.hint,
    value: fmt.value(value),
    ratio,
    good,
    deltaLabel,
    spark,
    sparkLabels,
    tone: metric.tone,
    alert: opts.alert ?? false,
  };
}

function addMonthsClamped(monthStartIso: string, n: number): string {
  const [y, m] = monthStartIso.split('-').map(Number);
  const total = (y as number) * 12 + ((m as number) - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** Lo vencido sin pagar entra a «Por pagar»: ya no se puede esperar. */
function overdueUnpaidBefore(metric: MetricModel, today: string): number {
  const rec = metric.records ?? [];
  return rec
    .filter((r) => r.date < today && r.subtitle === 'Vence')
    .reduce((s, r) => s + Math.abs(r.amount), 0);
}

// ---------------------------------------------------------------------------
// Las métricas de Hoy
// ---------------------------------------------------------------------------

export interface HoyMoneyInput {
  today: string;
  currency: string;
  isAdmin: boolean;
  cashTotal: number | null;
  movements: readonly LedgerMovement[];
  /** Ya enmascarada para quien no administra. */
  forecast: ForecastResult | null;
  minimumCash: number | null;
  /** Corridas del piloto: cuántas cosas hizo cada día. `null` = módulo apagado. */
  runs: ReadonlyArray<{ day: string; done: number }> | null;
}

export interface HoyMetrics {
  metrics: MetricModel[];
  kpis: KpiView[];
}

export function buildHoyMetrics(input: HoyMoneyInput): HoyMetrics {
  const { today, currency, isAdmin } = input;
  const ms = input.movements.filter((m) => m.currency.toUpperCase() === currency.toUpperCase());
  const metrics: MetricModel[] = [];
  const alerts = new Set<string>();

  // Caja
  if (input.cashTotal !== null) {
    const settled = ms
      .filter((m) => m.status === 'settled' && m.kind !== 'transfer')
      .map((m) => ({ date: effectiveDay(m), net: signed(m), m }));
    const history = cashHistory(settled, input.cashTotal, today);
    const inflow = sumByDay(
      settled.filter((s) => s.net > 0).map((s) => ({ date: s.date, value: s.net })),
      addDaysIso(today, -HISTORY_DAYS),
      today,
    );
    const outflow = sumByDay(
      settled.filter((s) => s.net < 0).map((s) => ({ date: s.date, value: -s.net })),
      addDaysIso(today, -HISTORY_DAYS),
      today,
    );
    const projection = input.forecast ? projectionFromForecast(input.forecast, today) : undefined;
    const min = input.minimumCash;
    if (min !== null && min > 0 && input.cashTotal < min) alerts.add('caja');
    metrics.push({
      id: 'caja',
      label: 'Caja',
      hint: 'Lo que hay en tus cuentas',
      fmt: 'money',
      currency,
      kind: 'stock',
      tone: 'primary',
      goodWhenUp: true,
      daily: history,
      projection: projection?.length ? projection : undefined,
      inOut: inflow.length || outflow.length ? { inflow, outflow } : undefined,
      threshold: min !== null && min > 0 ? { value: min, label: 'Caja mínima' } : undefined,
      events: cashEvents(input.forecast, ms, today, currency),
      records: cashRecords(ms, isAdmin),
      recordsKind: 'flow',
      fullHref: '/finance',
      fullLabel: 'Abrir Finanzas',
      recordsNoun: 'movimientos',
    });
  }

  // Cartera vencida
  const overdue = overdueSeries(ms, today);
  const overdueNow = overdue.at(-1)?.value ?? 0;
  if (overdueNow > 0) alerts.add('vencido');
  metrics.push({
    id: 'vencido',
    label: 'Te deben vencido',
    hint: 'Facturas que ya pasaron su fecha',
    fmt: 'money',
    currency,
    kind: 'stock',
    tone: 'rose',
    goodWhenUp: false,
    daily: overdue,
    records: overdueRecords(ms),
    fullHref: '/finance#me-deben',
    fullLabel: 'Abrir la cartera',
    recordsNoun: 'facturas',
  });

  // Por pagar
  metrics.push({
    id: 'por-pagar',
    label: 'Por pagar 7 días',
    hint: 'Lo que vence esta semana, y lo vencido',
    fmt: 'money',
    currency,
    kind: 'flow',
    tone: 'amber',
    goodWhenUp: false,
    daily: payablesDaily(ms, today, isAdmin),
    futureInDaily: true,
    records: payablesRecords(ms, isAdmin),
    fullHref: '/pagar',
    fullLabel: 'Abrir Por pagar',
    recordsNoun: 'facturas',
  });

  // Ventas
  metrics.push({
    id: 'ventas',
    label: 'Ventas del mes',
    hint: 'Lo facturado y lo que entró sin factura',
    fmt: 'money',
    currency,
    kind: 'flow',
    tone: 'emerald',
    goodWhenUp: true,
    daily: salesDaily(ms, today),
    records: salesRecords(ms),
    fullHref: '/ventas',
    fullLabel: 'Abrir Ventas',
    recordsNoun: 'ventas',
  });

  // Operación: lo que el piloto resolvió
  if (input.runs) {
    metrics.push({
      id: 'cortex',
      label: 'Cortex hizo',
      hint: 'Cosas resueltas por el piloto, esta semana',
      fmt: 'count',
      currency,
      unit: 'cosas',
      kind: 'flow',
      tone: 'sky',
      goodWhenUp: true,
      daily: input.runs.map((r) => ({ date: r.day, value: r.done })),
      fullHref: '/actividad',
      fullLabel: 'Ver todo lo que hizo',
      recordsNoun: 'cosas',
    });
  }

  return { metrics, kpis: metrics.map((m) => kpiOf(m, today, { alert: alerts.has(m.id) })) };
}

// ---------------------------------------------------------------------------
// La frase de arriba
// ---------------------------------------------------------------------------

export interface NarrativePart {
  text: string;
  /** Resaltada, como con marcatextos. */
  mark?: boolean;
}

const COUNT_WORDS = [
  'ninguna',
  'una',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
];

export function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

export function greetingFor(hour: number): string {
  return hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
}

export interface NarrativeInput {
  today: string;
  currency: string;
  /** `null`: no se ve la plata (módulo apagado o sin datos). */
  cash: { total: number; minimum: number | null } | null;
  forecast: ForecastResult | null;
  overdue: { total: number; biggest: string | null } | null;
  waiting: number;
  autopilotDone: number;
}

/**
 * Tres frases, por reglas (ningún modelo): cómo está la caja, qué te deben y
 * cuántas cosas necesitan de ti. Se escribe en cada carga, así que tiene que
 * ser barata y dar lo mismo para los mismos datos.
 */
export function narrative(input: NarrativeInput): NarrativePart[] {
  const parts: NarrativePart[] = [];
  const money = (n: number) => formatMoney(n, input.currency);
  const push = (text: string, mark = false) => parts.push({ text, mark });

  const { cash, forecast } = input;
  if (cash && forecast) {
    const min = cash.minimum ?? forecast.minimumCash ?? 0;
    const low = forecast.lowest;
    const payroll = forecast.weeks
      .flatMap((w) => w.items)
      .filter((i) => i.direction === 'out' && isPayroll(i.category) && i.expectedDate > input.today)
      .sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : 1))[0];
    if (low.closing < 0) {
      push(
        `Ojo con la caja: hacia el ${dayLabel(low.week)} la proyección la deja en ${money(low.closing)}. `,
      );
    } else if (min > 0 && low.closing < min) {
      push(
        `Ojo con la caja: la semana del ${dayLabel(low.week)} bajaría a ${money(low.closing)}, por debajo de tu mínimo. `,
      );
    } else if (payroll) {
      push(`La caja está bien y aguanta la nómina del ${dayLabel(payroll.expectedDate)}. `);
    } else {
      push('La caja está bien y no veo apuros en las próximas semanas. ');
    }
  } else if (cash) {
    push(`Hoy tienes ${money(cash.total)} en caja. `);
  }

  if (input.overdue && input.overdue.total > 0) {
    push(
      `Te deben ${money(input.overdue.total)} vencido${input.overdue.biggest ? `, sobre todo ${input.overdue.biggest}` : ''}. `,
    );
  }

  if (input.waiting === 0) {
    push(
      input.autopilotDone > 0
        ? 'No necesito nada de ti ahora; ya resolví lo rutinario.'
        : 'No necesito nada de ti por ahora.',
    );
  } else {
    push('Solo te necesito para ');
    push(`${countWord(input.waiting)} ${input.waiting === 1 ? 'cosa' : 'cosas'}`, true);
    push(input.autopilotDone > 0 ? '; lo demás ya lo estoy moviendo.' : '.');
  }
  return parts;
}

/** El texto plano de la frase (para el lector de pantalla y las pruebas). */
export function narrativeText(parts: readonly NarrativePart[]): string {
  return parts.map((p) => p.text).join('');
}
