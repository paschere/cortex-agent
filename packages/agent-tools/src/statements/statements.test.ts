import { describe, expect, it } from 'vitest';
import type { PnlMonth } from '../ledger/plans';
import { approximateBalance, balanceFromProvider } from './balance';
import { DEFAULT_CLASSES, classOf, mergeClasses } from './classify';
import { incomeStatement, incomeValues } from './income';
import { computeIndicators } from './indicators';

const month = (
  m: string,
  sales: number,
  byCategory: Record<string, number>,
  otherIncome = 0,
): PnlMonth => {
  const expenses = Object.values(byCategory).reduce((s, v) => s + v, 0);
  return {
    month: m,
    sales,
    otherIncome,
    expenses,
    byCategory,
    margin: sales + otherIncome - expenses,
  };
};

const classes = mergeClasses(null);

describe('classification', () => {
  it('has sensible defaults and accepts overrides', () => {
    expect(classOf('proveedores', classes)).toBe('costo');
    expect(classOf('nomina', classes)).toBe('fijo');
    expect(classOf('nomina (confidencial)', classes)).toBe('fijo');
    expect(classOf('categoria_nueva', classes)).toBe('fijo');
    const custom = mergeClasses({ mercadeo: 'variable', arriendo: 'nope' });
    expect(custom.mercadeo).toBe('variable');
    expect(custom.arriendo).toBe(DEFAULT_CLASSES.arriendo);
  });
});

describe('income statement (cash)', () => {
  const m = month(
    '2026-09',
    10_000,
    {
      proveedores: 4_000,
      transporte: 500,
      nomina: 2_000,
      arriendo: 1_000,
      bancos_y_financieros: 100,
      impuestos: 400,
    },
    300,
  );

  it('splits the month into the statement lines and ties to the margin', () => {
    const v = incomeValues(m, classes);
    expect(v.utilidad_bruta).toBe(6_000);
    expect(v.gastos_variables).toBe(500);
    expect(v.gastos_fijos).toBe(3_000);
    expect(v.utilidad_operacional).toBe(2_500);
    expect(v.utilidad_neta).toBe(m.margin);
  });

  it('computes YTD against the same months of the previous year', () => {
    const history = [
      month('2025-08', 5_000, { proveedores: 2_000 }),
      month('2025-09', 6_000, { proveedores: 2_500 }),
      month('2026-08', 8_000, { proveedores: 3_000 }),
      m,
    ];
    const s = incomeStatement(history, {
      year: 2026,
      throughMonth: 9,
      classes,
      today: '2026-10-03',
    });
    expect(s.months).toHaveLength(9);
    expect(s.ytd.ingresos).toBe(18_000);
    expect(s.ytdPrev?.ingresos).toBe(11_000);
    expect(s.month.ingresos).toBe(10_000);
    expect(s.monthPrevYear?.ingresos).toBe(6_000);
    expect(s.monthPrev?.ingresos).toBe(8_000);
    expect(s.partialMonth).toBe(false);
    expect(s.categories[0]).toMatchObject({
      category: 'proveedores',
      cls: 'costo',
      ytd: 7_000,
      ytdPrev: 4_500,
    });
  });

  it('has no previous-year comparison without data', () => {
    const s = incomeStatement([m], { year: 2026, throughMonth: 10, classes, today: '2026-10-03' });
    expect(s.ytdPrev).toBeNull();
    expect(s.monthPrevYear).toBeNull();
    expect(s.partialMonth).toBe(true);
  });
});

describe('approximate balance', () => {
  it('states what it knows and what it does not', () => {
    const b = approximateBalance({
      asOf: '2026-10-03',
      currency: 'COP',
      cash: { total: 5_000, accounts: 2, oldestDays: 12 },
      receivables: { total: 3_000, count: 4 },
      inventory: null,
      payables: { total: 2_000, count: 3 },
    });
    expect(b.basis).toBe('aproximado');
    expect(b.totalAssets).toBe(8_000);
    expect(b.totalLiabilities).toBe(2_000);
    expect(b.equity).toBe(6_000);
    expect(b.missing.some((x) => /Inventario/.test(x))).toBe(true);
    expect(b.missing.some((x) => /Activos fijos/.test(x))).toBe(true);
    expect(b.notes[0]).toMatch(/12 días/);
    expect(b.lines.every((l) => l.source.length > 10)).toBe(true);
  });

  it('labels a provider balance as contable', () => {
    const b = balanceFromProvider(
      {
        provider: 'siigo',
        asOf: '2026-09-30',
        currency: 'COP',
        totalAssets: 10,
        currentAssets: 6,
        nonCurrentAssets: 4,
        totalLiabilities: 3,
        currentLiabilities: 2,
        nonCurrentLiabilities: 1,
        equity: 7,
        lines: [{ section: 'activo_corriente', code: '11', name: 'Disponible', amount: 6 }],
        notes: [],
      },
      '2026-10-01T00:00:00Z',
    );
    expect(b.basis).toBe('contable');
    expect(b.lines[0]?.label).toBe('11 · Disponible');
    expect(b.lines[0]?.source).toMatch(/Siigo/);
  });
});

