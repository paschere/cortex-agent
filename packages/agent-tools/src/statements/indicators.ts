import { formatMoney } from '../ledger/forecast-shared';

/**
 * LOS INDICADORES FINANCIEROS (0191). Puros y trazables.
 *
 * Cada indicador trae su fórmula en palabras y las cifras que entraron, con
 * su origen: la pantalla tiene un «de dónde sale» por indicador y el chat lo
 * dice igual. Un indicador sin con qué calcularse sale `null` con la razón; no
 * se rellena con un supuesto.
 */

export type IndicatorUnit = 'pct' | 'ratio' | 'days' | 'money';
export type IndicatorStatus = 'bien' | 'atencion' | 'alerta';

export interface IndicatorInput {
  label: string;
  value: number;
  display: string;
  source: string;
}

export interface Indicator {
  key: string;
  label: string;
  group: 'rentabilidad' | 'liquidez' | 'eficiencia' | 'equilibrio';
  value: number | null;
  unit: IndicatorUnit;
  display: string;
  formula: string;
  inputs: IndicatorInput[];
  /** Por qué no se pudo calcular, o una advertencia sobre la cifra. */
  note: string | null;
  status: IndicatorStatus | null;
  /** Qué dirección es buena. */
  goodWhen: 'up' | 'down' | null;
}

export interface IndicatorInputs {
  currency: string;
  /** «últimos 12 meses (de caja)», «enero a septiembre de 2026 (contable)». */
  periodLabel: string;
  /** Meses que cubren las cifras de resultados. */
  months: number;
  pnlSource: string;
  revenue: number;
  costOfSales: number;
  variableExpenses: number;
  fixedExpenses: number;
  operatingIncome: number;
  netIncome: number;
  /** Ventas facturadas del período (cartera); sin dato, las ventas cobradas. */
  invoiced: number | null;
  /** Compras facturadas del período (proveedores); sin dato, costo + variables. */
  purchases: number | null;
  balance: {
    basis: 'contable' | 'aproximado';
    source: string;
    currentAssets: number | null;
    currentLiabilities: number | null;
    totalAssets: number;
    totalLiabilities: number;
  } | null;
  receivables: { amount: number; source: string } | null;
  inventory: { amount: number; source: string } | null;
  payables: { amount: number; source: string } | null;
}

