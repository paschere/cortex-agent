import { describe, expect, it } from 'vitest';
import type { PnlMonth } from '../ledger/plans';
import { collectPresupuesto } from './autopilot-collect';
import {
  type BudgetCell,
  actualByCategory,
  budgetFromActuals,
  budgetOverruns,
  budgetVsActual,
  lightFor,
  missingExpensesNote,
  roundBudget,
} from './shape';

const month = (m: string, sales: number, byCategory: Record<string, number>): PnlMonth => {
  const expenses = Object.values(byCategory).reduce((s, v) => s + v, 0);
  return { month: m, sales, otherIncome: 0, expenses, byCategory, margin: sales - expenses };
};

describe('budget from last year', () => {
  it('copies each month ± growth, rounded to thousands, skipping empty cells', () => {
    const cells = budgetFromActuals(
      [
        month('2025-01', 10_000_400, { arriendo: 2_000_000 }),
        month('2025-02', 0, { arriendo: 2_000_000 }),
      ],
      { year: 2026, growthPct: 10 },
    );
    expect(cells).toContainEqual({
      category: 'ventas',
      kind: 'ingreso',
      month: 1,
      amount: 11_000_000,
    });
    expect(cells).toContainEqual({
      category: 'arriendo',
      kind: 'gasto',
      month: 2,
      amount: 2_200_000,
    });
    expect(cells.some((c) => c.category === 'ventas' && c.month === 2)).toBe(false);
  });

  it('folds confidential payroll into the nomina line', () => {
    expect(actualByCategory(month('2026-01', 0, { 'nomina (confidencial)': 5 })).nomina).toBe(5);
    expect(roundBudget(1_499)).toBe(1_000);
  });
});

describe('lights', () => {
  it('reads expenses and income in opposite directions', () => {
    expect(lightFor('gasto', 100, 100)).toBe('verde');
    expect(lightFor('gasto', 108, 100)).toBe('amarillo');
    expect(lightFor('gasto', 120, 100)).toBe('rojo');
    expect(lightFor('ingreso', 95, 100)).toBe('amarillo');
    expect(lightFor('ingreso', 80, 100)).toBe('rojo');
    expect(lightFor('gasto', 10, 0)).toBe('sin_presupuesto');
  });

  it('un gasto presupuestado con cero real no es verde: es «sin datos reales»', () => {
    expect(lightFor('gasto', 0, 500)).toBe('sin_datos');
    expect(lightFor('gasto', 0.2, 500)).toBe('sin_datos');
    // Un ingreso en cero sí es un mal resultado, no falta de datos.
    expect(lightFor('ingreso', 0, 500)).toBe('rojo');
    // Sin presupuesto y sin gasto: nada que decir.
    expect(lightFor('gasto', 0, 0)).toBe('verde');
  });
});

describe('budget vs actual', () => {
  const cells: BudgetCell[] = [
    ...Array.from({ length: 12 }, (_, i) => ({
      category: 'ventas',
      kind: 'ingreso' as const,
      month: i + 1,
      amount: 1_000,
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      category: 'arriendo',
      kind: 'gasto' as const,
      month: i + 1,
      amount: 300,
    })),
  ];
  const history = [
    month('2026-01', 1_100, { arriendo: 300 }),
    month('2026-02', 900, { arriendo: 300, software: 50 }),
    month('2026-03', 400, { arriendo: 450 }),
  ];

  it('prorates the current month and flags overruns', () => {
    const vs = budgetVsActual(cells, history, { year: 2026, today: '2026-03-15' });
    expect(vs.throughMonth).toBe(3);
    expect(vs.currentFraction).toBeCloseTo(15 / 31);
    const ventas = vs.rows.find((r) => r.category === 'ventas');
    expect(ventas?.months[0]?.light).toBe('verde');
    expect(ventas?.months[2]?.budgetToDate).toBeCloseTo((1_000 * 15) / 31, 1);
    expect(ventas?.months[3]?.light).toBe('pendiente');
    // Lo no presupuestado también aparece.
    expect(vs.unbudgeted).toEqual(['software']);
    expect(vs.rows.find((r) => r.category === 'software')?.ytd.light).toBe('sin_presupuesto');
    const overruns = budgetOverruns(vs);
    // Marzo ya pasó el mes entero del arriendo (450 > 300).
    expect(overruns[0]).toMatchObject({ category: 'arriendo', scope: 'mes', over: 150 });
    const items = collectPresupuesto({
      budgetName: 'P',
      year: 2026,
      month: 3,
      currency: 'COP',
      overruns,
    });
    expect(items[0]).toMatchObject({
      area: 'finanzas',
      proposedAction: null,
      href: '/presupuesto',
    });
    expect(items[0]?.why).toMatch(/marzo/);
  });

  it('marca «faltan los gastos de <mes>» donde el gasto presupuestado no tiene real', () => {
    const h = [
      month('2026-01', 1_100, { arriendo: 300 }),
      month('2026-02', 900, {}),
      month('2026-03', 400, {}),
    ];
    const vs = budgetVsActual(cells, h, { year: 2026, today: '2026-03-31' });
    const arriendo = vs.rows.find((r) => r.category === 'arriendo');
    expect(arriendo?.months[0]?.light).toBe('verde');
    expect(arriendo?.months[1]?.light).toBe('sin_datos');
    expect(arriendo?.months[2]?.light).toBe('sin_datos');
    expect(arriendo?.missingMonths).toEqual([2, 3]);
    expect(missingExpensesNote(arriendo?.missingMonths ?? [])).toBe(
      'faltan los gastos de febrero y marzo',
    );
    expect(missingExpensesNote([9])).toBe('faltan los gastos de septiembre');
    expect(missingExpensesNote([])).toBe('');
    // Una fila sin nada real en todo el acumulado queda gris, no verde.
    const none = budgetVsActual(cells, [month('2026-01', 1_000, {})], {
      year: 2026,
      today: '2026-01-31',
    });
    expect(none.rows.find((r) => r.category === 'arriendo')?.ytd.light).toBe('sin_datos');
    expect(none.totals.expensesMissing).toBe(true);
    // Los ingresos nunca se marcan sin datos.
    expect(none.rows.find((r) => r.category === 'ventas')?.missingMonths).toEqual([]);
  });

  it('closes a past year fully', () => {
    const vs = budgetVsActual(cells, history, { year: 2026, today: '2027-02-01' });
    expect(vs.throughMonth).toBe(12);
    expect(vs.currentFraction).toBe(1);
    expect(vs.totals.income.budget).toBe(12_000);
  });
});
