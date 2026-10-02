/**
 * EL PANEL DE FINANZAS, EN DATOS: LO QUE /finance PINTA Y CÓMO SE ARMA.
 *
 * Puro y sin base de datos: lo usan el cargador del servidor (dashboard.ts),
 * el escaparate de desarrollo (/v/finanzas-showcase) y los componentes del
 * navegador. Sólo importa TIPOS del libro y las ayudas puras de la proyección
 * (`forecast-shared`), nunca el almacén.
 *
 * Cada pieza del panel es un `Piece`: o trae su dato o trae por qué no. Una
 * lectura que falla deja su sección en «sin dato» y el resto de la página
 * sigue en pie.
 *
 * LA NÓMINA ES CONFIDENCIAL para quien no administra la empresa: aquí se
 * enmascara ANTES de que el dato salga del servidor (nombres y montos por
 * persona nunca llegan al navegador), y sólo queda su total.
 */

import {
  addDays,
  categoryKey,
  categoryLabel,
  daysBetween,
  formatDay,
  formatMoney,
  mondayOf,
  normalizeName,
} from '@cortex/agent-tools/src/ledger/forecast-shared';
import {
  PAYROLL_CONFIDENTIAL_KEY,
  PAYROLL_CONFIDENTIAL_LABEL,
  isPayrollCategory,
} from '@cortex/agent-tools/src/ledger/privacy';
import type {
  CashAccount,
  ForecastItem,
  ForecastResult,
  LedgerDirection,
  LedgerMovement,
  RecurringFlow,
  Scenario,
  ScenarioAdjustment,
} from '@cortex/agent-tools/src/ledger/types';

// ---------------------------------------------------------------------------
// Las piezas
// ---------------------------------------------------------------------------

export type Piece<T> = { ok: true; data: T } | { ok: false; error: string };

/** Una promesa que nunca rompe la página: o su dato, o «sin dato» con el motivo. */
export async function settle<T>(work: Promise<T> | (() => Promise<T>), error: string) {
  try {
    const data = await (typeof work === 'function' ? work() : work);
    return { ok: true, data } as Piece<T>;
  } catch {
    return { ok: false, error } as Piece<T>;
  }
}

export interface CashAccountLine {
  id: string;
  name: string;
  currency: string;
  balance: number;
  balanceAt: string;
  /** «hoy», «ayer», «hace 3 días». */
  age: string;
  stale: boolean;
  /** «Extracto · Bancolombia», «Lo dijo una persona», «Siigo». */
  source: string;
}

export interface CashToday {
  currency: string;
  total: number;
  accounts: CashAccountLine[];
  /** Saldos en otra moneda: se muestran, no se suman. */
  others: Array<{ currency: string; total: number }>;
}

export interface ForecastPanel {
  currency: string;
  minimumCash: number | null;
  base: ForecastResult;
  scenario: ForecastResult | null;
  comparison: { summary: string } | null;
}

export interface PnlMonth {
  month: string;
  sales: number;
  otherIncome: number;
  expenses: number;
  byCategory: Record<string, number>;
  margin: number;
}

export interface CategoryChange {
  key: string;
  label: string;
  amount: number;
  previous: number | null;
  /** Fracción de cambio contra el mes anterior; null si el anterior era 0. */
  change: number | null;
  confidential: boolean;
}

export interface PnlPanel {
  currency: string;
  months: PnlMonth[];
  /** El mes que se mira (AAAA-MM). */
  focus: string;
  payrollConfidential: boolean;
}

export interface DueParty {
  name: string;
  amount: number;
  count: number;
  /** El vencimiento más cercano (o el más viejo, si ya venció). */
  nextDue: string | null;
  /** Días de atraso del más viejo; null si nada está vencido. */
  overdueDays: number | null;
}

export interface DueSide {
  total: number;
  overdue: number;
  parties: DueParty[];
}

export interface DuePanel {
  currency: string;
  receivable: DueSide;
  payable: DueSide;
  /** Nómina por pagar que no se muestra por persona (quien no administra). */
  payrollHidden: number;
}

export type RecurringStatus = 'pending' | 'declared' | 'confirmed' | 'ignored';

