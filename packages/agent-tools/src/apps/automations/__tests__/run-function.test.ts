import { describe, expect, it } from 'vitest';
import { automationActionSchema, automationInputSchema, structuralProblems } from '../spec';

/** run_function: la forma de la acción y sus reglas estructurales (sin base ni Sandbox). */

const action = (over: Record<string, unknown> = {}) =>
  automationActionSchema.parse({ type: 'run_function', name: 'cobrar', role: 'operario', ...over });

describe('run_function: la forma', () => {
  it('el rol es obligatorio (nunca un administrador implícito)', () => {
    expect(() => automationActionSchema.parse({ type: 'run_function', name: 'cobrar' })).toThrow();
  });
  it('pone defaults: sin datos y sin fila', () => {
    const a = action() as { input: object; withRow: boolean };
    expect(a.input).toEqual({});
    expect(a.withRow).toBe(false);
  });
  it('valida el nombre de la función y las llaves de la entrada', () => {
    expect(() => action({ name: 'Cobrar' })).toThrow();
    expect(() => action({ name: 'x' })).toThrow();
    expect(() => action({ input: { 'con espacio': 'x' } })).toThrow();
    expect(() => action({ input: { a: { anidado: 1 } } })).toThrow();
    expect(() =>
      action({ input: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'x'])) }),
    ).toThrow();
    expect(action({ input: { guia: '{{guia}}', n: 2, ok: true } })).toBeTruthy();
  });
  it('no corre como administrador', () => {
    const input = automationInputSchema.parse({
      name: 'x',
      trigger: { type: 'row_created', tracker: 'guias' },
      actions: [action({ role: 'administrador' })],
    });
    expect(structuralProblems(input).join(' ')).toContain('administrador');
  });
  it('un horario corre la función sin fila, pero no puede pasarle la fila', () => {
    const schedule = { type: 'schedule', cadence: 'daily', hour: 7 };
    const ok = automationInputSchema.parse({ name: 'x', trigger: schedule, actions: [action()] });
    expect(structuralProblems(ok)).toEqual([]);
    const bad = automationInputSchema.parse({
      name: 'x',
      trigger: schedule,
      actions: [action({ withRow: true })],
    });
    expect(structuralProblems(bad).join(' ')).toContain('fila de partida');
  });
});
