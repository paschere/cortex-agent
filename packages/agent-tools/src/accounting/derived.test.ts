import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  balanceStatementLines,
  derivedMonthQueries,
  payrollCostLines,
  pnlStatementLines,
  readStatementMonth,
  recordsForMonth,
  snapshotUsable,
  stockLinesFromProduct,
} from './derived';
import type { ProviderBalance, ProviderPnl, ProviderReports } from './providers/reports';

/** Lo que se arma de otras lecturas (0234): existencias, estados mensuales y costo de nómina. */

const pnl: ProviderPnl = {
  provider: 'siigo',
  from: '2026-09-01',
  to: '2026-09-30',
  currency: 'COP',
  revenue: 10_000_000,
  costOfSales: 4_000_000,
  operatingExpenses: 3_000_000,
  otherIncome: 100_000,
  otherExpenses: 50_000,
  incomeTax: null,
  netIncome: 3_050_000,
  lines: [
    { section: 'ingreso', code: '41', name: 'Operacionales', amount: 10_000_000 },
    { section: 'costo', code: '61', name: 'Costo de ventas', amount: 4_000_000 },
    { section: 'gasto', code: '51', name: 'Administración', amount: 2_000_000 },
  ],
  personnel: [
    { code: '51050601', name: 'SUELDOS', amount: 1_500_000 },
    { code: '52050601', name: 'sueldos', amount: 700_000 },
    { code: '510568', name: 'APORTES A ADMINISTRADORAS DE RIESGOS PROFESIONALES ARL', amount: 80_000 },
    { code: '5105', name: 'cuenta mayor', amount: 9 },
    { code: '51051501', name: 'sin movimiento', amount: 0 },
  ],
  notes: [],
};
const balance: ProviderBalance = {
  provider: 'siigo',
  asOf: '2026-09-30',
  currency: 'COP',
  totalAssets: 9_000_000,
  currentAssets: 5_000_000,
  nonCurrentAssets: 4_000_000,
  totalLiabilities: 3_000_000,
  currentLiabilities: 3_000_000,
  nonCurrentLiabilities: 0,
  equity: 6_000_000,
  lines: [
    { section: 'activo_corriente', code: '11', name: 'Efectivo', amount: 2_000_000 },
    { section: 'pasivo_corriente', code: '22', name: 'Proveedores', amount: 3_000_000 },
  ],
  notes: [],
};

describe('existencias por bodega', () => {
  it('una fila por producto y bodega', () => {
    const lines = stockLinesFromProduct({
      externalId: 'p1',
      name: 'Estiba',
      code: 'EST',
      stock: 15,
      unit: 'und',
      warehouses: [
        { externalId: '1', name: 'Principal', quantity: 10 },
        { externalId: '2', name: 'Bogotá', quantity: 5 },
      ],
    });
    expect(lines.map((l) => [l.externalId, l.warehouseName, l.quantity])).toEqual([
      ['p1:1', 'Principal', 10],
      ['p1:2', 'Bogotá', 5],
    ]);
  });
  it('sin bodegas, una fila con el total; un servicio no tiene existencias', () => {
    expect(stockLinesFromProduct({ externalId: 'p2', name: 'X', stock: 3 })).toMatchObject([
      { externalId: 'p2:total', warehouseName: 'Todas', quantity: 3 },
    ]);
    expect(stockLinesFromProduct({ externalId: 'p3', name: 'Flete', kind: 'Servicio', stock: 3 })).toEqual([]);
    expect(stockLinesFromProduct({ externalId: 'p4', name: 'Sin control' })).toEqual([]);
  });
});