export interface RecurringRow {
  key: string;
  flow: RecurringFlow;
  status: RecurringStatus;
  /** Con qué clave se decide un detectado (Confirmar / No es fijo). */
  detectedKey: string | null;
  confidential: boolean;
}

export interface ScenarioChip {
  id: string;
  label: string;
  description: string;
}

export interface FinanceDashboard {
  today: string;
  currency: string;
  isAdmin: boolean;
  includeEstimatedSales: boolean;
  activeScenarioId: string | null;
  minimumCash: number | null;
  /** Empresa sin nada en el libro: se muestra una sola tarjeta de bienvenida. */
  empty: boolean;
  cash: Piece<CashToday>;
  forecast: Piece<ForecastPanel>;
  scenarios: Piece<ScenarioChip[]>;
  pnl: Piece<PnlPanel>;
  due: Piece<DuePanel>;
  recurring: Piece<RecurringRow[]>;
  /** Nombres para autocompletar el armador de escenarios. */
  counterparties: string[];
}

// ---------------------------------------------------------------------------
// Cifras y fechas para leer
// ---------------------------------------------------------------------------

export { formatDay, formatMoney };

const FULL = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/** «$ 52.000.000», «−$ 3.200.000», «12.000 USD». Para saldos que se verifican. */
export function fullMoney(value: number, currency = 'COP'): string {
  const sign = value < 0 ? '−' : '';
  const n = FULL.format(Math.abs(Math.round(value)));
  return currency.toUpperCase() === 'COP' ? `${sign}$ ${n}` : `${sign}${n} ${currency}`;
}

/** «+12 %», «−8 %», «=». */
export function changeText(change: number | null): string {
  if (change == null) return 'nuevo';
  const pct = Math.round(change * 100);
  if (pct === 0) return '= 0 %';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`;
}

/** Cuánto pesa una línea en la proyección: «se cuenta completo», «se cuenta el 80 %». */
export function probabilityText(probability: number): string {
  if (probability >= 0.995) return 'se cuenta completo';
  const pct = Math.max(1, Math.round(probability * 100));
  return `se cuenta el ${pct} %`;
}

/** «hoy», «ayer», «hace 3 días», «hace 2 meses». */
export function ageLabel(at: string, today: string): string {
  const days = Math.max(0, daysBetween(at.slice(0, 10), today));
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 45) return `hace ${days} días`;
  const months = Math.round(days / 30);
  return `hace ${months} ${months === 1 ? 'mes' : 'meses'}`;
}

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
const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** «2026-10» → «octubre 2026». */
export function monthLabel(month: string, withYear = true): string {
  const name = MONTHS_LONG[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${name} ${month.slice(0, 4)}` : name;
}

/** «2026-10» → «oct». */
export function monthShort(month: string): string {
  return MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
}

/** El mes AAAA-MM corrido `delta` meses. */
export function shiftMonth(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Caja hoy
// ---------------------------------------------------------------------------

export const STALE_BALANCE_DAYS = 7;

export interface AccountLike {
  id: string;
  name: string;
  currency: string;
  balance: number;
  balanceAt: string;
  /** De dónde salió el saldo: extracto, una persona, el programa contable. */
  balanceSource?: 'bank' | 'manual' | 'accounting' | null;
  sourceSystem?: string | null;
}

export function sourceLabel(account: Pick<AccountLike, 'balanceSource' | 'sourceSystem'>): string {
  const system = account.sourceSystem?.trim();
  switch (account.balanceSource) {
    case 'bank':
      return system ? `Extracto · ${system}` : 'Extracto del banco';
    case 'accounting':
      return system ? `Programa contable · ${system}` : 'Programa contable';
    case 'manual':
      return 'Lo dijo una persona';
    default:
      return system || 'Sin fuente';
  }
}

/** La caja de hoy: total en la moneda principal y cada cuenta con su fecha. */
export function buildCash(accounts: AccountLike[], today: string, currency = 'COP'): CashToday {
  const main = currency.toUpperCase();
  const lines = accounts
    .map((a) => {
      const days = Math.max(0, daysBetween(a.balanceAt.slice(0, 10), today));
      return {
        id: a.id,
        name: a.name,
        currency: a.currency.toUpperCase(),
        balance: Math.round(a.balance),
        balanceAt: a.balanceAt.slice(0, 10),
        age: ageLabel(a.balanceAt, today),
        stale: days > STALE_BALANCE_DAYS,
        source: sourceLabel(a),
      };
    })
    .sort((a, b) =>
      a.currency === b.currency
        ? b.balance - a.balance
        : a.currency === main
          ? -1
          : b.currency === main
            ? 1
            : a.currency < b.currency
              ? -1
              : 1,
    );
  const others = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    if (l.currency === main) total += l.balance;
    else others.set(l.currency, (others.get(l.currency) ?? 0) + l.balance);
  }
  return {
    currency: main,
    total,
    accounts: lines,
    others: [...others.entries()].map(([c, t]) => ({ currency: c, total: t })),
  };
}

