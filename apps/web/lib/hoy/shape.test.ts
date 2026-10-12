import type { ForecastResult, LedgerMovement } from '@cortex/agent-tools/src/ledger/types';
import { describe, expect, it } from 'vitest';
import {
  buildHoyMetrics,
  cashEvents,
  cashHistory,
  cashRecords,
  countWord,
  effectiveDay,
  greetingFor,
  kpiOf,
  narrative,
  narrativeText,
  overdueSeries,
  payablesDaily,
  projectionFromForecast,
  salesDaily,
} from './shape';

const TODAY = '2026-10-10';

function mv(
  p: Partial<LedgerMovement> & Pick<LedgerMovement, 'id' | 'direction' | 'amount'>,
): LedgerMovement {
  return {
    kind: 'income',
    status: 'settled',
    currency: 'COP',
    date: TODAY,
    description: p.id,
    source: { kind: 'manual', ref: p.id },
    ...p,
  } as LedgerMovement;
}

const forecast = (over: Partial<ForecastResult> = {}): ForecastResult => ({
  asOf: TODAY,
  currency: 'COP',
  startingCash: 1000,
  weeks: [
    {
      start: '2026-10-05',
      opening: 1000,
      inflows: 0,
      outflows: 200,
      closing: 800,
      items: [
        {
          label: 'Nómina',
          direction: 'out',
          amount: 200,
          expectedAmount: 200,
          probability: 1,
          expectedDate: '2026-10-15',
          reason: '',
          category: 'nomina',
        },
        {
          label: 'Cobro',
          direction: 'in',
          amount: 100,
          expectedAmount: 50,
          probability: 0.5,
          expectedDate: '2026-10-14',
          reason: '',
          counterpartyName: 'Frigoandes S.A.S.',
        },
      ],
    },
    { start: '2026-10-12', opening: 800, inflows: 0, outflows: 0, closing: 700, items: [] },
  ],
  lowest: { week: '2026-10-12', closing: 700 },
  alerts: [],
  assumptions: [],
  ...over,
});

describe('cashHistory', () => {
  it('deshace los movimientos hacia atrás desde el saldo de hoy', () => {
    const h = cashHistory(
      [
        { date: '2026-10-10', net: 50 },
        { date: '2026-10-08', net: -30 },
      ],
      1000,
      TODAY,
      4,
    );
    const by = Object.fromEntries(h.map((p) => [p.date, p.value]));
    expect(by['2026-10-10']).toBe(1000);
    expect(by['2026-10-09']).toBe(950);
    expect(by['2026-10-08']).toBe(950);
    expect(by['2026-10-07']).toBe(980);
    expect(h).toHaveLength(5);
    expect((h[0]?.date ?? '') < (h.at(-1)?.date ?? '')).toBe(true);
  });
});

describe('projectionFromForecast', () => {
  it('reparte por día entre hoy y el fin de cada semana, y ensancha el rango', () => {
    const p = projectionFromForecast(forecast(), TODAY);
    expect(p[0]?.date).toBe('2026-10-11');
    expect(p.at(-1)?.date).toBe('2026-10-18');
    expect(p.at(-1)?.value).toBe(700);
    const last = p.at(-1);
    expect(last && last.lo <= last.value && last.hi >= last.value).toBe(true);
    // Lo que entra con 50 % de certeza: baja el piso en 50.
    expect(last?.lo).toBe(650);
  });
});

describe('eventos', () => {
  it('nómina futura, cobro grande, sin duplicar y sin razón social', () => {
    const e = cashEvents(forecast(), [], TODAY, 'COP');
    expect(e.find((x) => x.label === 'Nómina')?.date).toBe('2026-10-15');
    expect(e.find((x) => x.label.startsWith('Cobro'))?.label).toBe('Cobro Frigoandes');
  });
  it('la nómina liquidada entra como evento pasado', () => {
    const e = cashEvents(
      null,
      [mv({ id: 'n', direction: 'out', amount: 5, category: 'nomina', settledAt: '2026-09-30' })],
      TODAY,
      'COP',
    );
    expect(e).toEqual([{ date: '2026-09-30', label: 'Nómina', tone: 'amber' }]);
  });
});

describe('cartera vencida', () => {
  const rows = [
    mv({
      id: 'a',
      direction: 'in',
      kind: 'receivable',
      status: 'expected',
      amount: 100,
      dueDate: '2026-10-01',
      date: '2026-09-01',
    }),
    mv({
      id: 'b',
      direction: 'in',
      kind: 'receivable',
      status: 'settled',
      amount: 40,
      dueDate: '2026-09-20',
      settledAt: '2026-10-05',
      date: '2026-09-01',
    }),
    mv({
      id: 'c',
      direction: 'in',
      kind: 'receivable',
      status: 'expected',
      amount: 70,
      dueDate: '2026-10-20',
      date: '2026-10-01',
    }),
  ];
  it('cuenta una factura sólo mientras estuvo vencida y sin pagar', () => {
    const s = overdueSeries(rows, TODAY, 20);
    const by = Object.fromEntries(s.map((p) => [p.date, p.value]));
    expect(by['2026-09-20']).toBe(0);
    expect(by['2026-09-21']).toBe(40);
    expect(by['2026-10-02']).toBe(140);
    expect(by['2026-10-05']).toBe(100);
    expect(by[TODAY]).toBe(100);
  });
});

