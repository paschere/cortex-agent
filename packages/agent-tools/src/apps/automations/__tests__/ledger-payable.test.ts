import { describe, expect, it } from 'vitest';
import type { Values } from '../match';
import { buildPayablePlan } from '../ledger-payable';
import { automationActionSchema, automationInputSchema, structuralProblems } from '../spec';

/** ledger_payable: la forma de la acción y el borrador puro que arma (sin base). */

const action = (over: Record<string, unknown> = {}) =>
  automationActionSchema.parse({
    type: 'ledger_payable',
    amount: 'costo',
    counterparty: '{{proveedor}}',
    description: 'Equipo {{equipo}}',
    ...over,
  });
type Payable = ReturnType<typeof action> & { type: 'ledger_payable' };
const at = { appSlug: 'cargo', trackerSlug: 'equipos_usados', rowId: 'row-1', userId: 'u1', today: '2026-10-28' };
const ctx = (after: Record<string, unknown>) => ({ after: after as Values });

describe('ledger_payable: la forma', () => {
  it('pone los defaults: COP, 30 días, proveedores', () => {
    const a = action() as Payable;
    expect(a.currency).toBe('COP');
    expect(a.dueDays).toBe(30);
    expect(a.category).toBe('proveedores');
  });
  it('rechaza moneda, días y categoría inválidos', () => {
    expect(() => action({ currency: 'cop' })).toThrow();
    expect(() => action({ dueDays: 181 })).toThrow();
    expect(() => action({ dueDays: -1 })).toThrow();
    expect(() => action({ category: 'inventada' })).toThrow();
  });
  it('un horario o un botón no tiene fila de donde sacar el costo', () => {
    const input = automationInputSchema.parse({
      name: 'x',
      trigger: { type: 'schedule', cadence: 'daily', hour: 7 },
      actions: [action()],
    });
    expect(structuralProblems(input).join(' ')).toContain('fila de partida');
    const ok = automationInputSchema.parse({
      name: 'x',
      trigger: { type: 'row_created', tracker: 'equipos_usados' },
      actions: [action()],
    });
    expect(structuralProblems(ok)).toEqual([]);
  });
});

describe('ledger_payable: el borrador', () => {
  it('es un por pagar esperado, de salida, con vencimiento a dueDays', () => {
    const plan = buildPayablePlan(
      action({ date: 'fecha', dueDays: 15, category: 'transporte' }) as Payable,
      ctx({ costo: 1_500_000, proveedor: ' Aero  Servicios ', equipo: 'Montacargas', fecha: '2026-10-20' }),
      at,
    );
    expect(plan.amount).toBe(1_500_000);
    expect(plan.draft).toMatchObject({
      direction: 'out',
      kind: 'payable',
      status: 'expected',
      amount: 1_500_000,
      outstanding: 1_500_000,
      currency: 'COP',
      date: '2026-10-20',
      dueDate: '2026-11-04',
      counterpartyName: 'Aero Servicios',
      description: 'Equipo Montacargas',
      category: 'transporte',
      recordedBy: 'u1',
    });
  });
  it('la identidad es la app y la fila: editar la fila da la MISMA referencia', () => {
    const a = action() as Payable;
    const one = buildPayablePlan(a, ctx({ costo: 100, proveedor: 'A' }), at).draft.source;
    const two = buildPayablePlan(a, ctx({ costo: 999, proveedor: 'B' }), at).draft.source;
    expect(one).toEqual(two);
    expect(one).toMatchObject({ kind: 'sheet', system: 'app:cargo' });
    expect(one.ref).toContain('equipos_usados:row-1');
    expect(buildPayablePlan(a, ctx({ costo: 100 }), { ...at, rowId: 'row-2' }).draft.source.ref).not.toBe(one.ref);
  });
  it('sin campo de fecha (o vacío) usa hoy en Bogotá', () => {
    const plan = buildPayablePlan(action({ date: 'fecha' }) as Payable, ctx({ costo: 5, fecha: '' }), at);
    expect(plan.draft.date).toBe('2026-10-28');
    expect(plan.draft.dueDate).toBe('2026-11-27');
  });
  it('lee el valor como lo guarda la tabla ($ 1.500.000) y lo vacío o <= 0 no es valor', () => {
    const a = action() as Payable;
    expect(buildPayablePlan(a, ctx({ costo: '$ 1.500.000' }), at).amount).toBe(1_500_000);
    for (const costo of [undefined, '', 0, -5, 'nada'])
      expect(buildPayablePlan(a, ctx({ costo }), at).amount).toBeNull();
  });
});