/** Desde las cuentas del contrato (escaparate, pruebas). */
export function accountsFromCash(accounts: CashAccount[]): AccountLike[] {
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
    balance: a.balance,
    balanceAt: a.balanceAt,
    balanceSource:
      a.source.kind === 'bank' ? 'bank' : a.source.kind === 'accounting' ? 'accounting' : 'manual',
    sourceSystem: a.source.system ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Nómina confidencial
// ---------------------------------------------------------------------------

export const PAYROLL_LABEL = PAYROLL_CONFIDENTIAL_LABEL;

/** Nómina, sea la categoría del libro o el total ya doblado por `monthlyPnl`. */
export function isPayroll(category: string | null | undefined): boolean {
  return category === PAYROLL_CONFIDENTIAL_KEY || isPayrollCategory(category);
}

/**
 * La proyección para quien no administra: las líneas de nómina de cada semana
 * se funden en una sola, sin nombres ni montos por persona. Los totales de la
 * semana no cambian.
 */
export function maskPayroll(result: ForecastResult): ForecastResult {
  return {
    ...result,
    weeks: result.weeks.map((week) => {
      const payroll = week.items.filter((i) => isPayroll(i.category));
      if (payroll.length === 0) return week;
      const rest = week.items.filter((i) => !isPayroll(i.category));
      const amount = payroll.reduce(
        (s, i) => s + (i.direction === 'out' ? i.amount : -i.amount),
        0,
      );
      const expected = payroll.reduce(
        (s, i) => s + (i.direction === 'out' ? i.expectedAmount : -i.expectedAmount),
        0,
      );
      const merged: ForecastItem = {
        label: PAYROLL_LABEL,
        direction: amount >= 0 ? 'out' : 'in',
        amount: Math.abs(Math.round(amount)),
        expectedAmount: Math.abs(Math.round(expected)),
        probability: amount !== 0 ? Math.min(1, Math.abs(expected / amount)) : 1,
        expectedDate: payroll.map((i) => i.expectedDate).sort()[0] ?? week.start,
        reason:
          'El total de nómina de la semana. El detalle por persona sólo lo ven quienes administran la empresa.',
        category: 'nomina',
        from: 'recurring',
      };
      return { ...week, items: [...rest, merged] };
    }),
  };
}

// ---------------------------------------------------------------------------
// Quién me debe / a quién le debo
// ---------------------------------------------------------------------------

/**
 * Lo abierto por contraparte: facturas y lo esperado, por su saldo pendiente.
 * Los cinco que más pesan de cada lado; lo vencido dice cuántos días lleva.
 */
export function buildDue(
  movements: readonly LedgerMovement[],
  today: string,
  opts: { currency?: string; isAdmin: boolean; limit?: number },
): DuePanel {
  const currency = (opts.currency ?? 'COP').toUpperCase();
  const limit = opts.limit ?? 5;
  const sides = {
    in: new Map<string, DueParty & { earliest: string | null }>(),
    out: new Map<string, DueParty & { earliest: string | null }>(),
  };
  const totals = { in: { total: 0, overdue: 0 }, out: { total: 0, overdue: 0 } };
  let payrollHidden = 0;
  for (const m of movements) {
    if (m.status !== 'expected' || m.kind === 'transfer') continue;
    if (m.currency.toUpperCase() !== currency) continue;
    const pending = m.outstanding ?? m.amount;
    if (!(pending > 0.5)) continue;
    if (!opts.isAdmin && m.direction === 'out' && isPayroll(m.category)) {
      payrollHidden += pending;
      continue;
    }
    const due = m.dueDate ?? (m.kind === 'income' || m.kind === 'expense' ? m.date : null);
    const late = due ? daysBetween(due, today) : null;
    const name = m.counterpartyName?.trim() || m.description.trim() || 'Sin contraparte';
    // «Nexa Logística» y «Nexa Logística S.A.S.» son la misma: un solo renglón.
    const key = normalizeName(name) || name.toLowerCase();
    const side = sides[m.direction];
    const party = side.get(key) ?? {
      name,
      amount: 0,
      count: 0,
      nextDue: null,
      overdueDays: null,
      earliest: null,
    };
    if (name.length > party.name.length) party.name = name;
    party.amount += pending;
    party.count += 1;
    if (due && (!party.earliest || due < party.earliest)) party.earliest = due;
    if (late != null && late > 0) party.overdueDays = Math.max(party.overdueDays ?? 0, late);
    side.set(key, party);
    totals[m.direction].total += pending;
    if (late != null && late > 0) totals[m.direction].overdue += pending;
  }
  const side = (dir: LedgerDirection): DueSide => ({
    total: Math.round(totals[dir].total),
    overdue: Math.round(totals[dir].overdue),
    parties: [...sides[dir].values()]
      .sort((a, b) => b.amount - a.amount || (a.name < b.name ? -1 : 1))
      .slice(0, limit)
      .map(({ earliest, ...p }) => ({ ...p, amount: Math.round(p.amount), nextDue: earliest })),
  });
  return {
    currency,
    receivable: side('in'),
    payable: side('out'),
    payrollHidden: Math.round(payrollHidden),
  };
}

/** Los nombres que el armador de escenarios ofrece al escribir. */
export function counterpartyNames(movements: readonly LedgerMovement[], limit = 40): string[] {
  const seen = new Map<string, { name: string; weight: number }>();
  for (const m of movements) {
    const name = m.counterpartyName?.trim();
    if (!name || isPayroll(m.category)) continue;
    const key = name.toLowerCase();
    const entry = seen.get(key) ?? { name, weight: 0 };
    entry.weight += m.status === 'expected' ? 3 : 1;
    seen.set(key, entry);
  }
  return [...seen.values()]
    .sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : 1))
    .slice(0, limit)
    .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Gastos fijos