describe('por pagar y ventas', () => {
  const rows = [
    mv({
      id: 'p1',
      direction: 'out',
      kind: 'payable',
      status: 'expected',
      amount: 30,
      dueDate: '2026-10-12',
    }),
    mv({
      id: 'p2',
      direction: 'out',
      kind: 'payable',
      status: 'expected',
      amount: 20,
      dueDate: '2026-10-12',
      category: 'nomina',
    }),
    mv({
      id: 's1',
      direction: 'in',
      kind: 'receivable',
      status: 'expected',
      amount: 90,
      date: '2026-10-03',
      dueDate: '2026-11-01',
    }),
  ];
  it('la nómina por pagar sólo la ve quien administra', () => {
    expect(payablesDaily(rows, TODAY, false).find((p) => p.date === '2026-10-12')?.value).toBe(30);
    expect(payablesDaily(rows, TODAY, true).find((p) => p.date === '2026-10-12')?.value).toBe(50);
  });
  it('ventas por fecha de emisión', () => {
    expect(salesDaily(rows, TODAY)).toEqual([{ date: '2026-10-03', value: 90 }]);
  });
});

describe('privacidad de la nómina en los registros', () => {
  const rows = [
    mv({
      id: 'n',
      direction: 'out',
      amount: 500,
      category: 'nomina',
      settledAt: '2026-10-01',
      description: 'Ana Pérez',
    }),
    mv({ id: 'x', direction: 'out', amount: 50, category: 'services', settledAt: '2026-10-02' }),
  ];
  it('no sale de quien no administra', () => {
    expect(cashRecords(rows, false).map((r) => r.id)).toEqual(['x']);
    expect(
      cashRecords(rows, true)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['n', 'x']);
  });
  it('effectiveDay: liquidado usa settledAt; esperado, el vencimiento', () => {
    expect(effectiveDay(rows[0] as LedgerMovement)).toBe('2026-10-01');
    expect(
      effectiveDay(
        mv({ id: 'e', direction: 'in', amount: 1, status: 'expected', dueDate: '2026-12-01' }),
      ),
    ).toBe('2026-12-01');
  });
});

describe('buildHoyMetrics', () => {
  const base = {
    today: TODAY,
    currency: 'COP',
    isAdmin: true,
    cashTotal: 1000,
    forecast: forecast(),
    minimumCash: 1200,
    movements: [
      mv({
        id: 'a',
        direction: 'in',
        kind: 'receivable',
        status: 'expected',
        amount: 100,
        dueDate: '2026-10-01',
        date: '2026-09-01',
      }),
    ],
    runs: [{ day: '2026-10-09', done: 3 }],
  };
  it('arma las cinco métricas y marca en alerta la caja bajo el mínimo y lo vencido', () => {
    const r = buildHoyMetrics(base);
    expect(r.metrics.map((m) => m.id)).toEqual([
      'caja',
      'vencido',
      'por-pagar',
      'ventas',
      'cortex',
    ]);
    expect(r.kpis.find((k) => k.id === 'caja')?.alert).toBe(true);
    expect(r.kpis.find((k) => k.id === 'vencido')?.alert).toBe(true);
    expect(r.metrics[0]?.threshold?.value).toBe(1200);
  });
  it('sin caja ni piloto, no inventa esas métricas', () => {
    const r = buildHoyMetrics({ ...base, cashTotal: null, runs: null, forecast: null });
    expect(r.metrics.map((m) => m.id)).toEqual(['vencido', 'por-pagar', 'ventas']);
  });
  it('kpiOf: lo vencido que sube es malo', () => {
    const m = buildHoyMetrics(base).metrics.find((x) => x.id === 'vencido');
    const k = kpiOf(m as NonNullable<typeof m>, TODAY);
    expect(k.value).toBe('$ 100');
    expect(k.spark).toHaveLength(30);
  });
});

describe('la frase', () => {
  const input = {
    today: TODAY,
    currency: 'COP',
    cash: { total: 1000, minimum: 500 },
    forecast: forecast(),
    overdue: { total: 12_740_000, biggest: 'Frigoandes' },
    waiting: 3,
    autopilotDone: 2,
  };
  it('caja bien, deuda y tres cosas resaltadas', () => {
    const parts = narrative(input);
    const t = narrativeText(parts);
    expect(t).toContain('aguanta la nómina del 15 oct');
    expect(t).toContain('Te deben $ 12.740.000 vencido, sobre todo Frigoandes');
    expect(parts.find((p) => p.mark)?.text).toBe('tres cosas');
    expect(t.endsWith('lo demás ya lo estoy moviendo.')).toBe(true);
  });
  it('avisa cuando la caja baja del mínimo', () => {
    const t = narrativeText(narrative({ ...input, cash: { total: 1000, minimum: 900 } }));
    expect(t).toContain('por debajo de tu mínimo');
  });
  it('sin pendientes lo dice sin marcatextos', () => {
    const parts = narrative({ ...input, waiting: 0, autopilotDone: 0, overdue: null });
    expect(parts.some((p) => p.mark)).toBe(false);
    expect(narrativeText(parts)).toContain('No necesito nada de ti');
  });
  it('una cosa va en singular y los saludos siguen la hora', () => {
    expect(narrativeText(narrative({ ...input, waiting: 1 }))).toContain('una cosa');
    expect(countWord(12)).toBe('12');
    expect([greetingFor(8), greetingFor(15), greetingFor(21)]).toEqual([
      'Buenos días',
      'Buenas tardes',
      'Buenas noches',
    ]);
  });
});
