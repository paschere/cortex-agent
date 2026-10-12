import { describe, expect, it } from 'vitest';
import { clientsKpis, dataKpis, financeKpis, operationsKpis, teamKpis } from './area-kpis';

describe('cifras de arriba de cada área', () => {
  it('Plata: pesos completos, tendencia y cambio de lo que ya se leyó', () => {
    const k = financeKpis({
      cash: { currency: 'COP', total: 48_215_000 },
      weeklyClosing: [
        { start: '2026-10-05', closing: 50_000_000 },
        { start: '2026-10-12', closing: 60_000_000 },
      ],
      due: {
        currency: 'COP',
        receivable: { total: 10_000_000, overdue: 2_000_000, parties: [] },
        payable: { total: 5_000_000, overdue: 0, parties: [] },
        payrollHidden: 0,
      },
      pnl: null,
      nextTax: { title: 'IVA', dueLabel: '15 de octubre' },
    });
    expect(k.map((x) => x.key)).toEqual(['caja', 'cobrar', 'pagar', 'impuesto']);
    expect(k[0]?.value).toBe('$ 48.215.000');
    expect(k[0]?.spark?.values).toEqual([50_000_000, 60_000_000]);
    expect(k[0]?.delta?.ratio).toBeCloseTo(0.2446, 3);
    expect(k[1]?.tone).toBe('rose');
    expect(k[2]?.hint).toBe('al día');
  });

  it('un margen que baja se marca como malo, no como bueno', () => {
    const month = (m: string, margin: number) => ({
      month: m,
      sales: 0,
      otherIncome: 0,
      expenses: 0,
      byCategory: {},
      margin,
    });
    const k = financeKpis({
      pnl: {
        currency: 'COP',
        focus: '2026-10',
        payrollConfidential: false,
        months: [month('2026-09', 100), month('2026-10', 40)],
      },
    });
    expect(k[0]?.delta?.good).toBe(false);
    expect(k[0]?.delta?.ratio).toBeCloseTo(-0.6, 5);
  });

  it('abrevia sólo desde los miles de millones', () => {
    const k = financeKpis({ cash: { currency: 'COP', total: 1_600_000_000 } });
    expect(k[0]?.value).toContain('mil millones');
  });

  it('lo que no se leyó no sale (nunca un cero inventado)', () => {
    expect(financeKpis({})).toEqual([]);
    const k = clientsKpis({
      rows: [{ invoiced12m: null, outstanding: null, overdue: null }],
      pending: 0,
    });
    expect(k.map((x) => x.key)).toEqual(['clientes']);
  });

  it('Clientes suma saldo y vencido y cuenta quién está en mora', () => {
    const k = clientsKpis({
      rows: [
        { invoiced12m: 100, outstanding: 40, overdue: 10 },
        { invoiced12m: 50, outstanding: 0, overdue: 0 },
      ],
      pending: 2,
    });
    expect(k.find((x) => x.key === 'vencido')?.hint).toBe('en 1 cliente');
    expect(k.find((x) => x.key === 'clientes')?.hint).toContain('2');
  });

  it('Operación, Equipo y Datos', () => {
    const o = operationsKpis({
      processes: [{ state: 'ok' }, { state: 'error' }, { state: 'paused' }],
      blockedErrands: 2,
    });
    expect(o.map((x) => x.value)).toEqual(['1', '1', '1', '2']);
    expect(teamKpis({ people: 4, attention: 0, recognitions: 1, unassigned: null })).toHaveLength(
      3,
    );
    const d = dataKpis({
      today: '2026-10-11',
      tables: [
        { rowCount: 1200, updatedAt: '2026-10-11T10:00:00Z', syncs: 1 },
        { rowCount: 30, updatedAt: '2026-10-01T10:00:00Z', syncs: 0 },
      ],
    });
    expect(d.map((x) => x.value)).toEqual(['2', '1.230', '1', '1']);
  });
});