// ---------------------------------------------------------------------------

export interface RecurringDecision extends RecurringFlow {
  status: 'declared' | 'confirmed' | 'ignored';
  detectedKey?: string | null;
}

/**
 * Lo detectado y lo decidido, juntos: un detectado sin decisión queda «por
 * confirmar»; uno con decisión toma su estado; lo declarado se suma. Para
 * quien no administra, la nómina se funde en una fila confidencial.
 */
export function mergeRecurring(
  detected: readonly RecurringFlow[],
  decisions: readonly RecurringDecision[],
  opts: { isAdmin: boolean },
): RecurringRow[] {
  const decided = new Map<string, RecurringDecision>();
  for (const d of decisions) if (d.detectedKey) decided.set(d.detectedKey, d);
  const rows: RecurringRow[] = [];
  for (const flow of detected) {
    // La llave estable del detectado (ledger/recurring); el id sólo si no la trae.
    const key = flow.detectedKey ?? flow.id;
    const decision = decided.get(key);
    decided.delete(key);
    rows.push({
      key,
      flow: decision?.status === 'declared' ? { ...flow, ...stripDecision(decision) } : flow,
      status: decision ? decision.status : 'pending',
      detectedKey: key,
      confidential: false,
    });
  }
  for (const d of decisions) {
    if (d.detectedKey && !decided.has(d.detectedKey)) continue; // ya se juntó con su detectado
    const { status, detectedKey, ...flow } = d;
    rows.push({
      key: d.id,
      flow,
      status,
      detectedKey: detectedKey ?? null,
      confidential: false,
    });
  }
  const order: Record<RecurringStatus, number> = {
    pending: 0,
    confirmed: 1,
    declared: 1,
    ignored: 2,
  };
  rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (a.flow.direction === b.flow.direction ? 0 : a.flow.direction === 'out' ? -1 : 1) ||
      b.flow.amount - a.flow.amount,
  );
  if (opts.isAdmin) return rows;

  const payroll = rows.filter((r) => isPayroll(r.flow.category) && r.status !== 'ignored');
  const rest = rows.filter((r) => !isPayroll(r.flow.category));
  if (payroll.length === 0) return rest;
  const monthly = payroll.reduce(
    (s, r) => s + (r.flow.every === 'week' ? (r.flow.amount * 52) / 12 : r.flow.amount),
    0,
  );
  const first = payroll[0] as RecurringRow;
  return [
    {
      key: 'nomina-confidencial',
      flow: {
        id: 'nomina-confidencial',
        label: PAYROLL_LABEL,
        direction: 'out',
        amount: Math.round(monthly),
        currency: first.flow.currency,
        every: 'month',
        anchor: 30,
        category: 'nomina',
        origin: 'declared',
      },
      status: 'confirmed',
      detectedKey: null,
      confidential: true,
    },
    ...rest,
  ];
}

