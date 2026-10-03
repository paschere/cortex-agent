import type { BudgetVsActual } from '../budget/shape';
import { budgetOverruns } from '../budget/shape';
import { formatMoney } from '../ledger/forecast-shared';
import type { IncomeStatement } from '../statements/income';
import { pctChange } from '../statements/income';
import type { Indicator } from '../statements/indicators';
import { pctText } from '../statements/indicators';
import {
  BOARD_SECTION_TITLE,
  type BoardFact,
  type BoardSection,
  type BoardSectionKey,
  periodLabel,
} from './shape';

/**
 * EL INFORME PARA SOCIOS, ARMADO CON LOS DATOS (0191). Puro.
 *
 * Todas las secciones salen de aquí, escritas por reglas con las cifras ya
 * calculadas (estados financieros, presupuesto, caja, cartera, Gerencia,
 * vencimientos). El modelo sólo redacta el resumen de cinco líneas, con
 * estas mismas cifras (`facts`); si no puede, `fallbackSummary` lo dice igual
 * de cierto y menos elegante.
 */

export interface BoardInput {
  period: string;
  company: string;
  today: string;
  income: IncomeStatement | null;
  budget: { name: string; approved: boolean; vs: BudgetVsActual } | null;
  cash: {
    total: number | null;
    asOf: string;
    lowestWeek: string | null;
    lowestClosing: number | null;
    endClosing: number | null;
    weeks: number;
    alerts: Array<{ severity: 'info' | 'warn' | 'critical'; message: string }>;
  } | null;
  working: {
    receivables: { total: number; count: number; overdue: number } | null;
    payables: { total: number; count: number; overdue: number } | null;
  };
  indicators: Indicator[] | null;
  balanceBasis: 'contable' | 'aproximado' | null;
  milestones: Array<{ title: string; evidence: string | null }>;
  decisions: Array<{ question: string; resolved: string | null }>;
  obligations: Array<{ title: string; dueOn: string; overdue: boolean; amount: number | null }>;
  gaps: string[];
}

export interface Composed {
  facts: BoardFact[];
  sections: BoardSection[];
  fallbackSummary: string[];
  nextSteps: string[];
}

