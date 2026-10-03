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
