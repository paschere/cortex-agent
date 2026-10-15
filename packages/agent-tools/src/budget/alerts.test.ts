import { describe, expect, it } from 'vitest';
import type { PnlMonth } from '../ledger/plans';
import { DEFAULT_THRESHOLDS, alertHref, budgetAlerts, levelFor, parseThresholds } from './alerts';
import { collectPresupuesto } from './autopilot-collect';
import { type BudgetCell, budgetVsActual, lightFor } from './shape';

const pnl = (m: string, byCategory: Record<string, number>): PnlMonth => {
  const expenses = Object.values(byCategory).reduce((s, v) => s + v, 0);
  return { month: m, sales: 0, otherIncome: 0, expenses, byCategory, margin: -expenses };
};

const cells: BudgetCell[] = [
  { category: 'combustible', kind: 'gasto', month: 10, amount: 1_000_000 },
  { category: 'arriendo', kind: 'gasto', month: 10, amount: 2_000_000 },
  { category: 'software', kind: 'gasto', month: 10, amount: 500_000 },
  { category: 'ventas', kind: 'ingreso', month: 10, amount: 50_000_000 },
];
const history = [
  pnl('2026-10', { combustible: 1_120_000, arriendo: 1_850_000, software: 300_000 }),
];
const vs = budgetVsActual(cells, history, { year: 2026, today: '2026-10-20' });

describe('alert thresholds', () => {
  it('9 %: defaults are 90 % and 110 %', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ enabled: true, warnPct: 90, overPct: 110 });
  });

  it('classifies a ratio against both thresholds', () => {
    expect(levelFor(0.89, DEFAULT_THRESHOLDS)).toBeNull();
    expect(levelFor(0.9, DEFAULT_THRESHOLDS)).toBe('aviso');
    expect(levelFor(1.09, DEFAULT_THRESHOLDS)).toBe('aviso');
    expect(levelFor(1.1, DEFAULT_THRESHOLDS)).toBe('excedido');
    expect(levelFor(0.8, { enabled: true, warnPct: 75, overPct: 100 })).toBe('aviso');
  });

  it('validates what a person typed', () => {
    expect(parseThresholds({ warnPct: '80', overPct: 120 })).toEqual({
      enabled: true,
      warnPct: 80,
      overPct: 120,
    });
    expect(() => parseThresholds({ warnPct: 110, overPct: 100 })).toThrow(/mayor/);
    expect(() => parseThresholds({ warnPct: 20, overPct: 110 })).toThrow(/50/);
    expect(() => parseThresholds({ warnPct: 90, overPct: 900 })).toThrow(/300/);
    expect(parseThresholds({ enabled: false, warnPct: 90, overPct: 110 }).enabled).toBe(false);
  });
});

describe('budget alerts', () => {
  const alerts = budgetAlerts(vs, DEFAULT_THRESHOLDS);

  it('flags the expense over 110 % first, then the one near the limit', () => {
    expect(alerts.map((a) => [a.category, a.level])).toEqual([
      ['combustible', 'excedido'],
      ['arriendo', 'aviso'],
    ]);
    expect(alerts[0]?.title).toBe('Combustible va en 112 % del presupuesto del mes');
    expect(alerts[0]?.over).toBe(120_000);
  });

  it('ignores income, categories under the threshold and is silent when disabled', () => {
    expect(alerts.some((a) => a.category === 'ventas' || a.category === 'software')).toBe(false);
    expect(budgetAlerts(vs, { ...DEFAULT_THRESHOLDS, enabled: false })).toEqual([]);
  });

  it('compares against the WHOLE month, not the prorated part', () => {
    // El día 20 de 31 el prorrateo de combustible sería ~645 mil: 1,12 M ya pasaría
    // de largo; contra el mes entero es 112 %, que es lo que se avisa.
    expect(alerts[0]?.ratio).toBeCloseTo(1.12, 5);
  });

  it('a lower threshold catches more', () => {
    const loose = budgetAlerts(vs, { enabled: true, warnPct: 55, overPct: 120 });
    expect(loose.map((a) => a.category)).toContain('software');
    expect(loose.find((a) => a.category === 'combustible')?.level).toBe('aviso');
  });

  it('builds a drill-down link to the movements', () => {
    expect(alertHref({ category: 'combustible', year: 2026, month: 10 })).toBe(
      '/presupuesto?anio=2026&detalle=combustible&mes=10',
    );
  });
});

describe('traffic light with the company thresholds', () => {
  it('keeps the old light without thresholds', () => {
    expect(lightFor('gasto', 950_000, 1_000_000)).toBe('verde');
  });
  it('turns amber at the warn threshold and red at the over threshold', () => {
    const t = { warnPct: 90, overPct: 110 };
    expect(lightFor('gasto', 850_000, 1_000_000, t)).toBe('verde');
    expect(lightFor('gasto', 950_000, 1_000_000, t)).toBe('amarillo');
    expect(lightFor('gasto', 1_100_000, 1_000_000, t)).toBe('rojo');
  });
  it('flows through budgetVsActual to every cell and the accumulated row', () => {
    const t = { warnPct: 90, overPct: 110 };
    const withT = budgetVsActual(cells, history, {
      year: 2026,
      today: '2026-10-31',
      thresholds: t,
    });
    const fuel = withT.rows.find((r) => r.category === 'combustible');
    expect(fuel?.months[9]?.light).toBe('rojo');
    expect(fuel?.ytd.light).toBe('rojo');
    const rent = withT.rows.find((r) => r.category === 'arriendo');
    expect(rent?.months[9]?.light).toBe('amarillo');
  });
});

describe('autopilot item', () => {
  it('says «Combustible va en 112 % del presupuesto del mes» and links the movements', () => {
    const alerts = budgetAlerts(vs, DEFAULT_THRESHOLDS);
    const items = collectPresupuesto({
      budgetName: 'Presupuesto 2026',
      year: 2026,
      month: 10,
      currency: 'COP',
      overruns: [],
      alerts,
    });
    expect(items[0]?.title).toBe('Combustible va en 112 % del presupuesto del mes');
    expect(items[0]?.href).toBe('/presupuesto?anio=2026&detalle=combustible&mes=10');
    expect(items[0]?.proposedAction).toBeNull();
    expect(items[0]?.dedupeKey).toContain('combustible');
    expect(items).toHaveLength(2);
  });

  it('keeps only the year-to-date overruns when alerts cover the month', () => {
    const items = collectPresupuesto({
      budgetName: 'P',
      year: 2026,
      month: 10,
      currency: 'COP',
      overruns: [
        {
          category: 'a',
          label: 'A',
          month: 10,
          scope: 'mes',
          budget: 1,
          actual: 2,
          over: 1,
          pct: 2,
        },
        {
          category: 'b',
          label: 'B',
          month: 10,
          scope: 'acumulado',
          budget: 10,
          actual: 12,
          over: 2,
          pct: 1.2,
        },
      ],
      alerts: [],
    });
    expect(items.map((i) => i.title)).toEqual(['B se pasó del presupuesto']);
  });
});
