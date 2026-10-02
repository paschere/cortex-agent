import { describe, expect, it } from 'vitest';
import type { DraftItem } from './forecast-shared';
import {
  applyScenario,
  describeAdjustment,
  describeScenario,
  scenarioConditions,
} from './scenario';
import type { Scenario } from './types';

const ctx = { asOf: '2026-10-02', horizonEnd: '2026-12-27', currency: 'COP' };

const item = (over: Partial<DraftItem>): DraftItem => ({
  label: 'x',
  direction: 'in',
  amount: 1_000_000,
  probability: 1,
  expectedDate: '2026-10-20',
  reason: 'vence el 20 oct',
  from: 'movement',
  ...over,
});

const items: DraftItem[] = [
  item({ label: 'Cobro a Nexa', counterpartyName: 'Nexa Logística S.A.S.', amount: 18_000_000 }),
  item({
    label: 'Cobro a Coltrans',
    counterpartyName: 'Coltrans S.A.S.',
    expectedDate: '2026-12-20',
  }),
  item({
    label: 'Nómina',
    direction: 'out',
    amount: 9_400_000,
    category: 'nomina',
    from: 'recurring',
    expectedDate: '2026-10-15',
  }),
];

describe('el escenario en palabras', () => {
  it('cada ajuste se lee después de «Si …»', () => {
    expect(
      describeAdjustment({ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 }),
    ).toBe('Nexa paga 30 días más tarde');
    expect(
      describeAdjustment({ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: -1 }),
    ).toBe('Nexa paga 1 día más temprano');
    expect(describeAdjustment({ kind: 'drop_counterparty', counterpartyName: 'Nexa' })).toBe(
      'se pierde Nexa',
    );
    expect(
      describeAdjustment({
        kind: 'add_recurring',
        label: 'Vendedor nuevo',
        direction: 'out',
        amount: 3_500_000,
        every: 'month',
        start: '2026-11-01',
      }),
    ).toBe('sale un gasto nuevo de $ 3,5 M cada mes el día 1 desde el 1 nov («Vendedor nuevo»)');
    expect(
      describeAdjustment({
        kind: 'add_recurring',
        label: 'Ventas mostrador',
        direction: 'in',
        amount: 800_000,
        every: 'week',
        start: '2026-10-09',
      }),
    ).toBe('entra un ingreso nuevo de $ 800 mil cada viernes desde el 9 oct («Ventas mostrador»)');
    expect(describeAdjustment({ kind: 'scale_category', category: 'nomina', factor: 1.1 })).toBe(
      'Nómina sube 10%',
    );
    expect(
      describeAdjustment({ kind: 'scale_category', category: 'servicios_publicos', factor: 0.8 }),
    ).toBe('Servicios públicos baja 20%');
    expect(
      describeAdjustment({
        kind: 'one_off',
        label: 'Compra camión',
        direction: 'out',
        amount: 20_000_000,
        date: '2026-11-15',
      }),
    ).toBe('sale un pago único de $ 20 M el 15 nov («Compra camión»)');
  });

  it('describeScenario junta las cláusulas en una frase', () => {
    const s: Scenario = {
      id: 's1',
      label: 'Mes difícil',
      adjustments: [
        { kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 },
        { kind: 'scale_category', category: 'nomina', factor: 1.1 },
        { kind: 'drop_counterparty', counterpartyName: 'Coltrans' },
      ],
    };
    expect(describeScenario(s)).toBe(
      'Escenario «Mes difícil»: Nexa paga 30 días más tarde, Nómina sube 10% y se pierde Coltrans.',
    );
    expect(describeScenario(null)).toBe('Sin escenario: la proyección base.');
    expect(describeScenario({ id: 'e', label: 'Vacío', adjustments: [] })).toBe(
      'Escenario «Vacío»: sin cambios sobre la base.',
    );
    expect(scenarioConditions(null)).toBe('');
  });
});