const SHORT_MONTH = [
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
/** Cierra la frase sin duplicar el signo («¿…?» no lleva punto). */
const stop = (t: string) => (/[.?!…]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
const dayText = (d: string) =>
  `${Number(d.slice(8, 10))} ${SHORT_MONTH[Number(d.slice(5, 7)) - 1]}`;

export function composeBoard(input: BoardInput): Composed {
  const facts: BoardFact[] = [];
  const fm = (n: number) => formatMoney(n);
  const fact = (key: string, label: string, value: number | null, display?: string) => {
    const f = { key, label, value, display: display ?? (value === null ? '—' : fm(value)) };
    facts.push(f);
    return f.display;
  };
  const change = (key: string, label: string, now: number, before: number | null | undefined) => {
    const c = pctChange(now, before);
    if (c === null) return null;
    return fact(key, label, c * 100, `${c > 0 ? '+' : ''}${pctText(c)}`);
  };
  const year = Number(input.period.slice(0, 4));
  const month = Number(input.period.slice(5, 7));
  const mName = periodLabel(input.period).split(' de ')[0] ?? '';
  const sections: BoardSection[] = [];
  const add = (key: BoardSectionKey, lines: string[], table?: BoardSection['table']) =>
    sections.push({ key, title: BOARD_SECTION_TITLE[key], lines, table: table ?? null });
  const summary: string[] = [];
  const next: string[] = [];

  add('resumen', []);

  // --- Resultados ----------------------------------------------------------
  const res: string[] = [];
  let table: BoardSection['table'] = null;
  const inc = input.income;
  if (inc) {
    const ventas = fact('ventas_mes', `Ventas de ${mName}`, inc.month.ingresos);
    const ventasPrev = inc.monthPrevYear
      ? fact(
          'ventas_mes_anio_anterior',
          `Ventas de ${mName} de ${year - 1}`,
          inc.monthPrevYear.ingresos,
        )
      : null;
    const ventasCambio = change(
      'ventas_mes_cambio',
      `Cambio de las ventas de ${mName} frente a ${year - 1}`,
      inc.month.ingresos,
      inc.monthPrevYear?.ingresos,
    );
    const neta = fact('utilidad_neta_mes', `Resultado neto de ${mName}`, inc.month.utilidad_neta);
    const operacional = fact(
      'utilidad_operacional_mes',
      `Utilidad operacional de ${mName}`,
      inc.month.utilidad_operacional,
    );
    const ventasYtd = fact('ventas_ytd', `Ventas de enero a ${mName}`, inc.ytd.ingresos);
    const netaYtd = fact(
      'utilidad_neta_ytd',
      `Resultado neto de enero a ${mName}`,
      inc.ytd.utilidad_neta,
    );
    const ytdPrev = inc.ytdPrev
      ? fact(
          'ventas_ytd_anio_anterior',
          `Ventas de enero a ${mName} de ${year - 1}`,
          inc.ytdPrev.ingresos,
        )
      : null;
    const ytdCambio = change(
      'ventas_ytd_cambio',
      'Cambio de las ventas del año frente al anterior',
      inc.ytd.ingresos,
      inc.ytdPrev?.ingresos,
    );
    res.push(
      `Ventas de ${mName}: ${ventas}${ventasPrev ? ` (en ${mName} de ${year - 1}: ${ventasPrev}${ventasCambio ? `, ${ventasCambio}` : ''})` : ''}. Utilidad operacional ${operacional}; resultado neto ${neta}.`,
      `En el año: ventas ${ventasYtd}${ytdPrev ? ` contra ${ytdPrev} a la misma altura de ${year - 1}${ytdCambio ? ` (${ytdCambio})` : ''}` : ''}; resultado neto ${netaYtd}.`,
      'Cifras de caja (lo que entró y salió del banco), sin causación ni depreciaciones.',
    );
    summary.push(
      `En ${mName} las ventas fueron ${ventas}${ventasCambio ? ` (${ventasCambio} frente a ${mName} de ${year - 1})` : ''} y el resultado neto ${neta}.`,
      `En lo que va del año las ventas suman ${ventasYtd}${ytdCambio ? ` (${ytdCambio} frente al año anterior)` : ''} y el resultado ${netaYtd}.`,
    );
    if (inc.month.utilidad_neta < 0)
      next.push(`Revisar por qué ${mName} cerró con resultado negativo (${neta}).`);
  } else res.push('No se pudo leer el estado de resultados.');

  const b = input.budget;
  if (b) {
    const t = b.vs.totals;
    const incomePct = t.income.budget > 0.5 ? t.income.actual / t.income.budget : null;
    const expensePct = t.expense.budget > 0.5 ? t.expense.actual / t.expense.budget : null;
    const iP =
      incomePct !== null
        ? fact(
            'presupuesto_ingresos_pct',
            'Cumplimiento del presupuesto de ingresos',
            incomePct * 100,
            pctText(incomePct),
          )
        : null;
    const eP =
      expensePct !== null
        ? fact(
            'presupuesto_gastos_pct',
            'Ejecución del presupuesto de gastos',
            expensePct * 100,
            pctText(expensePct),
          )
        : null;
    const iB = fact('presupuesto_ingresos', 'Ingresos presupuestados a la fecha', t.income.budget);
    const iA = fact('real_ingresos', 'Ingresos reales a la fecha', t.income.actual);
    const eB = fact('presupuesto_gastos', 'Gastos presupuestados a la fecha', t.expense.budget);
    const eA = fact('real_gastos', 'Gastos reales a la fecha', t.expense.actual);
    res.push(
      `Contra el presupuesto${b.approved ? '' : ' (borrador, no aprobado)'} de enero a ${mName}: ingresos ${iA} de ${iB}${iP ? ` (${iP})` : ''}; gastos ${eA} de ${eB}${eP ? ` (${eP})` : ''}.`,
    );
    summary.push(
      `Contra el presupuesto, los ingresos del año van en ${iP ?? iA} y los gastos en ${eP ?? eA}.`,
    );
    table = {
      columns: [
        'Categoría',
        `Presupuesto ${mName}`,
        `Real ${mName}`,
        'Presupuesto año a la fecha',
        'Real año a la fecha',
      ],
      numeric: [1, 2, 3, 4],
      rows: b.vs.rows.slice(0, 12).map((r) => {
        const cell = r.months[month - 1];
        return [
          r.label,
          fm(cell?.budgetToDate ?? 0),
          cell?.actual === null || cell?.actual === undefined ? '—' : fm(cell.actual),
          fm(r.ytd.budget),
          fm(r.ytd.actual),
        ];
      }),
    };
    for (const r of b.vs.rows.slice(0, 12)) {
      const cell = r.months[month - 1];
      fact(
        `presupuesto.${r.category}.mes`,
        `${r.label}: presupuesto de ${mName}`,
        cell?.budgetToDate ?? 0,
      );
      if (cell?.actual !== null && cell?.actual !== undefined)
        fact(`presupuesto.${r.category}.real`, `${r.label}: real de ${mName}`, cell.actual);
      fact(
        `presupuesto.${r.category}.ytd`,
        `${r.label}: presupuesto del año a la fecha`,
        r.ytd.budget,
      );
      fact(
        `presupuesto.${r.category}.ytd_real`,
        `${r.label}: real del año a la fecha`,
        r.ytd.actual,
      );
    }
    for (const o of budgetOverruns(b.vs).slice(0, 2)) {
      const over = fact(`sobrecosto.${o.category}`, `${o.label}: sobre el presupuesto`, o.over);
      next.push(`Revisar ${o.label.toLowerCase()}: va ${over} por encima de lo presupuestado.`);
    }
  } else {
    res.push(`No hay presupuesto para ${year}: se arma en /presupuesto para poder comparar.`);
    summary.push(`No hay presupuesto de ${year} con qué comparar los resultados.`);
  }
  add('resultados', res, table);

  // --- Caja -------------------------------------------------------------------
  const cashLines: string[] = [];
  const c = input.cash;
  if (c && c.total !== null) {
    const now = fact('caja_hoy', 'Caja hoy', c.total);
    const low =
      c.lowestClosing !== null && c.lowestWeek
        ? fact(
            'caja_minima',
            `Caja más baja en ${c.weeks} semanas (semana del ${dayText(c.lowestWeek)})`,
            c.lowestClosing,
          )
        : null;
    const end =
      c.endClosing !== null
        ? fact('caja_final', `Caja proyectada en ${c.weeks} semanas`, c.endClosing)
        : null;
    cashLines.push(
      `Caja al ${dayText(c.asOf)}: ${now}.`,
      ...(low
        ? [
            `Lo más bajo de las próximas ${c.weeks} semanas: ${low}, la semana del ${dayText(c.lowestWeek as string)}.`,
          ]
        : []),
      ...(end ? [`Al cabo de ${c.weeks} semanas quedaría en ${end}.`] : []),
      ...c.alerts
        .filter((a) => a.severity !== 'info')
        .slice(0, 3)
        .map((a) => a.message),
    );
    summary.push(
      `La caja está en ${now}${low ? `; lo más bajo de las próximas ${c.weeks} semanas es ${low}, la semana del ${dayText(c.lowestWeek as string)}` : ''}.`,
    );
    if (c.lowestClosing !== null && c.lowestClosing < 0)
      next.push(
        `Conseguir caja antes de la semana del ${dayText(c.lowestWeek as string)}: la proyección queda en ${low}.`,
      );
  } else cashLines.push('No se pudo leer la caja ni su proyección.');
  add('caja', cashLines);

  // --- Cartera y por pagar -------------------------------------------------
  const w = input.working;
  const wLines: string[] = [];
  if (w.receivables) {
    const tot = fact('cartera_total', 'Cartera por cobrar', w.receivables.total);
    const ov = fact('cartera_vencida', 'Cartera vencida', w.receivables.overdue);
    wLines.push(
      `Por cobrar: ${tot} en ${w.receivables.count} ${w.receivables.count === 1 ? 'factura' : 'facturas'}, de los que ${ov} ya vencieron.`,
    );
    if (w.receivables.overdue > 0) next.push(`Cobrar la cartera vencida (${ov}).`);
  }
  if (w.payables) {
    const tot = fact('por_pagar_total', 'Cuentas por pagar', w.payables.total);
    const ov = fact('por_pagar_vencido', 'Cuentas por pagar vencidas', w.payables.overdue);
    wLines.push(
      `Por pagar: ${tot} en ${w.payables.count} ${w.payables.count === 1 ? 'factura' : 'facturas'}, de los que ${ov} ya vencieron.`,
    );
  }
  if (w.receivables && w.payables)
    summary.push(
      `Hay ${facts.find((f) => f.key === 'cartera_total')?.display} por cobrar (${facts.find((f) => f.key === 'cartera_vencida')?.display} vencida) y ${facts.find((f) => f.key === 'por_pagar_total')?.display} por pagar.`,
    );
  if (!wLines.length) wLines.push('No se pudo leer la cartera ni las cuentas por pagar.');
  add('cartera', wLines);

  // --- Indicadores -------------------------------------------------------------
  const ind = input.indicators ?? [];
  const keys = [
    'margen_bruto',
    'margen_operacional',
    'margen_neto',
    'razon_corriente',
    'endeudamiento',
    'dias_cartera',
    'dias_inventario',
    'dias_proveedores',
    'ciclo_caja',
    'punto_equilibrio',
    'ebitda',
  ];
  const shown = keys
    .map((k) => ind.find((i) => i.key === k))
    .filter((i): i is Indicator => Boolean(i && i.value !== null));
  for (const i of shown) fact(`indicador.${i.key}`, i.label, i.value, i.display);
  add(
    'indicadores',
    shown.length
      ? [
          `Últimos 12 meses de caja${input.balanceBasis === 'aproximado' ? '; liquidez y endeudamiento con el balance aproximado (sin préstamos, impuestos ni nómina por pagar)' : input.balanceBasis === 'contable' ? '; liquidez y endeudamiento con el balance del programa contable' : ''}.`,
        ]
      : ['No hay con qué calcular los indicadores todavía.'],
    shown.length
      ? {
          columns: ['Indicador', 'Valor', 'Cómo se calcula'],
          numeric: [1],
          rows: shown.map((i) => [i.label, i.display, i.formula]),
        }
      : null,
  );

  // --- Hitos y decisiones ------------------------------------------------------
  const hitos: string[] = [];
  for (const m of input.milestones.slice(0, 8))
    hitos.push(stop(`Cerrado con evidencia: ${m.title}`));
  for (const d of input.decisions.slice(0, 6))
    hitos.push(
      d.resolved
        ? stop(`Decisión: ${d.question} → ${d.resolved}`)
        : stop(`Por decidir: ${d.question}`),
    );
  if (!hitos.length)
    hitos.push('No hubo asuntos de Gerencia cerrados ni decisiones registradas en el mes.');
  fact(
    'hitos',
    'Asuntos cerrados con evidencia en el mes',
    input.milestones.length,
    String(input.milestones.length),
  );
  const pending = input.decisions.filter((d) => !d.resolved);
  for (const d of pending.slice(0, 2)) next.push(stop(`Decidir: ${d.question}`));
  add('hitos', hitos);

  // --- Riesgos -----------------------------------------------------------------
  const risks: string[] = [];
  for (const a of (c?.alerts ?? []).filter((x) => x.severity === 'critical').slice(0, 2))
    risks.push(a.message);
  if (
    w.receivables &&
    w.receivables.total > 0.5 &&
    w.receivables.overdue / w.receivables.total > 0.3
  )
    risks.push(
      `Más del 30 % de la cartera está vencida (${facts.find((f) => f.key === 'cartera_vencida')?.display}).`,
    );
  if (b)
    for (const o of budgetOverruns(b.vs).slice(0, 3))
      risks.push(`${o.label} por encima del presupuesto.`);
  const overdueOb = input.obligations.filter((o) => o.overdue);
  const soon = input.obligations.filter((o) => !o.overdue);
  if (overdueOb.length) {
    fact(
      'vencidos',
      'Vencimientos ya pasados sin cumplir',
      overdueOb.length,
      String(overdueOb.length),
    );
    risks.push(
      `${overdueOb.length} ${overdueOb.length === 1 ? 'vencimiento pasó' : 'vencimientos pasaron'} sin cumplirse: ${overdueOb
        .slice(0, 3)
        .map((o) => o.title)
        .join('; ')}.`,
    );
  }
  if (soon.length) {
    fact('por_vencer', 'Vencimientos en los próximos 30 días', soon.length, String(soon.length));
    risks.push(
      `Vencen en los próximos 30 días: ${soon
        .slice(0, 5)
        .map((o) => `${o.title} (${dayText(o.dueOn)})`)
        .join('; ')}.`,
    );
    next.push(
      `Atender ${soon.length === 1 ? 'el vencimiento' : `los ${soon.length} vencimientos`} de los próximos 30 días.`,
    );
  }
  if (!risks.length)
    risks.push('No hay alertas de caja, de cartera, de presupuesto ni vencimientos próximos.');
  add('riesgos', risks);

  // --- Próximos pasos ------------------------------------------------------------
  const steps = [...new Set(next)].slice(0, 5);
  add(
    'proximos',
    steps.length
      ? steps
      : ['Mantener el seguimiento mensual: no hay pendientes urgentes en los datos.'],
  );

  if (summary.length < 5 && steps[0])
    summary.push(`Lo primero: ${steps[0].charAt(0).toLowerCase()}${steps[0].slice(1)}`);
  while (summary.length < 5 && input.gaps.length) {
    summary.push(`No se pudo leer ${input.gaps.join(', ')}: esas cifras no están en el informe.`);
    break;
  }
  return { facts, sections, fallbackSummary: summary.slice(0, 5), nextSteps: steps };
}
