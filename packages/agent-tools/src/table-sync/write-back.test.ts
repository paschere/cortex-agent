import { describe, expect, it } from 'vitest';
import { columnLetter, planSheetWrite } from './write-back-shape';

const sheet = [
  ['Vuelos de hoy'],
  ['flight', 'date', 'status', 'nota'],
  ['AV9', '2026-10-21', 'active', ''],
  ['LA40', '2026-10-21', 'landed', ''],
  ['AV9', '2026-10-22', 'scheduled', ''],
];
const mapping = { vuelo: 'flight', fecha: 'date', estado: 'status' };

describe('escritura de vuelta a una hoja', () => {
  it('letras de columna', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
  });

  it('encuentra la fila por su clave y la celda por su encabezado, aunque el título esté encima', () => {
    const plan = planSheetWrite({
      sheet,
      mapping,
      keyFields: ['vuelo', 'fecha'],
      rowValues: { vuelo: 'av9', fecha: '2026-10-22', estado: 'scheduled' },
      changes: { estado: 'cancelled' },
    });
    expect(plan).toEqual({
      ok: true,
      rowNumber: 5,
      cells: [{ a1: 'C5', header: 'status', value: 'cancelled' }],
    });
  });

  it('si la fila ya no está, no escribe nada', () => {
    const plan = planSheetWrite({
      sheet,
      mapping,
      keyFields: ['vuelo', 'fecha'],
      rowValues: { vuelo: 'IB1', fecha: '2026-10-21' },
      changes: { estado: 'x' },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain('No escribí nada');
  });

  it('si la clave está repetida en la hoja, no adivina', () => {
    const plan = planSheetWrite({
      sheet: [...sheet, ['AV9', '2026-10-22', 'x', '']],
      mapping,
      keyFields: ['vuelo', 'fecha'],
      rowValues: { vuelo: 'AV9', fecha: '2026-10-22' },
      changes: { estado: 'x' },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain('2 filas iguales');
  });

  it('si la hoja cambió de columnas, avisa', () => {
    const plan = planSheetWrite({
      sheet: [
        ['otra', 'cosa'],
        ['1', '2'],
      ],
      mapping,
      keyFields: ['vuelo'],
      rowValues: { vuelo: 'AV9' },
      changes: { estado: 'x' },
    });
    expect(plan.ok).toBe(false);
  });
});