describe('estados mensuales', () => {
  it('la primera vez, dos años; después, el mes anterior y el actual', () => {
    const initial = derivedMonthQueries('initial', '2026-10-21');
    expect(initial).toHaveLength(24);
    expect(initial[0]).toEqual({ month: '2024-11' });
    expect(initial[23]).toEqual({ month: '2026-10' });
    expect(derivedMonthQueries('incremental', '2026-01-05')).toEqual([{ month: '2025-12' }, { month: '2026-01' }]);
  });
  it('el estado de resultados: rubros del PUC y resumen, una fila única por rubro', () => {
    const lines = pnlStatementLines('2026-09', pnl, false);
    expect(lines.find((l) => l.name === 'Ventas')).toMatchObject({ statement: 'Estado de resultados', section: 'Resumen', amount: 10_000_000 });
    expect(lines.find((l) => l.name === 'Utilidad bruta')?.amount).toBe(6_000_000);
    expect(lines.find((l) => l.code === '41')).toMatchObject({ section: 'Ingresos', externalId: 'pnl|2026-09|ingresos|41' });
    expect(new Set(lines.map((l) => l.externalId)).size).toBe(lines.length);
  });
  it('un rubro repetido recibe un sufijo y no choca', () => {
    const dup = { ...pnl, lines: [pnl.lines[0], pnl.lines[0]] } as ProviderPnl;
    const keys = pnlStatementLines('2026-09', dup, false).map((l) => l.externalId);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('el balance general al cierre del mes', () => {
    const lines = balanceStatementLines('2026-09', balance, true);
    expect(lines.find((l) => l.name === 'Total activo')).toMatchObject({ statement: 'Balance general', amount: 9_000_000, inProgress: true });
    expect(lines.find((l) => l.name === 'Patrimonio')?.amount).toBe(6_000_000);
    expect(lines.find((l) => l.code === '22')?.section).toBe('Pasivo corriente');
  });
  it('recordsForMonth junta resultados y balance en estados, y sólo personal en nómina', () => {
    const reading = { pnl, balance, fetched: 2, inProgress: false };
    const statements = recordsForMonth('statements', '2026-09', reading);
    expect(statements.some((r) => (r as { statement: string }).statement === 'Balance general')).toBe(true);
    expect(statements.some((r) => (r as { statement: string }).statement === 'Estado de resultados')).toBe(true);
    expect(recordsForMonth('payroll_costs', '2026-09', reading).length).toBeGreaterThan(0);
    expect(recordsForMonth('payroll_costs', '2026-09', { ...reading, pnl: null })).toEqual([]);
    expect(recordsForMonth('customers', '2026-09', reading)).toEqual([]);
  });
});

describe('costo de nómina por mes, área y concepto', () => {
  const rows = payrollCostLines('2026-09', pnl.personnel ?? [], false);
  it('una fila por subcuenta y área, sin cuentas mayores ni ceros', () => {
    expect(rows).toHaveLength(3);
    const admin = rows.find((r) => r.externalId === 'payroll|2026-09|51050601');
    expect(admin).toMatchObject({ area: 'Administración', concept: 'Sueldos', amount: 1_500_000 });
    expect(rows.find((r) => r.externalId === 'payroll|2026-09|52050601')).toMatchObject({ area: 'Ventas', amount: 700_000 });
  });
  it('sólo totales de la empresa: ninguna fila lleva persona', () => {
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['amount', 'area', 'concept', 'externalId', 'group', 'inProgress', 'period']);
  });
});

describe('copia por mes', () => {
  it('un mes cerrado sirve si se sacó después de cerrar; el actual, 6 horas', () => {
    expect(snapshotUsable('2026-10-02T10:00:00Z', '2026-09-30', '2026-10-21', 0)).toBe(true);
    expect(snapshotUsable('2026-09-30T10:00:00Z', '2026-09-30', '2026-10-21', 0)).toBe(false);
    const t = Date.parse('2026-10-21T12:00:00Z');
    expect(snapshotUsable('2026-10-21T08:00:00Z', '2026-10-31', '2026-10-21', t)).toBe(true);
    expect(snapshotUsable('2026-10-21T05:00:00Z', '2026-10-31', '2026-10-21', t)).toBe(false);
  });

  function fakeDb(saved: Array<Record<string, unknown>>) {
    const upserts: Array<Record<string, unknown>> = [];
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: imita el builder de supabase-js
      then: (resolve: (v: unknown) => void) => resolve({ data: saved, error: null }),
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    };
    return { db: { from: () => chain } as unknown as SupabaseClient, upserts };
  }
  function reports() {
    const calls: string[] = [];
    const r: ProviderReports = {
      balanceSheet: async (asOf) => {
        calls.push(`balance:${asOf}`);
        return balance;
      },
      profitAndLoss: async (from, to) => {
        calls.push(`pnl:${from}..${to}`);
        return pnl;
      },
    };
    return { r, calls };
  }
  const want = { pnl: true, balance: true, personnel: false };

  it('sin copia, lee al programa y la guarda', async () => {
    const { db, upserts } = fakeDb([]);
    const { r, calls } = reports();
    const out = await readStatementMonth(db, { provider: 'siigo', reports: r, month: '2026-09', today: '2026-10-21', userId: null, want });
    expect(calls).toEqual(['pnl:2026-09-01..2026-09-30', 'balance:2026-09-30']);
    expect(out.fetched).toBe(2);
    expect(upserts.map((u) => u.kind)).toEqual(['pnl', 'balance']);
  });
  it('con la copia de un mes cerrado, no pide nada', async () => {
    const { db, upserts } = fakeDb([
      { kind: 'pnl', period_key: '2026-09-01..2026-09-30', payload: { report: pnl }, fetched_at: '2026-10-03T00:00:00Z' },
      { kind: 'balance', period_key: '2026-09-30', payload: { report: balance }, fetched_at: '2026-10-03T00:00:00Z' },
    ]);
    const { r, calls } = reports();
    const out = await readStatementMonth(db, { provider: 'siigo', reports: r, month: '2026-09', today: '2026-10-21', userId: null, want });
    expect(calls).toEqual([]);
    expect(out.fetched).toBe(0);
    expect(upserts).toEqual([]);
    expect(out.pnl?.revenue).toBe(10_000_000);
  });
  it('el mes en curso se lee hasta hoy', async () => {
    const { db } = fakeDb([]);
    const { r, calls } = reports();
    const out = await readStatementMonth(db, { provider: 'siigo', reports: r, month: '2026-10', today: '2026-10-21', userId: null, want });
    expect(calls).toEqual(['pnl:2026-10-01..2026-10-21', 'balance:2026-10-21']);
    expect(out.inProgress).toBe(true);
  });
  it('la nómina vuelve a leer si la copia no trae el gasto de personal', async () => {
    const noPeople = { ...pnl, personnel: undefined };
    const { db } = fakeDb([
      { kind: 'pnl', period_key: '2026-09-01..2026-09-30', payload: { report: noPeople }, fetched_at: '2026-10-03T00:00:00Z' },
    ]);
    const { r, calls } = reports();
    await readStatementMonth(db, { provider: 'siigo', reports: r, month: '2026-09', today: '2026-10-21', userId: null, want: { pnl: true, balance: false, personnel: true } });
    expect(calls).toEqual(['pnl:2026-09-01..2026-09-30']);
  });
});
