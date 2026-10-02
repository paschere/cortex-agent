import { forecast } from '@cortex/agent-tools/src/ledger/forecast';
import { AS_OF, company } from '@cortex/agent-tools/src/ledger/forecast.fixtures';
import { detectRecurring } from '@cortex/agent-tools/src/ledger/recurring';
import type { ForecastResult, LedgerMovement } from '@cortex/agent-tools/src/ledger/types';
import { describe, expect, it } from 'vitest';
import {
  PAYROLL_LABEL,
  type PnlMonth,
  ageLabel,
  buildCash,
  buildDue,
  categoryChanges,
  changeText,
  chartScale,
  chartWeeks,
  dashboardHref,
  defaultPnlFocus,
  draftToAdjustment,
  emptyDraft,
  maskPayroll,
  mergeRecurring,
  parseAdjustments,
  parseMoneyInput,
  probabilityText,
  readDashboardParams,
  settle,
  shiftMonth,
} from './dashboard-shape';

describe('cifras para leer', () => {
  it('entiende la plata como se escribe en Colombia', () => {
    expect(parseMoneyInput('48.300.000')).toBe(48_300_000);
    expect(parseMoneyInput('$ 2.500.000')).toBe(2_500_000);
    expect(parseMoneyInput('48,5 M')).toBe(48_500_000);
    expect(parseMoneyInput('950 mil')).toBe(950_000);
    expect(parseMoneyInput('1200000')).toBe(1_200_000);
    expect(parseMoneyInput('1.5')).toBe(2); // un punto suelto es decimal, no miles
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('mucho')).toBeNull();
  });

  it('dice cuánto se cuenta de cada línea', () => {
    expect(probabilityText(1)).toBe('se cuenta completo');
    expect(probabilityText(0.8)).toBe('se cuenta el 80 %');
    expect(probabilityText(0.001)).toBe('se cuenta el 1 %');
  });

  it('dice la edad de un saldo y el cambio de un mes', () => {
    expect(ageLabel('2026-10-02', '2026-10-02')).toBe('hoy');
    expect(ageLabel('2026-10-01T15:00:00Z', '2026-10-02')).toBe('ayer');
    expect(ageLabel('2026-09-22', '2026-10-02')).toBe('hace 10 días');
    expect(ageLabel('2026-06-01', '2026-10-02')).toBe('hace 4 meses');
    expect(changeText(0.12)).toBe('+12 %');
    expect(changeText(-0.08)).toBe('−8 %');
    expect(changeText(null)).toBe('nuevo');
  });

  it('corre meses y escoge cuál mirar', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', -12)).toBe('2025-10');
    expect(defaultPnlFocus('2026-10-02')).toBe('2026-09');
    expect(defaultPnlFocus('2026-10-20')).toBe('2026-10');
  });
});

describe('settle', () => {
  it('nunca rompe: el error queda como «sin dato» con su motivo', async () => {
    await expect(settle(Promise.resolve(3), 'x')).resolves.toEqual({ ok: true, data: 3 });
    await expect(
      settle(() => Promise.reject(new Error('db caída')), 'No se pudo leer.'),
    ).resolves.toEqual({ ok: false, error: 'No se pudo leer.' });
    await expect(
      settle(() => {
        throw new Error('síncrono');
      }, 'No.'),
    ).resolves.toEqual({ ok: false, error: 'No.' });
  });
});

describe('caja hoy', () => {
  it('suma sólo la moneda principal y marca los saldos viejos', () => {
    const cash = buildCash(
      [
        {
          id: 'a',
          name: 'Davivienda',
          currency: 'COP',
          balance: 8_500_000,
          balanceAt: '2026-09-20',
          balanceSource: 'bank',
          sourceSystem: 'Davivienda',
        },
        {
          id: 'b',
          name: 'Bancolombia',
          currency: 'COP',
          balance: 52_000_000,
          balanceAt: '2026-10-01',
          balanceSource: 'manual',
        },
        {
          id: 'c',
          name: 'USD',
          currency: 'usd',
          balance: 12_000,
          balanceAt: '2026-10-01',
          balanceSource: 'accounting',
          sourceSystem: 'Siigo',
        },
      ],
      '2026-10-02',
    );
    expect(cash.total).toBe(60_500_000);
    expect(cash.others).toEqual([{ currency: 'USD', total: 12_000 }]);
    expect(cash.accounts.map((a) => a.name)).toEqual(['Bancolombia', 'Davivienda', 'USD']);
    expect(cash.accounts[0]).toMatchObject({
      age: 'ayer',
      stale: false,
      source: 'Lo dijo una persona',
    });
    expect(cash.accounts[1]).toMatchObject({ stale: true, source: 'Extracto · Davivienda' });
    expect(cash.accounts[2]?.source).toBe('Programa contable · Siigo');
  });
});

function fixtureForecast(): ForecastResult {
  const { accounts, movements } = company();
  return forecast({ asOf: AS_OF, currency: 'COP', accounts, movements, minimumCash: 20_000_000 });
}

