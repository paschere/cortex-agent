import { describe, expect, it } from 'vitest';
import {
  LINES_KEY,
  checkLines,
  normalizeLines,
  parseLinesValue,
  serializeLines,
} from './form-lines';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('form-lines', () => {
  it('la llave reservada no es un campo posible', () => {
    expect(LINES_KEY.startsWith('__')).toBe(true);
  });

  it('ida y vuelta por JSON', () => {
    const lines = [{ item: { id: A, label: 'Taladro' }, qty: 2 }];
    expect(parseLinesValue(serializeLines(lines))).toEqual(lines);
    expect(parseLinesValue('')).toEqual([]);
    expect(parseLinesValue(undefined)).toEqual([]);
  });

  it('rechaza lo que no es una lista de líneas', () => {
    expect(parseLinesValue('{')).toBeNull();
    expect(parseLinesValue('{"a":1}')).toBeNull();
    expect(parseLinesValue('[{"item":{"id":"no-uuid"},"qty":1}]')).toBeNull();
    expect(parseLinesValue(`[{"item":{"id":"${A}"},"qty":"x"}]`)).toBeNull();
  });

  it('suma el mismo ítem repetido y quita ceros', () => {
    const out = normalizeLines([
      { item: { id: A, label: 'Taladro' }, qty: 1 },
      { item: { id: B, label: 'Sierra' }, qty: 0 },
      { item: { id: A, label: 'Taladro' }, qty: 2 },
    ]);
    expect(out).toEqual([{ item: { id: A, label: 'Taladro' }, qty: 3 }]);
  });

  it('valida mínimo, máximo y cantidades', () => {
    const one = [{ item: { id: A, label: 'Taladro' }, qty: 1 }];
    expect(checkLines([], { min: 1, title: 'Equipos' })).toMatch(/al menos un ítem/);
    expect(checkLines(one, { max: 0 })).toMatch(/máximo/);
    expect(checkLines([{ ...one[0]!, qty: -1 }])).toMatch(/mayor que cero/);
    expect(checkLines([{ ...one[0]!, qty: 1.5 }])).toMatch(/entero/);
    expect(checkLines([{ ...one[0]!, qty: 1.5 }], { decimals: true })).toBeNull();
    expect(checkLines(one, { min: 1 })).toBeNull();
  });
});