describe('indicators', () => {
  const base = {
    currency: 'COP',
    periodLabel: 'últimos 12 meses',
    months: 12,
    pnlSource: 'Libro',
    revenue: 120_000_000,
    costOfSales: 60_000_000,
    variableExpenses: 12_000_000,
    fixedExpenses: 36_000_000,
    operatingIncome: 12_000_000,
    netIncome: 9_000_000,
    invoiced: 120_000_000,
    purchases: 72_000_000,
    balance: {
      basis: 'aproximado' as const,
      source: 'aprox',
      currentAssets: 40_000_000,
      currentLiabilities: 20_000_000,
      totalAssets: 40_000_000,
      totalLiabilities: 20_000_000,
    },
    receivables: { amount: 20_000_000, source: 'cartera' },
    inventory: { amount: 10_000_000, source: 'inv' },
    payables: { amount: 12_000_000, source: 'cxp' },
  };
  const by = (list: ReturnType<typeof computeIndicators>) =>
    Object.fromEntries(list.map((i) => [i.key, i]));

  it('computes margins, liquidity, days and break-even with their inputs', () => {
    const i = by(computeIndicators(base));
    expect(i.margen_bruto?.value).toBeCloseTo(0.5);
    expect(i.margen_operacional?.value).toBeCloseTo(0.1);
    expect(i.margen_neto?.value).toBeCloseTo(0.075);
    expect(i.razon_corriente?.value).toBeCloseTo(2);
    expect(i.razon_corriente?.status).toBe('bien');
    expect(i.endeudamiento?.value).toBeCloseTo(0.5);
    expect(i.dias_cartera?.value).toBeCloseTo(60.8, 0);
    expect(i.dias_inventario?.value).toBeCloseTo(60.8, 0);
    expect(i.dias_proveedores?.value).toBeCloseTo(60.8, 0);
    expect(i.ciclo_caja?.value).toBeCloseTo(60.8, 0);
    // Margen de contribución 40 %; fijos 3 M al mes → equilibrio 7,5 M al mes.
    expect(i.margen_contribucion?.value).toBeCloseTo(0.4);
    expect(i.punto_equilibrio?.value).toBeCloseTo(7_500_000);
    expect(i.punto_equilibrio?.status).toBe('bien');
    expect(i.ebitda?.value).toBe(12_000_000);
    expect(i.razon_corriente?.inputs.map((x) => x.label)).toEqual([
      'Activo corriente',
      'Pasivo corriente',
    ]);
    expect(i.margen_bruto?.display).toBe('50 %');
  });

  it('says why when it cannot compute', () => {
    const i = by(
      computeIndicators({
        ...base,
        revenue: 0,
        invoiced: null,
        inventory: null,
        balance: null,
        receivables: null,
      }),
    );
    expect(i.margen_bruto?.value).toBeNull();
    expect(i.margen_bruto?.note).toMatch(/No hay ventas/);
    expect(i.razon_corriente?.value).toBeNull();
    expect(i.dias_inventario?.value).toBeNull();
    expect(i.punto_equilibrio?.value).toBeNull();
    expect(i.punto_equilibrio?.display).toBe('—');
  });
});

import { composeBoard } from '../board/compose';
import { budgetVsActual } from '../budget/shape';
import { headline } from './headline';
import { expensesMissing } from './income';
import { humanReportError } from './report-errors';
import { effectiveMonths } from './store';

const inputsBase = {
  currency: 'COP',
  periodLabel: 'últimos 12 meses',
  months: 12,
  pnlSource: 'Libro de plata.',
  costOfSales: 0,
  variableExpenses: 0,
  fixedExpenses: 0,
  invoiced: null,
  purchases: null,
  balance: null,
  receivables: null,
  inventory: null,
  payables: null,
};