describe('aplicar el escenario', () => {
  it('«Nexa» encuentra a «Nexa Logística S.A.S.» y la corre; lo demás queda igual', () => {
    const out = applyScenario(
      items,
      {
        id: 's',
        label: 'x',
        adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'nexa', days: 30 }],
      },
      ctx,
    );
    expect(out.items[0]?.expectedDate).toBe('2026-11-19');
    expect(out.items[0]?.reason).toContain('Escenario: nexa paga 30 días más tarde.');
    expect(out.items[1]).toEqual(items[1]);
    expect(out.notes).toEqual([]);
    // No muta la entrada.
    expect(items[0]?.expectedDate).toBe('2026-10-20');
  });

  it('adelantar nunca pone algo antes de hoy', () => {
    const out = applyScenario(
      items,
      {
        id: 's',
        label: 'x',
        adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: -60 }],
      },
      ctx,
    );
    expect(out.items[0]?.expectedDate).toBe('2026-10-02');
  });

  it('quitar, escalar, sumar recurrente y pago único', () => {
    const out = applyScenario(
      items,
      {
        id: 's',
        label: 'x',
        adjustments: [
          { kind: 'drop_counterparty', counterpartyName: 'Coltrans' },
          { kind: 'scale_category', category: 'Nómina', factor: 1.1 },
          {
            kind: 'add_recurring',
            label: 'Vendedor',
            direction: 'out',
            amount: 3_000_000,
            every: 'month',
            start: '2026-09-15',
          },
          {
            kind: 'one_off',
            label: 'Multa',
            direction: 'out',
            amount: 1_000_000,
            date: '2026-09-01',
          },
        ],
      },
      ctx,
    );
    expect(out.items.some((i) => i.label === 'Cobro a Coltrans')).toBe(false);
    expect(out.items.find((i) => i.label === 'Nómina')?.amount).toBe(10_340_000);
    // Empezó en septiembre: sólo las del horizonte (15 oct, 15 nov, 15 dic).
    expect(out.items.filter((i) => i.label === 'Vendedor').map((i) => i.expectedDate)).toEqual([
      '2026-10-15',
      '2026-11-15',
      '2026-12-15',
    ]);
    const multa = out.items.find((i) => i.label === 'Multa');
    expect(multa).toMatchObject({ expectedDate: '2026-10-02', from: 'scenario' });
    expect(multa?.reason).toContain('La fecha ya pasó');
  });

  it('semanal desde una fecha pasada arranca en la primera que cae desde hoy', () => {
    const out = applyScenario(
      [],
      {
        id: 's',
        label: 'x',
        adjustments: [
          {
            kind: 'add_recurring',
            label: 'Mostrador',
            direction: 'in',
            amount: 500_000,
            every: 'week',
            start: '2026-09-25',
          },
        ],
      },
      { ...ctx, horizonEnd: '2026-10-25' },
    );
    expect(out.items.map((i) => i.expectedDate)).toEqual([
      '2026-10-02',
      '2026-10-09',
      '2026-10-16',
      '2026-10-23',
    ]);
  });

  it('un ajuste que no encuentra nada lo dice, no falla', () => {
    const out = applyScenario(
      items,
      {
        id: 's',
        label: 'x',
        adjustments: [
          { kind: 'delay_counterparty', counterpartyName: 'Fantasma', days: 10 },
          { kind: 'drop_counterparty', counterpartyName: 'Nadie' },
          { kind: 'scale_category', category: 'mercadeo', factor: 2 },
          { kind: 'one_off', label: 'Lejos', direction: 'in', amount: 1, date: '2027-06-01' },
        ],
      },
      ctx,
    );
    expect(out.items).toHaveLength(3);
    expect(out.notes).toHaveLength(4);
    expect(out.notes[0]).toBe(
      'El escenario corre a «Fantasma», pero no hay nada suyo en la proyección.',
    );
  });

  it('escalar a 0 quita las líneas', () => {
    const out = applyScenario(
      items,
      {
        id: 's',
        label: 'x',
        adjustments: [{ kind: 'scale_category', category: 'nomina', factor: 0 }],
      },
      ctx,
    );
    expect(out.items.some((i) => i.category === 'nomina')).toBe(false);
  });
});
