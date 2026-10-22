import type { ForecastResult, LedgerMovement } from '@cortex/agent-tools/src/ledger/types';
import type { CarteraModel } from '@cortex/agent-tools/src/payments/cartera';
import { buildCartera } from '@cortex/agent-tools/src/payments/cartera';
import { describe, expect, it } from 'vitest';
import {
  type DianInvoiceRow,
  type StatementRow,
  buildDian,
  buildFlow,
  buildOperation,
  buildReceivable,
  buildResult,
  buildWeekCards,
  collectionsWeek,
  dianStateOf,
  flowTotals,
  hasInsights,
  payablesWeek,
  ratioOf,
} from './insights';

const TODAY = '2026-10-21';

describe('ratioOf', () => {
  it('no inventa cambios sin base', () => {
    expect(ratioOf(10, 0)).toBeNull();
    expect(ratioOf(10, null)).toBeNull();
    expect(ratioOf(120, 100)).toBeCloseTo(0.2);
    expect(ratioOf(50, -100)).toBeCloseTo(1.5);
  });
});

describe('dianStateOf', () => {
  it('lee el estado como lo escribe Siigo, con o sin tildes', () => {
    expect(dianStateOf('Aceptada')).toBe('accepted');
    expect(dianStateOf('Aceptada con observaciones')).toBe('accepted');
    expect(dianStateOf('Rechazada')).toBe('rejected');
    expect(dianStateOf('Error en validación')).toBe('rejected');
    expect(dianStateOf('En proceso')).toBe('pending');
    expect(dianStateOf('')).toBeNull();
    expect(dianStateOf(null)).toBeNull();
  });
});

const inv = (p: Partial<DianInvoiceRow> & { numero: string }): DianInvoiceRow => ({
  cliente: 'Cliente',
  total: 1000,
  fecha: '2026-10-01',
  estado: 'Vencida',
  factura_electronica: 'Aceptada',
  ...p,
});

describe('buildDian', () => {
  it('cuenta por estado, deja primero las rechazadas y no cuenta las anuladas', () => {
    const d = buildDian([
      inv({ numero: 'A' }),
      inv({ numero: 'B', factura_electronica: 'En proceso', fecha: '2026-10-20' }),
      inv({
        numero: 'C',
        factura_electronica: 'Rechazada',
        fecha: '2026-10-02',
        mensaje_dian: ' NIT mal ',
      }),
      inv({ numero: 'D', factura_electronica: 'Rechazada', estado: 'Anulada' }),
      inv({ numero: 'E', factura_electronica: '' }),
    ]);
    expect(d).toMatchObject({ accepted: 1, rejected: 1, pending: 1, total: 3 });
    expect(d?.problems.map((p) => p.number)).toEqual(['C', 'B']);
    expect(d?.problems[0]?.message).toBe('NIT mal');
  });
  it('sin facturas con estado, nada', () => {
    expect(buildDian([inv({ numero: 'A', factura_electronica: '' })])).toBeNull();
    expect(buildDian([])).toBeNull();
  });
});

const mv = (p: Partial<LedgerMovement> & Pick<LedgerMovement, 'id'>): LedgerMovement =>
  ({
    direction: 'out',
    kind: 'payable',
    status: 'expected',
    currency: 'COP',
    amount: 1000,
    date: '2026-10-01',
    description: p.id,
    source: { kind: 'manual', ref: p.id },
    ...p,
  }) as LedgerMovement;

