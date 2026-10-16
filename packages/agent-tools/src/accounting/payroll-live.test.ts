import { describe, expect, it } from 'vitest';
import { livePayrollMarkdown, livePayrollMonth, livePayrollRanges, readLivePayroll } from './payroll-live';
import { pnlFromTrialBalance, type TrialBalanceRow } from './providers/reports';

const row = (code: string, name: string, debit: number, credit = 0): TrialBalanceRow => ({
  code, name, initial: 0, debit, credit, final: debit - credit,
});

const BALANCE: TrialBalanceRow[] = [
  row('5', 'GASTOS', 0),
  row('51', 'OPERACIONALES DE ADMINISTRACION', 0),
  row('5105', 'GASTOS DE PERSONAL', 0),
  row('510506', 'SUELDOS', 10_000_000),
  row('510527', 'AUXILIO DE TRANSPORTE', 1_000_000),
  row('510530', 'CESANTIAS', 900_000),
  row('510569', 'APORTES A EPS', 800_000),
  row('5205', 'GASTOS DE PERSONAL', 0),
  row('520506', 'SUELDOS', 4_000_000),
  row('7205', 'MANO DE OBRA', 0),
  row('720506', 'SUELDOS', 6_000_000),
  row('513525', 'SERVICIOS', 3_000_000),
];

const pnl = () =>
  pnlFromTrialBalance(BALANCE, { provider: 'siigo', from: '2026-08-01', to: '2026-08-31', currency: 'COP' });

describe('nómina en vivo desde el balance de prueba', () => {
  it('toma sólo las hojas de 5105/5205/7205', () => {
    const p = pnl();
    expect(p.personnel?.map((x) => x.code)).toEqual(['510506', '510527', '510530', '510569', '520506', '720506']);
  });

  it('suma total, áreas, grupos y conceptos', () => {
    const m = livePayrollMonth('2026-08', pnl().personnel ?? []);
    expect(m.total).toBe(22_700_000);
    expect(m.byArea).toEqual({ administracion: 12_700_000, ventas: 4_000_000, produccion: 6_000_000 });
    expect(m.byGroup.devengado).toBe(21_000_000);
    expect(m.byGroup.prestaciones).toBe(900_000);
    expect(m.byGroup.aportes).toBe(800_000);
    expect(m.conceptos[0]).toMatchObject({ concept: 'Sueldos', amount: 20_000_000 });
  });

  it('mes sin gasto de personal lo dice con las fechas', () => {
    const empty = pnlFromTrialBalance([], { provider: 'siigo', from: 'a', to: 'b', currency: 'COP' });
    const m = livePayrollMonth('2026-08', empty.personnel ?? []);
    const md = livePayrollMarkdown(
      { months: [m], missing: [], errors: [], provider: 'siigo' },
      { providerLabel: 'Siigo', from: '2026-08-01', to: '2026-08-31', canSeePeople: true },
    );
    expect(md).toContain('En la contabilidad de Siigo no hay gasto de personal registrado entre 2026-08-01 y 2026-08-31');
    expect(md).not.toMatch(/módulo/i);
  });

  it('el texto va en pesos completos y sin datos por persona', () => {
    const m = livePayrollMonth('2026-08', pnl().personnel ?? []);
    const md = livePayrollMarkdown(
      { months: [m], missing: [], errors: [], provider: 'siigo' },
      { providerLabel: 'Siigo', from: '2026-08-01', to: '2026-08-31', canSeePeople: false },
    );
    expect(md).toMatch(/22\.700\.000/);
    expect(md).toContain('confidencial');
    expect(JSON.stringify(m)).not.toMatch(/taxId|identification|people/);
  });

  it('rangos: últimos meses cruzando de año, mes suelto y año', () => {
    expect(livePayrollRanges({ months: 4 }, '2026-02-10')).toEqual([
      { year: 2025, fromMonth: 11, throughMonth: 12 },
      { year: 2026, fromMonth: 1, throughMonth: 2 },
    ]);
    expect(livePayrollRanges({ months: 6, period: '2026-08' }, '2026-10-16')).toEqual([
      { year: 2026, fromMonth: 8, throughMonth: 8 },
    ]);
    expect(livePayrollRanges({ months: 6, year: 2026, fromMonth: 3 }, '2026-10-16')).toEqual([
      { year: 2026, fromMonth: 3, throughMonth: 10 },
    ]);
  });

  it('readLivePayroll pide copias con gasto de personal y junta los tramos', async () => {
    const calls: unknown[] = [];
    const read = (async (_db: unknown, o: { fromMonth: number; requirePersonnel?: boolean }) => {
      calls.push(o.requirePersonnel);
      return {
        provider: 'siigo', year: 2026, missing: [], errors: [], fetchedMonths: 1, cachedMonths: 0,
        rows: [{ month: `2026-0${o.fromMonth}`, inProgress: false, personnel: pnl().personnel }],
      };
    }) as never;
    const r = await readLivePayroll({} as never, {
      ranges: [{ year: 2026, fromMonth: 7, throughMonth: 7 }, { year: 2026, fromMonth: 8, throughMonth: 8 }],
      today: '2026-10-16', viewerId: null, read,
    });
    expect(calls).toEqual([true, true]);
    expect(r.months.map((m) => m.total)).toEqual([22_700_000, 22_700_000]);
  });
});
