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

  describe('los tipos longtext, checkbox y time', () => {
    const base = { key: 'campo', label: 'Campo', required: false };

    it('se aceptan como tipos de campo', () => {
      for (const type of ['longtext', 'checkbox', 'time'] as const)
        expect(trackerFieldsSchema.safeParse([{ ...base, type }]).success).toBe(true);
    });

    it('longtext admite saltos de línea y más largo que un texto corto', () => {
      const long = { ...base, type: 'longtext' as const };
      const text = 'a\nb'.padEnd(1500, 'x');
      expect(coerceValue(long, text)).toEqual({ ok: true, value: text });
      expect(coerceValue({ ...base, type: 'text' as const }, text).ok).toBe(false);
      expect(coerceValue(long, 'x'.repeat(4001)).ok).toBe(false);
    });

    it('checkbox guarda 1/0 y entiende sí/no, true/false y booleanos', () => {
      const box = { ...base, type: 'checkbox' as const };
      expect(coerceValue(box, true)).toEqual({ ok: true, value: 1 });
      expect(coerceValue(box, false)).toEqual({ ok: true, value: 0 });
      expect(coerceValue(box, 'Sí')).toEqual({ ok: true, value: 1 });
      expect(coerceValue(box, 'no')).toEqual({ ok: true, value: 0 });
      expect(coerceValue(box, '0')).toEqual({ ok: true, value: 0 });
      expect(coerceValue(box, 'quizás').ok).toBe(false);
    });

    it('time acepta HH:MM, completa el cero y rechaza horas imposibles', () => {
      const t = { ...base, type: 'time' as const };
      expect(coerceValue(t, '08:05')).toEqual({ ok: true, value: '08:05' });
      expect(coerceValue(t, '8:05')).toEqual({ ok: true, value: '08:05' });
      expect(coerceValue(t, '23:59').ok).toBe(true);
      expect(coerceValue(t, '24:00').ok).toBe(false);
      expect(coerceValue(t, '12:60').ok).toBe(false);
      expect(coerceValue(t, '12h30').ok).toBe(false);
    });

    it('vacío no obligatorio queda vacío; obligatorio avisa', () => {
      expect(coerceValue({ ...base, type: 'time' as const }, '')).toEqual({ ok: true, value: '' });
      expect(coerceValue({ ...base, required: true, type: 'checkbox' as const }, '').ok).toBe(
        false,
      );
    });
  });
});