describe('payablesWeek', () => {
  const ms = [
    mv({ id: 'hoy', dueDate: TODAY, amount: 100 }),
    mv({ id: 'dia6', dueDate: '2026-10-27', amount: 200 }),
    mv({ id: 'dia7', dueDate: '2026-10-28', amount: 400 }),
    mv({ id: 'vencido', dueDate: '2026-10-10', amount: 800, outstanding: 500 }),
    mv({ id: 'pagado', status: 'settled', dueDate: TODAY, amount: 9999 }),
    mv({ id: 'cobro', direction: 'in', kind: 'receivable', dueDate: TODAY, amount: 7777 }),
    mv({ id: 'nomina', kind: 'expense', category: 'nomina', dueDate: TODAY, amount: 3000 }),
    mv({ id: 'usd', currency: 'USD', dueDate: TODAY, amount: 5 }),
  ];
  it('suma 7 días y aparta lo vencido (con su saldo pendiente)', () => {
    expect(payablesWeek(ms, TODAY, true)).toEqual({
      week: 3300,
      weekCount: 3,
      overdue: 500,
      overdueCount: 1,
    });
  });
  it('a quien no administra no se le suma la nómina', () => {
    expect(payablesWeek(ms, TODAY, false)).toMatchObject({ week: 300, weekCount: 2 });
  });
});

function carteraFixture(): CarteraModel {
  return buildCartera({
    today: TODAY,
    defaultTermDays: 30,
    termDays: {},
    invoices: [
      {
        id: 'i1',
        kind: 'accounting',
        docNumber: 'FV-1',
        clientKey: 'c1',
        clientName: 'Cliente Uno',
        issuedOn: '2026-08-01',
        dueOn: '2026-08-31',
        total: 1000,
        balance: 1000,
      },
      {
        id: 'i2',
        kind: 'accounting',
        docNumber: 'FV-2',
        clientKey: 'c2',
        clientName: 'Cliente Dos',
        issuedOn: '2026-10-01',
        dueOn: '2026-10-24',
        total: 600,
        balance: 600,
      },
      {
        id: 'i3',
        kind: 'accounting',
        docNumber: 'FV-3',
        clientKey: 'c2',
        clientName: 'Cliente Dos',
        issuedOn: '2026-10-05',
        dueOn: '2026-11-20',
        total: 300,
        balance: 300,
      },
    ] as never,
    payments: [],
  });
}