describe('sólo ingresos: no se inventa utilidad', () => {
  const julio = month('2026-07', 115_000_000, {});
  const s = incomeStatement([julio], { year: 2026, throughMonth: 9, classes, today: '2026-10-07' });

  it('marca que faltan los gastos', () => {
    expect(s.expensesMissingYtd).toBe(true);
    expect(s.expensesMissingMonth).toBe(false); // septiembre no tiene ni ingresos
    expect(s.monthsWithoutExpenses).toEqual(['2026-07']);
    expect(expensesMissing(incomeValues(julio, classes))).toBe(true);
  });

  it('las tarjetas no afirman utilidad ni margen del 100 %', () => {
    const h = headline(s, { pnl: null, pnlPrev: null }, null);
    expect(h.basis).toBe('caja');
    expect(h.sales.now).toBe(115_000_000);
    expect(h.operating.now).toBeNull();
    expect(h.net.now).toBeNull();
    expect(h.netMargin).toBeNull();
    expect(h.missingExpenses).toBe(true);
    expect(h.prevNote).toMatch(/Sin datos de 2025/);
  });

  it('los indicadores de utilidad salen sin calcular y dicen qué falta', () => {
    const v = incomeValues(julio, classes);
    const ind = computeIndicators({
      ...inputsBase,
      revenue: v.ingresos,
      operatingIncome: v.utilidad_operacional,
      netIncome: v.utilidad_neta,
      expensesMissing: true,
    });
    for (const k of [
      'margen_bruto',
      'margen_operacional',
      'margen_neto',
      'ebitda',
      'punto_equilibrio',
    ]) {
      const i = ind.find((x) => x.key === k);
      expect(i?.value, k).toBeNull();
      expect(i?.note, k).toMatch(/gasto/i);
    }
  });

  it('con gastos los márgenes sí se calculan', () => {
    const v = incomeValues(month('2026-07', 1000, { proveedores: 400, nomina: 100 }), classes);
    const ind = computeIndicators({
      ...inputsBase,
      revenue: v.ingresos,
      costOfSales: v.costo,
      fixedExpenses: v.gastos_fijos,
      operatingIncome: v.utilidad_operacional,
      netIncome: v.utilidad_neta,
      expensesMissing: false,
    });
    expect(ind.find((x) => x.key === 'margen_neto')?.value).toBeCloseTo(0.5);
  });

  it('el informe para socios dice que faltan los gastos', () => {
    const c = composeBoard({
      period: '2026-09',
      company: 'X',
      today: '2026-10-07',
      income: { ...s, expensesMissingMonth: true },
      budget: null,
      cash: null,
      working: { receivables: null, payables: null },
      indicators: null,
      balanceBasis: null,
      milestones: [],
      decisions: [],
      obligations: [],
      gaps: [],
    });
    const text = c.sections.flatMap((x) => x.lines).join(' ');
    expect(text).toMatch(/faltan los gastos/i);
    expect(c.facts.find((f) => f.key === 'utilidad_neta_ytd')).toBeUndefined();
    expect(c.facts.find((f) => f.key === 'utilidad_neta_mes')).toBeUndefined();
  });
});