describe('la nómina para quien no administra', () => {
  it('funde las líneas de nómina en un total por semana sin cambiar los totales', () => {
    const base = fixtureForecast();
    const masked = maskPayroll(base);
    expect(masked.weeks.map((w) => w.closing)).toEqual(base.weeks.map((w) => w.closing));
    const withPayroll = base.weeks.findIndex((w) => w.items.some((i) => i.category === 'nomina'));
    expect(withPayroll).toBeGreaterThanOrEqual(0);
    const week = masked.weeks[withPayroll];
    const payroll = week?.items.filter((i) => i.category === 'nomina') ?? [];
    expect(payroll).toHaveLength(1);
    expect(payroll[0]?.label).toBe(PAYROLL_LABEL);
    const original = base.weeks[withPayroll]?.items
      .filter((i) => i.category === 'nomina')
      .reduce((s, i) => s + i.expectedAmount, 0);
    expect(payroll[0]?.expectedAmount).toBe(Math.round(original ?? 0));
    // Ningún texto de la semana nombra a una persona ni la quincena.
    expect(JSON.stringify(week)).not.toMatch(/quincena|PILA/i);
  });

  it('esconde las cuentas por pagar de nómina y las cuenta aparte', () => {
    const movements: LedgerMovement[] = [
      {
        id: 'n1',
        direction: 'out',
        kind: 'payable',
        status: 'expected',
        amount: 3_000_000,
        currency: 'COP',
        date: '2026-10-15',
        dueDate: '2026-10-15',
        counterpartyName: 'Juan Pérez',
        category: 'nomina',
        description: 'Salario',
        source: { kind: 'manual', ref: 'n1' },
      },
    ];
    const member = buildDue(movements, '2026-10-02', { isAdmin: false });
    expect(member.payable.parties).toEqual([]);
    expect(member.payrollHidden).toBe(3_000_000);
    const admin = buildDue(movements, '2026-10-02', { isAdmin: true });
    expect(admin.payable.parties[0]?.name).toBe('Juan Pérez');
    expect(admin.payrollHidden).toBe(0);
  });
});

describe('quién me debe', () => {
  it('agrupa por contraparte, por saldo pendiente, con el atraso del más viejo', () => {
    const { movements } = company();
    const due = buildDue(movements, AS_OF, { isAdmin: true });
    const names = due.receivable.parties.map((p) => p.name);
    // «Nexa Logística» y «Nexa Logística S.A.S.»: una sola fila con las dos facturas.
    expect(due.receivable.parties[0]).toMatchObject({
      name: 'Nexa Logística S.A.S.',
      amount: 33_000_000,
      count: 2,
    });
    expect(names.filter((n) => n.startsWith('Nexa'))).toHaveLength(1);
    expect(due.receivable.parties.length).toBeLessThanOrEqual(5);
    const sol = due.receivable.parties.find((p) => p.name.startsWith('Distribuidora El Sol'));
    // FV-1101 (8 M, venció el 15 may) + FV-1190 (saldo 3 M).
    expect(sol).toMatchObject({ amount: 11_000_000, count: 2, nextDue: '2026-05-15' });
    expect(sol?.overdueDays).toBe(140);
    expect(due.receivable.overdue).toBeGreaterThan(0);
    expect(due.payable.parties[0]?.name).toBe('Autonorte S.A.S.');
  });
});

describe('gastos fijos', () => {
  const { movements } = company();
  const detected = detectRecurring(movements, AS_OF);

  it('lo detectado sin decisión queda por confirmar; lo decidido toma su estado', () => {
    const first = detected[0];
    if (!first) throw new Error('la empresa de prueba tiene gastos fijos');
    const rows = mergeRecurring(
      detected,
      [
        { ...first, status: 'ignored' },
        {
          id: 'd1',
          label: 'Contador',
          direction: 'out',
          amount: 1_000_000,
          currency: 'COP',
          every: 'month',
          anchor: 10,
          origin: 'declared',
          status: 'declared',
          detectedKey: null,
        },
        // Confirmado antes, ya no se detecta: igual se muestra.
        {
          id: 'old',
          label: 'Viejo',
          direction: 'out',
          amount: 10,
          currency: 'COP',
          every: 'month',
          anchor: 1,
          origin: 'detected',
          status: 'confirmed',
          detectedKey: 'rec-ya-no',
        },
      ],
      { isAdmin: true },
    );
    expect(rows).toHaveLength(detected.length + 2);
    expect(first.detectedKey).toBeTruthy();
    expect(rows.find((r) => r.key === first.detectedKey)?.status).toBe('ignored');
    expect(rows.at(-1)?.status).toBe('ignored');
    expect(rows.find((r) => r.key === 'd1')?.status).toBe('declared');
    expect(rows.find((r) => r.key === 'old')?.detectedKey).toBe('rec-ya-no');
    expect(rows[0]?.status).toBe('pending');
  });

  it('para quien no administra, la nómina es una sola fila confidencial', () => {
    const rows = mergeRecurring(detected, [], { isAdmin: false });
    const payroll = rows.filter((r) => r.flow.category === 'nomina');
    expect(payroll).toHaveLength(1);
    expect(payroll[0]).toMatchObject({ confidential: true, detectedKey: null });
    expect(payroll[0]?.flow.label).toBe(PAYROLL_LABEL);
  });
});