describe('cartera → tarjetas y bloque', () => {
  const cartera = carteraFixture();
  it('collectionsWeek cuenta lo que vence de hoy a 6 días', () => {
    expect(collectionsWeek(cartera, TODAY)).toMatchObject({ amount: 600, count: 1 });
  });
  it('buildReceivable ordena clientes y reparte la antigüedad', () => {
    const r = buildReceivable(cartera);
    expect(r?.total).toBe(1900);
    expect(r?.overdue).toBe(1000);
    expect(r?.clients[0]).toMatchObject({ name: 'Cliente Uno', overdue: 1000 });
    expect(r?.aging.reduce((s, a) => s + a.amount, 0)).toBe(1900);
    expect(r?.href).toBe('/payments');
  });
  it('buildReceivable dice de qué orígenes sale lo que te deben y lo que no cuadra', () => {
    const r = buildReceivable({
      ...cartera,
      sources: {
        differences: [{ message: 'FV-1 vale distinto', number: 'FV-1' }],
        differenceCount: 2,
        issues: [],
        issueCount: 3,
        rejectedCount: 3,
        sheetCount: 1,
        overlaps: 4,
      },
    });
    expect(r?.sources.reduce((s, o) => s + o.amount, 0)).toBe(1900);
    expect(r?.differenceCount).toBe(2);
    expect(r?.rejectedCount).toBe(3);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
  it('sin deuda no hay bloque', () => {
    expect(buildReceivable(buildCartera({ today: TODAY, invoices: [], payments: [] }))).toBeNull();
  });
  it('buildWeekCards arma las cuatro y cada una lleva su pantalla', () => {
    const dian = buildDian([inv({ numero: 'C', factura_electronica: 'Rechazada' })]);
    const cards = buildWeekCards({
      today: TODAY,
      currency: 'COP',
      cartera,
      defaultTermDays: 30,
      movements: [mv({ id: 'p', dueDate: TODAY, amount: 50 })],
      isAdmin: true,
      dian,
    });
    expect(cards.map((c) => c.id)).toEqual(['vencido', 'entra', 'paga', 'dian']);
    expect(cards.map((c) => c.href)).toEqual([
      '/payments',
      '/payments',
      '/pagar',
      '/trackers/siigo_facturas',
    ]);
    expect(cards[0]).toMatchObject({ value: 1000, alert: true, fmt: 'money' });
    expect(cards[3]).toMatchObject({ value: 1, alert: true, fmt: 'count' });
    // Todo serializable: ni funciones ni undefined colados.
    expect(JSON.parse(JSON.stringify(cards))).toEqual(cards);
  });
  it('sin cartera ni DIAN solo queda lo que hay', () => {
    const cards = buildWeekCards({
      today: TODAY,
      currency: 'COP',
      cartera: null,
      defaultTermDays: null,
      movements: [],
      isAdmin: true,
      dian: null,
    });
    expect(cards.map((c) => c.id)).toEqual(['paga']);
    expect(cards[0]?.hint).toBe('Ningún pago vence en 7 días');
  });
});

function forecast(): ForecastResult {
  const week = (start: string, opening: number, inflows: number, outflows: number) => ({
    start,
    opening,
    inflows,
    outflows,
    closing: opening + inflows - outflows,
    items: [
      {
        label: 'Cobro',
        direction: 'in' as const,
        amount: inflows,
        expectedAmount: inflows * 0.8,
        probability: 0.8,
        expectedDate: start,
        reason: '',
        counterpartyName: 'Nexa',
      },
      {
        label: 'Pago',
        direction: 'out' as const,
        amount: outflows,
        expectedAmount: outflows,
        probability: 1,
        expectedDate: start,
        reason: '',
      },
    ],
  });
  return {
    asOf: TODAY,
    currency: 'COP',
    startingCash: 1000,
    weeks: [
      week('2026-10-19', 1000, 500, 800),
      week('2026-10-26', 700, 300, 900),
      week('2026-11-02', 100, 900, 100),
    ],
    lowest: { week: '2026-10-26', closing: 100 },
    alerts: [],
    assumptions: [],
    minimumCash: 0,
  } as unknown as ForecastResult;
}

describe('buildFlow', () => {
  it('semana a semana, con rango probable y lo que más pesa', () => {
    const f = buildFlow(forecast(), 300);
    expect(f?.weeks).toHaveLength(3);
    expect(f?.weeks[0]).toMatchObject({
      label: '19 oct',
      inflow: 500,
      outflow: 800,
      closing: 700,
      lo: 600,
      hi: 700,
    });
    expect(f?.weeks[0]?.top.map((t) => t.label)).toEqual(['Nexa', 'Pago']);
    expect(f?.lowest).toMatchObject({ start: '2026-10-26', closing: 100 });
    expect(f?.minimum).toBe(300);
    expect(buildFlow(forecast(), 0)?.minimum).toBeNull();
  });
  it('flowTotals suma las primeras n', () => {
    const f = buildFlow(forecast(), null);
    if (!f) throw new Error('sin flujo');
    expect(flowTotals(f, 2)).toEqual({ inflow: 800, outflow: 1700, net: -900, closing: 100 });
  });
  it('sin semanas no hay gráfico', () => {
    expect(buildFlow({ ...forecast(), weeks: [] }, null)).toBeNull();
  });
});

const st = (periodo: string, renglon: string, valor: number, live = false): StatementRow => ({
  periodo,
  estado: 'Estado de resultados',
  seccion: 'Resumen',
  renglon,
  valor,
  en_curso: live ? 'Sí' : 'No',
});

describe('buildResult', () => {
  const rows: StatementRow[] = [
    st('2025-10', 'Ventas', 400),
    st('2025-10', 'Utilidad neta', 40),
    st('2026-08', 'Ventas', 500),
    st('2026-08', 'Utilidad neta', -50),
    st('2026-09', 'Ventas', 800),
    st('2026-09', 'Otros ingresos', 20),
    st('2026-09', 'Utilidad neta', 200),
    st('2026-10', 'Ventas', 600, true),
    st('2026-10', 'Utilidad neta', 300, true),
    { ...st('2026-10', 'Ventas', 1), estado: 'Balance general' },
  ];
  it('ingresos, gastos y utilidad cuadran y se compara contra el mes anterior y el año pasado', () => {
    const r = buildResult(rows, TODAY);
    expect(r?.monthName).toBe('octubre');
    expect(r?.current).toMatchObject({ income: 600, profit: 300, expenses: 300, inProgress: true });
    expect(r?.prev).toMatchObject({ month: '2026-09', income: 820, expenses: 620 });
    expect(r?.incomeVsPrev).toBeCloseTo(600 / 820 - 1);
    expect(r?.yearAgo?.month).toBe('2025-10');
    expect(r?.incomeVsYear).toBeCloseTo(0.5);
    // No hay cifras antes de agosto de 2026 salvo el año pasado: la serie arranca en agosto.
    expect(r?.months.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
  });
  it('sin cifras del año pasado no inventa la comparación', () => {
    const r = buildResult(
      rows.filter((x) => x.periodo !== '2025-10'),
      TODAY,
    );
    expect(r?.yearAgo).toBeNull();
    expect(r?.incomeVsYear).toBeNull();
  });
  it('si el mes en curso aún no tiene cifras, mira el último con datos', () => {
    const r = buildResult(
      rows.filter((x) => x.periodo !== '2026-10'),
      TODAY,
    );
    expect(r?.current.month).toBe('2026-09');
  });
  it('sin estados no hay bloque', () => {
    expect(buildResult([], TODAY)).toBeNull();
    expect(buildResult([st('2026-10', 'Ventas', 0, true)], TODAY)).toBeNull();
  });
});

describe('buildOperation', () => {
  it('cuenta vuelos por llegar, aterrizados, demorados y sin cerrar', () => {
    const op = buildOperation({
      today: TODAY,
      flights: [
        { fecha: TODAY, estado: 'Aterrizó', numero_vuelo: 'av1', aerolinea: 'Avianca' },
        { fecha: '2026-10-22', estado: 'Programado', numero_vuelo: 'm6', aerolinea: 'Amerijet' },
        { fecha: '2026-10-23', estado: 'Demorado', numero_vuelo: 'k4', aerolinea: 'Kalitta' },
        { fecha: '2026-10-15', estado: 'Programado', numero_vuelo: 'cks' },
        { fecha: '2026-10-16', estado: 'Aterrizó' },
        { fecha: '', estado: 'Programado' },
      ],
      prealertDays: null,
    });
    expect(op?.flights).toMatchObject({
      today: 1,
      landedToday: 1,
      landedWeek: 2,
      upcoming: 2,
      delayed: 1,
      stale: 1,
    });
    expect(op?.flights?.next.map((n) => [n.label, n.when, n.late])).toEqual([
      ['M6', 'mañana', false],
      ['K4', '23 oct', true],
    ]);
    expect(op?.prealerts).toBeNull();
  });
  it('prealertas: 14 días y la última que llegó', () => {
    const op = buildOperation({
      today: TODAY,
      flights: null,
      prealertDays: ['2026-10-15', '2026-10-15', '2026-10-20', TODAY],
    });
    expect(op?.prealerts).toMatchObject({ today: 1, week: 4, last: 'hoy' });
    expect(op?.prealerts?.spark).toHaveLength(14);
    expect(op?.prealerts?.spark.at(-1)).toBe(1);
  });
  it('sin tablas no hay bloque', () => {
    expect(buildOperation({ today: TODAY, flights: [], prealertDays: [] })).toBeNull();
    expect(buildOperation({ today: TODAY, flights: null, prealertDays: null })).toBeNull();
  });
});

describe('hasInsights', () => {
  it('es falso sin nada que mostrar', () => {
    expect(hasInsights(undefined)).toBe(false);
    expect(
      hasInsights({
        currency: 'COP',
        week: [],
        flow: null,
        result: null,
        receivable: null,
        dian: null,
        operation: null,
      }),
    ).toBe(false);
  });
});
