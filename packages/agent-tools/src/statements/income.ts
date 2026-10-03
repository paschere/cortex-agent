import type { PnlMonth } from '../ledger/plans';
import { round2 } from '../ledger/shape';
import { type CategoryClasses, type ExpenseClass, classOf, expenseCategoryLabel } from './classify';

/**
 * EL ESTADO DE RESULTADOS, DESDE EL LIBRO DE PLATA (0191). Puro.
 *
 * Base CAJA: lo que entró y salió de verdad (`monthlyPnl`), sin causación ni
 * depreciaciones. Es lo que una pyme sin contador al día puede tener hoy, y se
 * rotula así en todas partes («de caja»). Cuando el programa contable está
 * conectado, la pantalla pone al lado su estado de resultados contable.
 *
 * Cada renglón dice de dónde sale (`source`): la respuesta a «¿y este número
 * de dónde lo sacaste?» tiene que estar escrita, no adivinada.
 */

export const INCOME_LINES = [
  'ingresos',
  'costo',
  'utilidad_bruta',
  'gastos_variables',
  'gastos_fijos',
  'utilidad_operacional',
  'otros_ingresos',
  'gastos_financieros',
  'impuestos',
  'utilidad_neta',
] as const;
export type IncomeLineKey = (typeof INCOME_LINES)[number];

export type IncomeValues = Record<IncomeLineKey, number>;

export interface IncomeLineMeta {
  key: IncomeLineKey;
  label: string;
  subtotal: boolean;
  /** Si resta (se pinta entre paréntesis en el formato contable). */
  negative: boolean;
  source: string;
}

export const INCOME_LINE_META: readonly IncomeLineMeta[] = [
  {
    key: 'ingresos',
    label: 'Ingresos operacionales (ventas)',
    subtotal: false,
    negative: false,
    source:
      'Ingresos ya recibidos del libro con categoría «Ventas» o sin categoría (casi siempre abonos de clientes), menos devoluciones.',
  },
  {
    key: 'costo',
    label: 'Costo de ventas',
    subtotal: false,
    negative: true,
    source:
      'Gastos pagados de las categorías clasificadas como «Costo de ventas» (por defecto, Proveedores).',
  },
  {
    key: 'utilidad_bruta',
    label: 'Utilidad bruta',
    subtotal: true,
    negative: false,
    source: 'Ingresos operacionales − costo de ventas.',
  },
  {
    key: 'gastos_variables',
    label: 'Gastos variables',
    subtotal: false,
    negative: true,
    source:
      'Gastos pagados de las categorías clasificadas como variables (por defecto, Transporte y fletes).',
  },
  {
    key: 'gastos_fijos',
    label: 'Gastos fijos de operación',
    subtotal: false,
    negative: true,
    source:
      'Gastos pagados de las categorías clasificadas como fijas: nómina, arriendo, servicios, software, honorarios, mercadeo y lo que no tiene categoría.',
  },
  {
    key: 'utilidad_operacional',
    label: 'Utilidad operacional (EBITDA aproximado)',
    subtotal: true,
    negative: false,
    source:
      'Utilidad bruta − gastos variables − gastos fijos. Es de caja: no descuenta depreciaciones ni amortizaciones, por eso se lee como EBITDA aproximado.',
  },
  {
    key: 'otros_ingresos',
    label: 'Otros ingresos',
    subtotal: false,
    negative: false,
    source:
      'Ingresos recibidos con otra categoría distinta de Ventas (rendimientos, reintegros, ventas de activos).',
  },
  {
    key: 'gastos_financieros',
    label: 'Gastos financieros',
    subtotal: false,
    negative: true,
    source:
      'Gastos pagados de la categoría «Bancos y financieros» (intereses, comisiones, 4x1000).',
  },
  {
    key: 'impuestos',
    label: 'Impuestos pagados',
    subtotal: false,
    negative: true,
    source:
      'Gastos pagados de la categoría «Impuestos» (IVA, retenciones, renta, ICA que salieron del banco).',
  },
  {
    key: 'utilidad_neta',
    label: 'Utilidad neta (de caja)',
    subtotal: true,
    negative: false,
    source: 'Todo lo que entró − todo lo que salió en el período, sin traslados entre tus cuentas.',
  },
];

export const emptyValues = (): IncomeValues =>
  Object.fromEntries(INCOME_LINES.map((k) => [k, 0])) as IncomeValues;

/** Un mes del libro → los renglones del estado de resultados. */
export function incomeValues(m: PnlMonth, classes: CategoryClasses): IncomeValues {
  const byClass: Record<ExpenseClass, number> = {
    costo: 0,
    variable: 0,
    fijo: 0,
    financiero: 0,
    impuestos: 0,
  };
  for (const [cat, v] of Object.entries(m.byCategory)) byClass[classOf(cat, classes)] += v;
  const ingresos = m.sales;
  const bruta = ingresos - byClass.costo;
  const operacional = bruta - byClass.variable - byClass.fijo;
  const neta = operacional + m.otherIncome - byClass.financiero - byClass.impuestos;
  return {
    ingresos: round2(ingresos),
    costo: round2(byClass.costo),
    utilidad_bruta: round2(bruta),
    gastos_variables: round2(byClass.variable),
    gastos_fijos: round2(byClass.fijo),
    utilidad_operacional: round2(operacional),
    otros_ingresos: round2(m.otherIncome),
    gastos_financieros: round2(byClass.financiero),
    impuestos: round2(byClass.impuestos),
    utilidad_neta: round2(neta),
  };
}

