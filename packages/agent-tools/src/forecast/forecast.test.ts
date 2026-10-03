import { describe, expect, it } from 'vitest';
import type { PnlMonth } from '../ledger/plans';
import { clientSalesForecast, productDemandForecast } from './demand';
import { addMonths, forecastPnl, seasonalIndex } from './pnl';

const month = (m: string, sales: number, byCategory: Record<string, number> = {}): PnlMonth => {
  const expenses = Object.values(byCategory).reduce((s, v) => s + v, 0);
  return { month: m, sales, otherIncome: 0, expenses, byCategory, margin: sales - expenses };
};

/** 24 meses con diciembre al doble. */
function seasonalHistory(): PnlMonth[] {
  const out: PnlMonth[] = [];
  for (let i = 0; i < 24; i++) {
    const m = addMonths('2024-10', i);
    out.push(month(m, m.endsWith('-12') ? 2_000 : 1_000, { arriendo: 300 }));
  }
  out.push(month('2026-10', 100, { arriendo: 0 })); // el mes en curso, a medias
  return out;
}

describe('P&L forecast', () => {
  it('uses seasonality with 12+ months', () => {
    const f = forecastPnl({ history: seasonalHistory(), today: '2026-10-03' });
    expect(f.method).toBe('estacional');
    expect(f.months).toHaveLength(12);
    expect(f.from).toBe('2026-10');
    const dec = f.months.find((m) => m.month === '2026-12');
    const nov = f.months.find((m) => m.month === '2026-11');
    expect((dec?.sales ?? 0) / (nov?.sales ?? 1)).toBeCloseTo(2, 1);
    expect(f.months[0]?.byCategory.arriendo).toBeCloseTo(300, 0);
    expect(f.assumptions[0]).toMatch(/estacional|pesar/);
    const idx = seasonalIndex(seasonalHistory().slice(0, 24), 'ventas');
    expect(idx[11]).toBeGreaterThan(idx[0] ?? 0);
  });

  it('falls back to the recent run-rate with little history', () => {
    const f = forecastPnl({
      history: [
        month('2026-07', 900),
        month('2026-08', 1_000),
        month('2026-09', 1_100),
        month('2026-10', 50),
      ],
      today: '2026-10-03',
      horizon: 3,
    });
    expect(f.method).toBe('ritmo');
    expect(f.months.map((m) => m.sales)).toEqual([1_000, 1_000, 1_000]);
    expect(f.assumptions[0]).toMatch(/3 meses completos/);
  });

  it('says so when there is nothing to forecast', () => {
    const f = forecastPnl({ history: [], today: '2026-10-03', horizon: 2 });
    expect(f.method).toBe('sin_datos');
    expect(f.totals.margin).toBe(0);
  });

  it('raises recurring expenses to their floor and applies a scenario', () => {
    const history = [
      month('2026-08', 1_000, { software: 100 }),
      month('2026-09', 1_000, { software: 100 }),
    ];
    const f = forecastPnl({
      history,
      today: '2026-10-03',
      horizon: 3,
      recurring: [{ label: 'ERP', direction: 'out', category: 'software', monthly: 250 }],
      clients: [{ name: 'Nexa SAS', monthly: 400, recurring: true }],
      adjustments: [
        { kind: 'drop_counterparty', counterpartyName: 'nexa' },
        {
          kind: 'one_off',
          label: 'Venta de equipo',
          direction: 'in',
          amount: 500,
          date: '2026-11-15',
        },
      ],
    });
    expect(f.months[0]?.byCategory.software).toBe(250);
    expect(f.months[0]?.sales).toBe(600);
    expect(f.months[1]?.scenarioIn).toBe(500);
    expect(f.baseTotals?.sales).toBe(3_000);
    expect(f.assumptions.join(' ')).toMatch(/sin Nexa SAS/);
  });
});

describe('sales by client', () => {
  it('tells recurring from occasional clients', () => {
    const invoices = [
      ...['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((m) => ({
        counterpartyName: 'Nexa SAS',
        date: `${m}-10`,
        amount: 1_000,
      })),
      { counterpartyName: 'Ocasional Ltda', date: '2026-02-01', amount: 1_200 },
    ];
    const f = clientSalesForecast(invoices, '2026-10-03');
    expect(f.clients[0]).toMatchObject({
      name: 'Nexa SAS',
      recurring: true,
      monthly: 1_000,
      activeMonths: 6,
    });
    expect(f.clients[1]).toMatchObject({ name: 'Ocasional Ltda', recurring: false, monthly: 100 });
    expect(f.recurringMonthly).toBe(1_000);
  });
});

describe('product demand', () => {
  it('projects outflows and when stock runs out', () => {
    const outflows = ['2026-07', '2026-08', '2026-09'].map((m) => ({
      productId: 'p1',
      qty: 10,
      occurredOn: `${m}-05`,
    }));
    const d = productDemandForecast(
      [{ id: 'p1', name: 'Tornillo', unit: 'und', onHand: 25 }],
      outflows,
      '2026-10-03',
    );
    expect(d[0]).toMatchObject({ method: 'ritmo', monthsOfCover: 2.5, runsOutIn: '2026-12' });
    expect(d[0]?.next[0]).toEqual({ month: '2026-10', qty: 10 });
  });
});