const PCT = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const RATIO = new Intl.NumberFormat('es-CO', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const WHOLE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

export const pctText = (fraction: number) => `${PCT.format(fraction * 100)} %`;
export const ratioText = (n: number) => RATIO.format(n);
export const daysText = (n: number) => `${WHOLE.format(Math.round(n))} días`;

function display(value: number | null, unit: IndicatorUnit, currency: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (unit === 'pct') return pctText(value);
  if (unit === 'ratio') return ratioText(value);
  if (unit === 'days') return daysText(value);
  return formatMoney(value, currency);
}

function make(
  base: Omit<Indicator, 'display' | 'status' | 'goodWhen' | 'note'> & {
    note?: string | null;
    status?: IndicatorStatus | null;
    goodWhen?: 'up' | 'down' | null;
  },
  currency: string,
): Indicator {
  return {
    ...base,
    note: base.note ?? null,
    status: base.value === null ? null : (base.status ?? null),
    goodWhen: base.goodWhen ?? null,
    display: display(base.value, base.unit, currency),
  };
}

export function computeIndicators(i: IndicatorInputs): Indicator[] {
  const c = i.currency;
  const money = (n: number) => formatMoney(n, c);
  const inp = (label: string, value: number, source: string): IndicatorInput => ({
    label,
    value,
    display: money(value),
    source,
  });
  const revenue = inp(`Ventas (${i.periodLabel})`, i.revenue, i.pnlSource);
  const hasRevenue = i.revenue > 0.5;
  const noRevenue = 'No hay ventas en el período: el margen no se puede calcular.';
  const ratio = (num: number) => (hasRevenue ? num / i.revenue : null);
  const days = i.months * (365 / 12);
  const out: Indicator[] = [];

  // --- Rentabilidad ---------------------------------------------------------
  const gross = i.revenue - i.costOfSales;
  out.push(
    make(
      {
        key: 'margen_bruto',
        label: 'Margen bruto',
        group: 'rentabilidad',
        value: ratio(gross),
        unit: 'pct',
        formula: '(Ventas − costo de ventas) ÷ ventas',
        inputs: [revenue, inp('Costo de ventas', i.costOfSales, i.pnlSource)],
        note: hasRevenue ? null : noRevenue,
        status: hasRevenue ? (gross < 0 ? 'alerta' : null) : null,
        goodWhen: 'up',
      },
      c,
    ),
  );
  out.push(
    make(
      {
        key: 'margen_operacional',
        label: 'Margen operacional',
        group: 'rentabilidad',
        value: ratio(i.operatingIncome),
        unit: 'pct',
        formula: 'Utilidad operacional ÷ ventas',
        inputs: [revenue, inp('Utilidad operacional', i.operatingIncome, i.pnlSource)],
        note: hasRevenue ? null : noRevenue,
        status: hasRevenue ? (i.operatingIncome < 0 ? 'alerta' : 'bien') : null,
        goodWhen: 'up',
      },
      c,
    ),
  );
  out.push(
    make(
      {
        key: 'margen_neto',
        label: 'Margen neto',
        group: 'rentabilidad',
        value: ratio(i.netIncome),
        unit: 'pct',
        formula: 'Utilidad neta ÷ ventas',
        inputs: [revenue, inp('Utilidad neta', i.netIncome, i.pnlSource)],
        note: hasRevenue ? null : noRevenue,
        status: hasRevenue ? (i.netIncome < 0 ? 'alerta' : 'bien') : null,
        goodWhen: 'up',
      },
      c,
    ),
  );
  out.push(
    make(
      {
        key: 'ebitda',
        label: 'EBITDA aproximado',
        group: 'rentabilidad',
        value: i.operatingIncome,
        unit: 'money',
        formula:
          'Utilidad operacional antes de gastos financieros e impuestos. Aproximado: no suma depreciaciones porque el libro de caja no las tiene.',
        inputs: [inp('Utilidad operacional', i.operatingIncome, i.pnlSource)],
        status: i.operatingIncome < 0 ? 'alerta' : 'bien',
        goodWhen: 'up',
      },
      c,
    ),
  );

  // --- Liquidez y endeudamiento --------------------------------------------
  const b = i.balance;
  const bNote =
    b?.basis === 'aproximado'
      ? ' Con el balance aproximado (sin préstamos, impuestos ni nómina por pagar).'
      : '';
  const current =
    b && b.currentAssets !== null && b.currentLiabilities !== null && b.currentLiabilities > 0.5
      ? b.currentAssets / b.currentLiabilities
      : null;
  out.push(
    make(
      {
        key: 'razon_corriente',
        label: 'Liquidez (razón corriente)',
        group: 'liquidez',
        value: current,
        unit: 'ratio',
        formula:
          'Activo corriente ÷ pasivo corriente: cuántos pesos hay a la mano por cada peso que se debe a corto plazo.',
        inputs: b
          ? [
              ...(b.currentAssets !== null
                ? [inp('Activo corriente', b.currentAssets, b.source)]
                : []),
              ...(b.currentLiabilities !== null
                ? [inp('Pasivo corriente', b.currentLiabilities, b.source)]
                : []),
            ]
          : [],
        note: !b
          ? 'Sin balance no se puede calcular.'
          : current === null
            ? b.currentLiabilities !== null && b.currentLiabilities <= 0.5
              ? 'No hay pasivo corriente registrado: no hay deuda de corto plazo con qué compararlo.'
              : 'El balance no separa lo corriente de lo no corriente.'
            : bNote.trim() || null,
        status:
          current === null ? null : current >= 1.5 ? 'bien' : current >= 1 ? 'atencion' : 'alerta',
        goodWhen: 'up',
      },
      c,
    ),
  );
  const debt = b && b.totalAssets > 0.5 ? b.totalLiabilities / b.totalAssets : null;
  out.push(
    make(
      {
        key: 'endeudamiento',
        label: 'Endeudamiento',
        group: 'liquidez',
        value: debt,
        unit: 'pct',
        formula: 'Pasivo total ÷ activo total: qué parte de lo que tiene la empresa se debe.',
        inputs: b
          ? [
              inp('Pasivo total', b.totalLiabilities, b.source),
              inp('Activo total', b.totalAssets, b.source),
            ]
          : [],
        note:
          debt === null ? 'Sin activos en el balance no se puede calcular.' : bNote.trim() || null,
        status: debt === null ? null : debt <= 0.6 ? 'bien' : debt <= 0.75 ? 'atencion' : 'alerta',
        goodWhen: 'down',
      },
      c,
    ),
  );

  // --- Eficiencia: días ------------------------------------------------------
  const salesBase = i.invoiced !== null && i.invoiced > 0.5 ? i.invoiced : i.revenue;
  const salesBaseLabel =
    i.invoiced !== null && i.invoiced > 0.5
      ? `Ventas facturadas (${i.periodLabel})`
      : `Ventas cobradas (${i.periodLabel})`;
  const dso = i.receivables && salesBase > 0.5 ? (i.receivables.amount / salesBase) * days : null;
  out.push(
    make(
      {
        key: 'dias_cartera',
        label: 'Rotación de cartera',
        group: 'eficiencia',
        value: dso,
        unit: 'days',
        formula: `Cartera por cobrar ÷ ventas del período × ${Math.round(days)} días: cuánto se demora en promedio en entrar la plata de una venta.`,
        inputs: [
          ...(i.receivables
            ? [inp('Cartera por cobrar', i.receivables.amount, i.receivables.source)]
            : []),
          inp(
            salesBaseLabel,
            salesBase,
            i.invoiced !== null && i.invoiced > 0.5
              ? 'Facturas de venta emitidas en el libro.'
              : i.pnlSource,
          ),
        ],
        note:
          dso === null
            ? 'Faltan la cartera o las ventas del período.'
            : i.invoiced === null || i.invoiced <= 0.5
              ? 'Calculado con las ventas cobradas: no hay facturas de venta en el libro.'
              : null,
        status: dso === null ? null : dso <= 45 ? 'bien' : dso <= 75 ? 'atencion' : 'alerta',
        goodWhen: 'down',
      },
      c,
    ),
  );
  const cogs = i.costOfSales;
  const dio = i.inventory && cogs > 0.5 ? (i.inventory.amount / cogs) * days : null;
  out.push(
    make(
      {
        key: 'dias_inventario',
        label: 'Rotación de inventario',
        group: 'eficiencia',
        value: dio,
        unit: 'days',
        formula: `Inventario ÷ costo de ventas del período × ${Math.round(days)} días: cuántos días de venta hay en la bodega.`,
        inputs: [
          ...(i.inventory ? [inp('Inventario', i.inventory.amount, i.inventory.source)] : []),
          inp('Costo de ventas', cogs, i.pnlSource),
        ],
        note:
          dio === null
            ? i.inventory
              ? 'No hay costo de ventas en el período.'
              : 'No hay inventario valorizado en Cortex.'
            : null,
        goodWhen: 'down',
      },
      c,
    ),
  );
  const purchasesBase =
    i.purchases !== null && i.purchases > 0.5 ? i.purchases : i.costOfSales + i.variableExpenses;
  const dpo = i.payables && purchasesBase > 0.5 ? (i.payables.amount / purchasesBase) * days : null;
  out.push(
    make(
      {
        key: 'dias_proveedores',
        label: 'Rotación de proveedores',
        group: 'eficiencia',
        value: dpo,
        unit: 'days',
        formula: `Cuentas por pagar ÷ compras del período × ${Math.round(days)} días: cuánto se demora la empresa en pagarle a sus proveedores.`,
        inputs: [
          ...(i.payables ? [inp('Cuentas por pagar', i.payables.amount, i.payables.source)] : []),
          inp(
            i.purchases !== null && i.purchases > 0.5
              ? 'Compras facturadas'
              : 'Costo de ventas + gastos variables',
            purchasesBase,
            i.purchases !== null && i.purchases > 0.5
              ? 'Facturas de proveedor emitidas en el libro.'
              : i.pnlSource,
          ),
        ],
        note:
          dpo === null
            ? 'Faltan las cuentas por pagar o las compras del período.'
            : i.purchases === null || i.purchases <= 0.5
              ? 'Calculado con costo + gastos variables: no hay facturas de proveedor en el libro.'
              : null,
        goodWhen: 'up',
      },
      c,
    ),
  );
  const cycle = dso === null && dio === null ? null : (dso ?? 0) + (dio ?? 0) - (dpo ?? 0);
  out.push(
    make(
      {
        key: 'ciclo_caja',
        label: 'Ciclo de caja',
        group: 'eficiencia',
        value: cycle,
        unit: 'days',
        formula:
          'Días de cartera + días de inventario − días de proveedores: cuántos días financia la empresa su propia operación.',
        inputs: [
          ...(dso !== null
            ? [
                {
                  label: 'Días de cartera',
                  value: dso,
                  display: daysText(dso),
                  source: 'Rotación de cartera.',
                },
              ]
            : []),
          ...(dio !== null
            ? [
                {
                  label: 'Días de inventario',
                  value: dio,
                  display: daysText(dio),
                  source: 'Rotación de inventario.',
                },
              ]
            : []),
          ...(dpo !== null
            ? [
                {
                  label: 'Días de proveedores',
                  value: dpo,
                  display: daysText(dpo),
                  source: 'Rotación de proveedores.',
                },
              ]
            : []),
        ],
        note:
          cycle === null
            ? 'Hace falta al menos la rotación de cartera o la de inventario.'
            : [dio === null ? 'sin inventario' : null, dpo === null ? 'sin proveedores' : null]
                .filter(Boolean)
                .join(', ') || null,
        status: cycle === null ? null : cycle <= 30 ? 'bien' : cycle <= 60 ? 'atencion' : 'alerta',
        goodWhen: 'down',
      },
      c,
    ),
  );

  // --- Punto de equilibrio ---------------------------------------------------
  const contribution = hasRevenue ? 1 - (i.costOfSales + i.variableExpenses) / i.revenue : null;
  const monthlyFixed = i.months > 0 ? i.fixedExpenses / i.months : i.fixedExpenses;
  const breakEven =
    contribution !== null && contribution > 0.001 ? monthlyFixed / contribution : null;
  const monthlySales = i.months > 0 ? i.revenue / i.months : i.revenue;
  out.push(
    make(
      {
        key: 'margen_contribucion',
        label: 'Margen de contribución',
        group: 'equilibrio',
        value: contribution,
        unit: 'pct',
        formula:
          '1 − (costo de ventas + gastos variables) ÷ ventas: lo que deja cada peso vendido para cubrir los gastos fijos.',
        inputs: [
          revenue,
          inp('Costo de ventas', i.costOfSales, i.pnlSource),
          inp('Gastos variables', i.variableExpenses, i.pnlSource),
        ],
        note: hasRevenue ? null : noRevenue,
        goodWhen: 'up',
      },
      c,
    ),
  );
  out.push(
    make(
      {
        key: 'punto_equilibrio',
        label: 'Punto de equilibrio (ventas al mes)',
        group: 'equilibrio',
        value: breakEven,
        unit: 'money',
        formula:
          'Gastos fijos del mes promedio ÷ margen de contribución: lo que hay que vender al mes para no perder.',
        inputs: [
          inp('Gastos fijos al mes (promedio)', monthlyFixed, i.pnlSource),
          ...(contribution !== null
            ? [
                {
                  label: 'Margen de contribución',
                  value: contribution,
                  display: pctText(contribution),
                  source: 'Margen de contribución.',
                },
              ]
            : []),
          inp('Ventas al mes (promedio)', monthlySales, i.pnlSource),
        ],
        note:
          breakEven === null
            ? contribution !== null
              ? 'El costo y los gastos variables se comen todas las ventas: no hay punto de equilibrio.'
              : noRevenue
            : 'Depende de qué categorías son fijas y cuáles variables: cámbialo en «Cómo se clasifican los gastos».',
        status:
          breakEven === null
            ? contribution !== null
              ? 'alerta'
              : null
            : monthlySales >= breakEven
              ? 'bien'
              : 'alerta',
        goodWhen: 'down',
      },
      c,
    ),
  );
  return out;
}
