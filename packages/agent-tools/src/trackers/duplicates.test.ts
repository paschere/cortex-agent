import { describe, expect, it } from 'vitest';
import {
  type DuplicateInputRow,
  type DuplicateRule,
  computeDuplicateFlags,
  duplicateMessage,
  normalizeDuplicateKey,
  validateDuplicateRule,
} from './duplicates';
import type { TrackerField } from './schema';

const rule: DuplicateRule = {
  key: 'numero_guia',
  distinctBy: 'fecha',
  flagField: 'estado',
  flagValue: 'Duplicada',
};

const fields: TrackerField[] = [
  { key: 'numero_guia', label: 'Número de guía', type: 'text', required: true },
  { key: 'fecha', label: 'Fecha', type: 'date', required: false },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    required: false,
    options: ['Recibida', 'Duplicada'],
  },
];

const row = (
  id: string,
  guia: string,
  fecha: string,
  extra: Record<string, unknown> = {},
  flagged = false,
): DuplicateInputRow => ({
  id,
  values: { numero_guia: guia, fecha, ...extra },
  flagged,
});

describe('normalizeDuplicateKey', () => {
  it('ignora mayúsculas, espacios, guiones y tildes', () => {
    expect(normalizeDuplicateKey(' 045-1234 5678 ')).toBe('04512345678');
    expect(normalizeDuplicateKey('av-204')).toBe('AV204');
    expect(normalizeDuplicateKey(undefined)).toBe('');
  });
});

describe('computeDuplicateFlags', () => {
  it('marca TODAS las filas de una guía repetida con fecha distinta', () => {
    const d = computeDuplicateFlags(rule, [
      row('a', '045-1234', '2026-03-01'),
      row('b', '0451234', '2026-03-04'),
      row('c', '999-0000', '2026-03-01'),
    ]);
    expect(d.flag.sort()).toEqual(['a', 'b']);
    expect(d.unflag).toEqual([]);
    expect(d.conflicts.find((c) => c.rowId === 'a')?.others).toEqual(['2026-03-04']);
    expect(d.conflicts.find((c) => c.rowId === 'b')?.others).toEqual(['2026-03-01']);
  });

  it('la misma guía con la misma fecha no es conflicto', () => {
    const d = computeDuplicateFlags(rule, [
      row('a', '045-1234', '2026-03-01'),
      row('b', '045-1234', '2026-03-01'),
    ]);
    expect(d.flag).toEqual([]);
    expect(d.conflicts).toEqual([]);
  });

  it('sin distinctBy cualquier repetición cuenta', () => {
    const d = computeDuplicateFlags({ ...rule, distinctBy: undefined }, [
      row('a', 'X1', '2026-03-01'),
      row('b', 'X1', '2026-03-01'),
    ]);
    expect(d.flag.sort()).toEqual(['a', 'b']);
  });

  it('al corregir la fecha quita la marca que puso la regla', () => {
    const marked = { estado: 'Duplicada' };
    const d = computeDuplicateFlags(rule, [
      row('a', '045-1234', '2026-03-04', marked, true),
      row('b', '045-1234', '2026-03-04', marked, true),
    ]);
    expect(d.flag).toEqual([]);
    expect(d.unflag.sort()).toEqual(['a', 'b']);
  });

  it('no desmarca un «Duplicada» que puso una persona', () => {
    const d = computeDuplicateFlags(rule, [
      row('a', 'Z9', '2026-03-04', { estado: 'Duplicada' }, false),
    ]);
    expect(d.unflag).toEqual([]);
  });

  it('vuelve a marcar si alguien cambió el estado mientras el conflicto sigue', () => {
    const d = computeDuplicateFlags(rule, [
      row('a', 'G1', '2026-03-01', { estado: 'Recibida' }, true),
      row('b', 'G1', '2026-03-02', { estado: 'Duplicada' }, true),
    ]);
    expect(d.flag).toEqual(['a']);
  });

  it('con `only` sólo toca las guías indicadas', () => {
    const rows = [
      row('a', 'G1', '2026-03-01'),
      row('b', 'G1', '2026-03-02'),
      row('c', 'G2', '2026-03-01'),
      row('d', 'G2', '2026-03-02'),
    ];
    const d = computeDuplicateFlags(rule, rows, new Set(['G1']));
    expect(d.flag.sort()).toEqual(['a', 'b']);
  });

  it('ignora filas sin clave', () => {
    const d = computeDuplicateFlags(rule, [row('a', '', '2026-03-01'), row('b', '', '2026-03-02')]);
    expect(d.flag).toEqual([]);
  });
});

describe('validateDuplicateRule', () => {
  it('acepta una regla coherente', () => {
    expect(validateDuplicateRule(rule, fields)).toBeNull();
  });
  it('rechaza campos que no existen y marcas que el select no tiene', () => {
    expect(validateDuplicateRule({ ...rule, key: 'nada' }, fields)).toMatch(/no existe/);
    expect(validateDuplicateRule({ ...rule, flagValue: 'Repetida' }, fields)).toMatch(/opción/);
  });
  it('rechaza una marca en un campo de fecha o igual a la clave', () => {
    const withDate = [
      ...fields,
      { key: 'llegada', label: 'Llegada', type: 'date' as const, required: false },
    ];
    expect(validateDuplicateRule({ ...rule, flagField: 'llegada' }, withDate)).toMatch(
      /opciones o de texto/,
    );
    expect(validateDuplicateRule({ ...rule, flagField: 'numero_guia' }, fields)).toMatch(
      /distinto/,
    );
  });
});

describe('duplicateMessage', () => {
  it('dice contra qué fecha chocó', () => {
    const msg = duplicateMessage(rule, fields, {
      rowId: 'a',
      key: '0451234',
      value: '045-1234',
      others: ['2026-03-01'],
    });
    expect(msg).toBe('«045-1234» ya existe con fecha 2026-03-01 — quedó marcada Duplicada.');
  });
  it('null si no hay conflicto', () => {
    expect(duplicateMessage(rule, fields, undefined)).toBeNull();
  });
});