function stripDecision(d: RecurringDecision): RecurringFlow {
  const { status: _status, ...flow } = d;
  return flow;
}

/** «cada mes, el día 5», «cada lunes». */
export function cadenceText(flow: Pick<RecurringFlow, 'every' | 'anchor'>): string {
  if (flow.every === 'week') {
    const days = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
    return `cada ${days[(Math.round(flow.anchor) - 1 + 7) % 7] ?? 'semana'}`;
  }
  return `cada mes, el día ${Math.round(flow.anchor)}`;
}

// ---------------------------------------------------------------------------
// Resultados del mes
// ---------------------------------------------------------------------------

/** Antes del día 10 el mes en curso casi no tiene datos: se mira el anterior. */
export function defaultPnlFocus(today: string): string {
  const month = today.slice(0, 7);
  return Number(today.slice(8, 10)) < 10 ? shiftMonth(month, -1) : month;
}

export function findMonth(months: readonly PnlMonth[], month: string): PnlMonth | null {
  return months.find((m) => m.month === month) ?? null;
}

export function pctChange(now: number, before: number | null | undefined): number | null {
  if (before == null || before === 0) return null;
  return (now - before) / Math.abs(before);
}

const INCOME_KEYS = new Set(['ventas', 'otros_ingresos']);

/** Gastos por categoría del mes contra el anterior, del que más pesa al que menos. */
export function categoryChanges(
  current: PnlMonth | null,
  previous: PnlMonth | null,
  opts: { payrollConfidential: boolean },
): CategoryChange[] {
  if (!current) return [];
  const keys = new Set([
    ...Object.keys(current.byCategory),
    ...Object.keys(previous?.byCategory ?? {}),
  ]);
  const out: CategoryChange[] = [];
  for (const key of keys) {
    if (INCOME_KEYS.has(categoryKey(key))) continue;
    const amount = current.byCategory[key] ?? 0;
    const before = previous ? (previous.byCategory[key] ?? 0) : null;
    if (amount <= 0 && !before) continue;
    const confidential = opts.payrollConfidential && isPayroll(key);
    out.push({
      key,
      label: confidential
        ? PAYROLL_LABEL
        : key === 'sin_categoria'
          ? 'Sin categoría'
          : categoryLabel(key),
      amount: Math.round(amount),
      previous: before == null ? null : Math.round(before),
      change: pctChange(amount, before),
      confidential,
    });
  }
  return out.sort((a, b) => b.amount - a.amount || (a.label < b.label ? -1 : 1));
}

// ---------------------------------------------------------------------------
// El gráfico de 13 semanas
// ---------------------------------------------------------------------------

export interface ChartWeek {
  start: string;
  label: string;
  inflows: number;
  outflows: number;
  closing: number;
  scenarioClosing: number | null;
  lowest: boolean;
  scenarioLowest: boolean;
  belowMinimum: boolean;
}