describe('otras combinaciones', () => {
  it('sin datos: nada se marca como faltante', () => {
    const s = incomeStatement([], { year: 2026, throughMonth: 9, classes, today: '2026-10-07' });
    expect(s.expensesMissingYtd).toBe(false);
    const h = headline(s, { pnl: null, pnlPrev: null }, null);
    expect(h.netMargin).toBeNull();
    expect(h.sales.now).toBe(0);
    expect(h.missingExpenses).toBe(false);
  });

  it('sólo egresos: utilidad negativa y sin margen (no hay ventas)', () => {
    const s = incomeStatement([month('2026-03', 0, { nomina: 500 })], {
      year: 2026,
      throughMonth: 9,
      classes,
      today: '2026-10-07',
    });
    const h = headline(s, { pnl: null, pnlPrev: null }, null);
    expect(h.net.now).toBe(-500);
    expect(h.netMargin).toBeNull();
    expect(Number.isNaN(h.netMargin)).toBe(false);
  });

  it('año anterior con pocos meses: avisa que no es comparable', () => {
    const s = incomeStatement(
      [
        month('2025-08', 100, { nomina: 10 }),
        month('2026-01', 200, { nomina: 20 }),
        month('2026-02', 200, { nomina: 20 }),
      ],
      { year: 2026, throughMonth: 9, classes, today: '2026-10-07' },
    );
    expect(s.prevMonthsWithData).toBe(1);
    const h = headline(s, { pnl: null, pnlPrev: null }, null);
    expect(h.prevNote).toMatch(/1 de 9 meses/);
  });

  it('el estado de resultados de Siigo manda sobre el de caja, con su margen', () => {
    const s = incomeStatement([month('2026-07', 115, {})], {
      year: 2026,
      throughMonth: 9,
      classes,
      today: '2026-10-07',
    });
    const pnl = {
      provider: 'siigo' as const,
      from: '2026-01-01',
      to: '2026-09-30',
      currency: 'COP',
      revenue: 1000,
      costOfSales: 400,
      operatingExpenses: 300,
      otherIncome: 0,
      otherExpenses: 50,
      incomeTax: null,
      netIncome: 250,
      lines: [],
      notes: [],
    };
    const h = headline(s, { pnl, pnlPrev: null }, 'Siigo');
    expect(h.basis).toBe('contable');
    expect(h.sales.now).toBe(1000);
    expect(h.operating.now).toBe(300);
    expect(h.net.now).toBe(250);
    expect(h.netMargin).toBeCloseTo(0.25);
    expect(h.missingExpenses).toBe(false);
  });

  it('un estado de Siigo vacío no tapa el libro', () => {
    const s = incomeStatement([month('2026-07', 100, { nomina: 40 })], {
      year: 2026,
      throughMonth: 9,
      classes,
      today: '2026-10-07',
    });
    const empty = {
      provider: 'siigo' as const,
      from: '2026-01-01',
      to: '2026-09-30',
      currency: 'COP',
      revenue: 0,
      costOfSales: 0,
      operatingExpenses: 0,
      otherIncome: 0,
      otherExpenses: 0,
      incomeTax: null,
      netIncome: 0,
      lines: [],
      notes: [],
    };
    expect(headline(s, { pnl: empty, pnlPrev: null }, 'Siigo').basis).toBe('caja');
  });

  it('los 12 meses del indicador cuentan el mes en curso por la fracción transcurrida', () => {
    expect(effectiveMonths(12, '2026-10-15')).toBeCloseTo(11 + 15 / 31, 5);
    expect(effectiveMonths(12, '2026-10-31')).toBe(12);
    expect(effectiveMonths(0, '2026-10-31')).toBe(1);
  });

  it('el presupuesto avisa cuando hay ingresos y ningún gasto real', () => {
    const vs = budgetVsActual(
      [
        { category: 'ventas', kind: 'ingreso', month: 7, amount: 100 },
        { category: 'nomina', kind: 'gasto', month: 7, amount: 50 },
      ],
      [month('2026-07', 100, {})],
      { year: 2026, today: '2026-10-07' },
    );
    expect(vs.totals.expensesMissing).toBe(true);
    const ok = budgetVsActual(
      [{ category: 'nomina', kind: 'gasto', month: 7, amount: 50 }],
      [month('2026-07', 100, { nomina: 40 })],
      { year: 2026, today: '2026-10-07' },
    );
    expect(ok.totals.expensesMissing).toBe(false);
  });
});

describe('errores del programa contable en cristiano', () => {
  const cases: Array<[string, RegExp]> = [
    ["Cannot read properties of undefined (reading 'sheets')", /formato que no esperaba/],
    ['TypeError: x is not a function', /formato que no esperaba/],
    ['fetch failed', /no contestó a tiempo/],
    ['Siigo 401 Unauthorized', /conexión siga vigente/],
    ['HTTP 429 too many requests', /esperar un momento/],
  ];
  for (const [raw, expected] of cases)
    it(`traduce «${raw}»`, () => {
      const h = humanReportError(new Error(raw), 'el balance general', 'Siigo');
      expect(h.message).toMatch(expected);
      expect(h.message).not.toMatch(/undefined|Cannot read|TypeError|sheets/);
      expect(h.detail).toBe(raw);
    });

  it('deja pasar un mensaje en español que ya escribió la integración', () => {
    const h = humanReportError(
      new Error('Siigo no tiene saldos en esa fecha'),
      'el balance general',
      'Siigo',
    );
    expect(h.message).toContain('Siigo no tiene saldos en esa fecha');
    expect(h.technical).toBe(false);
  });
});