describe('resultados del mes', () => {
  const month = (m: string, byCategory: Record<string, number>): PnlMonth => ({
    month: m,
    sales: 0,
    otherIncome: 0,
    expenses: Object.values(byCategory).reduce((a, b) => a + b, 0),
    byCategory,
    margin: 0,
  });

  it('compara cada categoría de gasto con el mes anterior y deja fuera los ingresos', () => {
    const rows = categoryChanges(
      month('2026-09', { nomina: 20, arriendo: 10, ventas: 99, software: 5 }),
      month('2026-08', { nomina: 16, arriendo: 10, mercadeo: 3 }),
      { payrollConfidential: true },
    );
    expect(rows.map((r) => r.key)).toEqual(['nomina', 'arriendo', 'software', 'mercadeo']);
    expect(rows[0]).toMatchObject({ label: PAYROLL_LABEL, confidential: true, change: 0.25 });
    expect(rows[1]?.change).toBe(0);
    expect(rows[2]?.change).toBeNull();
    expect(rows[3]).toMatchObject({ amount: 0, change: -1 });
  });
});

describe('el gráfico', () => {
  it('marca la semana más baja y pone el cero dentro de la escala', () => {
    const base = fixtureForecast();
    const weeks = chartWeeks(base, null, 20_000_000);
    expect(weeks).toHaveLength(13);
    expect(weeks.filter((w) => w.lowest)).toHaveLength(1);
    expect(weeks.find((w) => w.lowest)?.start).toBe(base.lowest.week);
    const scale = chartScale(weeks, 20_000_000);
    expect(scale.min).toBeLessThanOrEqual(-Math.max(...weeks.map((w) => w.outflows)));
    expect(scale.max).toBeGreaterThanOrEqual(Math.max(...weeks.map((w) => w.closing)));
    expect(scale.ticks).toContain(0);
  });
});

describe('el armador de escenarios', () => {
  it('convierte cada fila en un ajuste del contrato o dice qué falta', () => {
    const delay = { ...emptyDraft('delay_counterparty', '2026-10-02'), counterparty: 'Nexa' };
    expect(draftToAdjustment(delay)).toEqual({
      ok: true,
      adjustment: { kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 },
    });
    expect(draftToAdjustment(emptyDraft('drop_counterparty', '2026-10-02'))).toMatchObject({
      ok: false,
    });
    const scale = { ...emptyDraft('scale_category', '2026-10-02'), percent: '-15' };
    expect(draftToAdjustment(scale)).toEqual({
      ok: true,
      adjustment: { kind: 'scale_category', category: 'nomina', factor: 0.85 },
    });
    const once = { ...emptyDraft('one_off', '2026-10-02'), label: 'Prima', amount: '12,5 M' };
    expect(draftToAdjustment(once)).toEqual({
      ok: true,
      adjustment: {
        kind: 'one_off',
        label: 'Prima',
        direction: 'out',
        amount: 12_500_000,
        date: '2026-10-16',
      },
    });
  });

  it('el servidor vuelve a revisar lo que llega', () => {
    expect(
      parseAdjustments([{ kind: 'delay_counterparty', counterpartyName: ' Nexa ', days: 30.4 }]),
    ).toEqual([{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 }]);
    expect(() => parseAdjustments([])).toThrow(/al menos un cambio/);
    expect(() => parseAdjustments([{ kind: 'borrar_todo' }])).toThrow(/cambio 1/);
    expect(() =>
      parseAdjustments([{ kind: 'one_off', label: 'x', amount: -5, date: '2026-10-10' }]),
    ).toThrow(/monto/);
  });
});

describe('direcciones', () => {
  it('agrega las opciones sin perder la empresa activa y las vuelve a leer', () => {
    const href = dashboardHref(
      '/finance?workspace=org-1',
      { scenarioId: 'esc-1', includeEstimatedSales: true, minimumCash: 20_000_000 },
      'flujo',
    );
    expect(href).toBe('/finance?workspace=org-1&escenario=esc-1&minimo=20000000#flujo');
    expect(dashboardHref('/finance', { includeEstimatedSales: false })).toBe(
      '/finance?estimadas=0',
    );
    expect(dashboardHref('/finance?workspace=org-1&escenario=x', { scenarioId: null })).toBe(
      '/finance?workspace=org-1',
    );
    expect(readDashboardParams({ escenario: 'esc-1', estimadas: '1', minimo: '20000000' })).toEqual(
      { scenarioId: 'esc-1', includeEstimatedSales: true, minimumCash: 20_000_000 },
    );
    expect(readDashboardParams({ escenario: '../x', estimadas: '0', minimo: 'nada' })).toEqual({
      scenarioId: null,
      includeEstimatedSales: false,
      minimumCash: null,
    });
  });
});