export function chartWeeks(
  base: ForecastResult,
  scenario: ForecastResult | null,
  minimumCash: number | null,
): ChartWeek[] {
  const byStart = new Map(scenario?.weeks.map((w) => [w.start, w]) ?? []);
  return base.weeks.map((w) => {
    const s = byStart.get(w.start);
    return {
      start: w.start,
      label: formatDay(w.start),
      inflows: Math.round(w.inflows),
      outflows: Math.round(w.outflows),
      closing: Math.round(w.closing),
      scenarioClosing: s ? Math.round(s.closing) : null,
      lowest: w.start === base.lowest.week,
      scenarioLowest: Boolean(scenario && s && w.start === scenario.lowest.week),
      belowMinimum: minimumCash != null && w.closing < minimumCash,
    };
  });
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/**
 * Un solo eje para todo (entradas arriba, salidas abajo del cero, y la caja de
 * cierre como línea): son pesos los tres, así que se leen en la misma escala.
 */
export function chartScale(
  weeks: readonly ChartWeek[],
  minimumCash: number | null,
): { min: number; max: number; ticks: number[] } {
  let lo = 0;
  let hi = 0;
  for (const w of weeks) {
    hi = Math.max(hi, w.inflows, w.closing, w.scenarioClosing ?? 0);
    lo = Math.min(lo, -w.outflows, w.closing, w.scenarioClosing ?? 0);
  }
  if (minimumCash != null) {
    hi = Math.max(hi, minimumCash);
    lo = Math.min(lo, minimumCash);
  }
  if (hi === lo) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t));
  return { min, max, ticks };
}

/** La semana del item que se abre (cualquier día sirve). */
export function weekOf(day: string): string {
  return mondayOf(day.slice(0, 10));
}

// ---------------------------------------------------------------------------
// El armador de escenarios
// ---------------------------------------------------------------------------

export type DraftKind = ScenarioAdjustment['kind'];

/** Una fila del armador, tal como la escribe la persona (todo texto). */
export interface DraftRow {
  kind: DraftKind;
  counterparty: string;
  days: string;
  label: string;
  direction: LedgerDirection;
  amount: string;
  every: 'week' | 'month';
  date: string;
  category: string;
  percent: string;
}

export const DRAFT_KIND_LABEL: Record<DraftKind, string> = {
  delay_counterparty: 'Un cliente paga tarde',
  drop_counterparty: 'Un cliente no paga',
  add_recurring: 'Nuevo gasto o ingreso fijo',
  scale_category: 'Sube o baja una categoría',
  one_off: 'Un pago o cobro puntual',
};

export function emptyDraft(kind: DraftKind, today: string): DraftRow {
  return {
    kind,
    counterparty: '',
    days: '30',
    label: '',
    direction: 'out',
    amount: '',
    every: 'month',
    date: addDays(today, 14),
    category: 'nomina',
    percent: '10',
  };
}

/**
 * Plata escrita como la escribe una persona en Colombia: «48.300.000»,
 * «$ 2.500.000», «48,5 M», «950 mil», «1200000». Null si no se entiende.
 */