export function addValues(a: IncomeValues, b: IncomeValues): IncomeValues {
  const out = emptyValues();
  for (const k of INCOME_LINES) out[k] = round2(a[k] + b[k]);
  return out;
}

export interface CategoryDetail {
  category: string;
  label: string;
  cls: ExpenseClass;
  ytd: number;
  ytdPrev: number | null;
}

export interface IncomeStatement {
  basis: 'caja';
  currency: string;
  year: number;
  /** El último mes que entra (1–12). */
  throughMonth: number;
  /** El mes `throughMonth` va en curso (hoy está dentro de él). */
  partialMonth: boolean;
  months: Array<{ month: string; values: IncomeValues; hasData: boolean }>;
  /** Del 1 de enero al cierre de `throughMonth`. */
  ytd: IncomeValues;
  /** Los mismos meses del año anterior, si hay datos de ese año. */
  ytdPrev: IncomeValues | null;
  /** El mes `throughMonth` y el mismo mes del año anterior. */
  month: IncomeValues;
  monthPrevYear: IncomeValues | null;
  /** El mes anterior a `throughMonth`. */
  monthPrev: IncomeValues | null;
  categories: CategoryDetail[];
  /** Hay nómina doblada como un solo total (quien mira no administra). */
  payrollConfidential: boolean;
}

const hasData = (m: PnlMonth | undefined) =>
  Boolean(m && (m.sales !== 0 || m.otherIncome !== 0 || m.expenses !== 0));

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * El estado de resultados de `year` hasta `throughMonth`, con el año anterior
 * al lado. `history` son los meses del libro (`monthlyPnl`, idealmente 24).
 */
export function incomeStatement(
  history: PnlMonth[],
  opts: {
    year: number;
    throughMonth: number;
    classes: CategoryClasses;
    currency?: string;
    today: string;
  },
): IncomeStatement {
  const byMonth = new Map(history.map((m) => [m.month, m]));
  const key = (y: number, m: number) => `${y}-${pad(m)}`;
  const months = [];
  let ytd = emptyValues();
  let prev = emptyValues();
  let prevHas = false;
  const catYtd = new Map<string, number>();
  const catPrev = new Map<string, number>();
  for (let m = 1; m <= opts.throughMonth; m++) {
    const cur = byMonth.get(key(opts.year, m));
    const values = cur ? incomeValues(cur, opts.classes) : emptyValues();
    months.push({ month: key(opts.year, m), values, hasData: hasData(cur) });
    ytd = addValues(ytd, values);
    for (const [c, v] of Object.entries(cur?.byCategory ?? {}))
      catYtd.set(c, (catYtd.get(c) ?? 0) + v);
    const old = byMonth.get(key(opts.year - 1, m));
    if (hasData(old)) prevHas = true;
    if (old) {
      prev = addValues(prev, incomeValues(old, opts.classes));
      for (const [c, v] of Object.entries(old.byCategory))
        catPrev.set(c, (catPrev.get(c) ?? 0) + v);
    }
  }
  const at = (y: number, m: number) => {
    const row = byMonth.get(key(y, m));
    return hasData(row) && row ? incomeValues(row, opts.classes) : null;
  };
  const prevMonthKey =
    opts.throughMonth === 1 ? [opts.year - 1, 12] : [opts.year, opts.throughMonth - 1];
  const categories: CategoryDetail[] = [...new Set([...catYtd.keys(), ...catPrev.keys()])]
    .map((category) => ({
      category,
      label: expenseCategoryLabel(category),
      cls: classOf(category, opts.classes),
      ytd: round2(catYtd.get(category) ?? 0),
      ytdPrev: prevHas ? round2(catPrev.get(category) ?? 0) : null,
    }))
    .filter((c) => c.ytd !== 0 || (c.ytdPrev ?? 0) !== 0)
    .sort((a, b) => b.ytd - a.ytd);
  const throughKey = key(opts.year, opts.throughMonth);
  return {
    basis: 'caja',
    currency: opts.currency ?? 'COP',
    year: opts.year,
    throughMonth: opts.throughMonth,
    partialMonth: opts.today.slice(0, 7) === throughKey,
    months,
    ytd,
    ytdPrev: prevHas ? prev : null,
    month: months[months.length - 1]?.values ?? emptyValues(),
    monthPrevYear: at(opts.year - 1, opts.throughMonth),
    monthPrev: at(prevMonthKey[0] as number, prevMonthKey[1] as number),
    categories,
    payrollConfidential: [...catYtd.keys(), ...catPrev.keys()].some(
      (c) => c === 'nomina (confidencial)',
    ),
  };
}

/** Cambio relativo; `null` si no hay base con qué comparar. */
export function pctChange(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || Math.abs(before) < 0.5) return null;
  return (now - before) / Math.abs(before);
}
