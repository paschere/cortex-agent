import { describe, expect, it } from 'vitest';
import type { ProviderPnl } from '../accounting/providers/reports';
import { monthlyMarkdown, rowFromPnl, sumRows } from './monthly';

const pnl = (revenue: number, cost: number, opex: number, oi = 0, oe = 0, tax = 0): ProviderPnl => ({
  provider: 'siigo',
  from: '2026-01-01',
  to: '2026-01-31',
  currency: 'COP',
  revenue,
  costOfSales: cost,
  operatingExpenses: opex,
  otherIncome: oi,
  otherExpenses: oe,
  incomeTax: tax,
  netIncome: revenue + oi - cost - opex - oe - tax,
  lines: [],
  notes: [],
});

describe('estado de resultados mes a mes', () => {
  const rows = [
    rowFromPnl('2026-01', pnl(160_000_000, 110_000_000, 18_000_000, 500_000, 1_500_000, 0), { cash: { revenue: 12_000_000, net: 3_000_000 } }),
    rowFromPnl('2026-02', pnl(150_000_000, 100_000_000, 17_000_000), { cash: { revenue: 10_000_000, net: 1_000_000 } }),
  ];
  it('calcula bruta, operacional y neta', () => {
    expect(rows[0]).toMatchObject({
      grossProfit: 50_000_000,
      operatingIncome: 32_000_000,
      nonOperating: -1_000_000,
      netIncome: 31_000_000,
    });
  });
  it('suma los meses', () => {
    const t = sumRows(rows);
    expect(t.revenue).toBe(310_000_000);
    expect(t.netIncome).toBe(31_000_000 + 33_000_000);
    expect(t.cashRevenue).toBe(22_000_000);
  });
  it('markdown con caja, total y meses faltantes', () => {
    const md = monthlyMarkdown({ provider: 'siigo', year: 2026, rows, missing: ['2026-03'], errors: [], fetchedMonths: 2, cachedMonths: 0 });
    expect(md).toContain('ene 2026');
    expect(md).toContain('Caja: ingresos');
    expect(md).toContain('**Total**');
    expect(md).toMatch(/\$\s160\.000\.000/);
    expect(md).toContain('Faltan 1 mes(es)');
    expect(md).not.toMatch(/statements\.get|accounting\.query/);
  });
  it('sin caja no pone columnas de caja', () => {
    const md = monthlyMarkdown({ provider: 'siigo', year: 2026, rows: [rowFromPnl('2026-01', pnl(1, 1, 0))], missing: [], errors: [], fetchedMonths: 1, cachedMonths: 0 });
    expect(md).not.toContain('Caja:');
  });
});