export function parseMoneyInput(raw: string): number | null {
  let s = raw
    .trim()
    .toLowerCase()
    .replace(/\$|cop|pesos/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  let factor = 1;
  const suffix = s.match(/\s?(millones|millón|millon|mm|m|mil|k)$/);
  if (suffix) {
    const word = suffix[1] as string;
    factor = word === 'mil' || word === 'k' ? 1e3 : 1e6;
    s = s.slice(0, s.length - suffix[0].length).trim();
  }
  s = s.replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(s)) return null;
  let normalized: string;
  if (s.includes(',')) {
    // La coma es el decimal en Colombia; los puntos, los miles.
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    normalized = s.replace(/\./g, '');
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * factor);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type DraftResult =
  | { ok: true; adjustment: ScenarioAdjustment }
  | { ok: false; error: string };

/** De la fila escrita al ajuste del contrato, o qué falta para que lo sea. */
export function draftToAdjustment(row: DraftRow): DraftResult {
  const name = row.counterparty.trim();
  const label = row.label.trim();
  switch (row.kind) {
    case 'delay_counterparty': {
      if (!name) return { ok: false, error: 'Escribe qué cliente paga tarde.' };
      const days = Number(row.days);
      if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 365)
        return { ok: false, error: 'Los días de atraso van de 1 a 365.' };
      return {
        ok: true,
        adjustment: { kind: 'delay_counterparty', counterpartyName: name, days: Math.round(days) },
      };
    }
    case 'drop_counterparty':
      if (!name) return { ok: false, error: 'Escribe qué cliente no paga.' };
      return { ok: true, adjustment: { kind: 'drop_counterparty', counterpartyName: name } };
    case 'add_recurring': {
      const amount = parseMoneyInput(row.amount);
      if (!label) return { ok: false, error: 'Ponle nombre al gasto o ingreso fijo.' };
      if (!amount || amount <= 0)
        return { ok: false, error: 'Escribe el monto, por ejemplo 2.500.000.' };
      if (!ISO_DAY.test(row.date)) return { ok: false, error: 'Escoge desde qué día empieza.' };
      return {
        ok: true,
        adjustment: {
          kind: 'add_recurring',
          label,
          direction: row.direction,
          amount,
          every: row.every,
          start: row.date,
        },
      };
    }
    case 'scale_category': {
      const pct = Number(row.percent.replace(',', '.').replace('%', '').trim());
      if (!row.category.trim()) return { ok: false, error: 'Escoge la categoría.' };
      if (!Number.isFinite(pct) || pct === 0 || pct < -100 || pct > 500)
        return { ok: false, error: 'El cambio va de −100 % a +500 %, sin ser 0.' };
      return {
        ok: true,
        adjustment: {
          kind: 'scale_category',
          category: row.category.trim(),
          factor: Math.round((1 + pct / 100) * 1000) / 1000,
        },
      };
    }
    case 'one_off': {
      const amount = parseMoneyInput(row.amount);
      if (!label) return { ok: false, error: 'Dile qué es el pago o cobro.' };
      if (!amount || amount <= 0)
        return { ok: false, error: 'Escribe el monto, por ejemplo 2.500.000.' };
      if (!ISO_DAY.test(row.date)) return { ok: false, error: 'Escoge la fecha.' };
      return {
        ok: true,
        adjustment: { kind: 'one_off', label, direction: row.direction, amount, date: row.date },
      };
    }
  }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function money(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e13 ? Math.round(v) : 0;
}

/**
 * Lo que llega del navegador, revisado otra vez en el servidor: un ajuste que
 * no cumple el contrato no se guarda. Lanza con el motivo en palabras.
 */
export function parseAdjustments(input: unknown): ScenarioAdjustment[] {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error('El escenario necesita al menos un cambio.');
  if (input.length > 12) throw new Error('Un escenario admite hasta 12 cambios.');
  return input.map((raw, i): ScenarioAdjustment => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const fail = (why: string): never => {
      throw new Error(`El cambio ${i + 1} no es válido: ${why}`);
    };
    const direction: LedgerDirection = a.direction === 'in' ? 'in' : 'out';
    switch (a.kind) {
      case 'delay_counterparty': {
        const name = str(a.counterpartyName, 120);
        const days = typeof a.days === 'number' ? Math.round(a.days) : Number.NaN;
        if (!name) fail('falta el cliente.');
        if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 365)
          fail('días fuera de rango.');
        return { kind: 'delay_counterparty', counterpartyName: name, days };
      }
      case 'drop_counterparty': {
        const name = str(a.counterpartyName, 120);
        if (!name) fail('falta el cliente.');
        return { kind: 'drop_counterparty', counterpartyName: name };
      }
      case 'add_recurring': {
        const label = str(a.label, 120);
        const amount = money(a.amount);
        const start = str(a.start, 10);
        if (!label || !amount || !ISO_DAY.test(start))
          fail('faltan el nombre, el monto o la fecha.');
        return {
          kind: 'add_recurring',
          label,
          direction,
          amount,
          every: a.every === 'week' ? 'week' : 'month',
          start,
        };
      }
      case 'scale_category': {
        const category = str(a.category, 60);
        const factor = typeof a.factor === 'number' ? a.factor : Number.NaN;
        if (!category || !Number.isFinite(factor) || factor < 0 || factor > 6)
          fail('categoría o porcentaje fuera de rango.');
        return { kind: 'scale_category', category, factor };
      }
      case 'one_off': {
        const label = str(a.label, 120);
        const amount = money(a.amount);
        const date = str(a.date, 10);
        if (!label || !amount || !ISO_DAY.test(date))
          fail('faltan el nombre, el monto o la fecha.');
        return { kind: 'one_off', label, direction, amount, date };
      }
      default:
        return fail('tipo de cambio desconocido.');
    }
  });
}

