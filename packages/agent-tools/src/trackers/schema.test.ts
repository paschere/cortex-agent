import { describe, expect, it } from 'vitest';
import { coerceValue, rowLabel, trackerFieldsSchema, trackerSlugSchema } from './schema';

const plate = {
  key: 'placa',
  label: 'Placa',
  type: 'text' as const,
  required: true,
};

describe('el esquema de una tabla inventada', () => {
  it('acepta un slug estable y rechaza uno con mayúsculas', () => {
    expect(trackerSlugSchema.safeParse('contenedores').success).toBe(true);
    expect(trackerSlugSchema.safeParse('Contenedores').success).toBe(false);
    expect(trackerSlugSchema.safeParse('a').success).toBe(false);
  });

  it('exige opciones en un select y claves únicas', () => {
    expect(
      trackerFieldsSchema.safeParse([
        { key: 'estado', label: 'Estado', type: 'select', required: true, options: ['abierto'] },
      ]).success,
    ).toBe(true);
    expect(
      trackerFieldsSchema.safeParse([{ key: 'estado', label: 'Estado', type: 'select' }]).success,
    ).toBe(false);
    expect(
      trackerFieldsSchema.safeParse([
        { key: 'placa', label: 'Placa', type: 'text' },
        { key: 'placa', label: 'Otra', type: 'text' },
      ]).success,
    ).toBe(false);
  });

  it('convierte un número escrito como texto y rechaza una fecha rota', () => {
    const amount = { key: 'valor', label: 'Valor', type: 'money' as const, required: true };
    expect(coerceValue(amount, '1200000')).toEqual({ ok: true, value: 1_200_000 });
    const when = { key: 'vence', label: 'Vence', type: 'date' as const, required: true };
    expect(coerceValue(when, '2026-08-18').ok).toBe(true);
    expect(coerceValue(when, '18/08/2026').ok).toBe(false);
  });

  it('nombra la fila con el primer texto, no con el id', () => {
    expect(rowLabel([plate], { placa: 'ABC123' })).toBe('ABC123');
    expect(rowLabel([plate], { placa: 'ABC123' }, 'La de Ana')).toBe('La de Ana');
  });
});