export function scenarioChip(scenario: Scenario, description: string): ScenarioChip {
  return { id: scenario.id, label: scenario.label, description };
}

// ---------------------------------------------------------------------------
// Direcciones y preguntas a Cortex
// ---------------------------------------------------------------------------

export interface DashboardParams {
  scenarioId?: string | null;
  includeEstimatedSales?: boolean;
  minimumCash?: number | null;
}

/**
 * Una dirección interna con parámetros agregados, respetando los que ya trae
 * (el enlace de la empresa activa lleva su propio `?ws=`).
 */
export function withQuery(
  base: string,
  params: Record<string, string | null | undefined>,
  hash?: string,
): string {
  const url = new URL(base, 'https://cortex.invalid');
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  return `${url.pathname}${url.search}${hash ? `#${hash}` : url.hash}`;
}

/** La dirección del panel con sus opciones, para enlaces que no necesitan JavaScript. */
export function dashboardHref(base: string, params: DashboardParams, hash?: string): string {
  return withQuery(
    base,
    {
      escenario: params.scenarioId || null,
      // Las ventas estimadas cuentan por defecto (como en ledger/plans): sólo se escribe apagarlas.
      estimadas: params.includeEstimatedSales === false ? '0' : null,
      minimo:
        params.minimumCash != null && params.minimumCash > 0
          ? String(Math.round(params.minimumCash))
          : null,
    },
    hash,
  );
}

/** La pregunta lista en el chat: `/chat?prompt=…`. */
export function chatHref(chatBase: string, prompt: string): string {
  return withQuery(chatBase, { prompt });
}

/** Lo contrario: las opciones desde `searchParams`. */
export function readDashboardParams(
  q: Record<string, string | string[] | undefined>,
): Required<DashboardParams> {
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const scenario = one('escenario');
  const min = parseMoneyInput(one('minimo') ?? '');
  return {
    scenarioId: scenario && /^[\w-]{1,80}$/.test(scenario) ? scenario : null,
    includeEstimatedSales: one('estimadas') !== '0',
    minimumCash: min != null && min > 0 ? min : null,
  };
}

export const QUICK_PROMPTS = [
  '¿Me alcanza para la nómina de diciembre?',
  '¿Y si Nexa paga 30 días tarde?',
  'Agrega el margen por cliente',
] as const;

/**
 * Lo que Cortex necesita saber para contestar desde Finanzas, en una línea,
 * pegado debajo de la pregunta. Nada que la persona no vea ya en la pantalla.
 */
export function financeContext(d: FinanceDashboard): string {
  const parts: string[] = ['Contexto: lo pregunto desde el panel de Finanzas'];
  if (d.cash.ok) parts.push(`caja hoy ${formatMoney(d.cash.data.total, d.cash.data.currency)}`);
  if (d.forecast.ok) {
    const f = d.forecast.data;
    const low = (f.scenario ?? f.base).lowest;
    parts.push(
      `semana más baja de las 13: la del ${formatDay(low.week)} con ${formatMoney(low.closing, f.currency)}`,
    );
    if (f.scenario?.scenario) parts.push(`escenario abierto «${f.scenario.scenario.label}»`);
  }
  if (d.includeEstimatedSales) parts.push('incluyendo ventas estimadas');
  return `${parts.join('; ')}.`;
}

export function promptWithContext(question: string, context: string): string {
  const q = question.trim();
  return context ? `${q}\n\n${context}` : q;
}
