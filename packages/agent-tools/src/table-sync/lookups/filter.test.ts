import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TrackerField } from '../../trackers/schema';
import { matchesLookupFilter, unknownFilterFields } from './filter';
import { GRID_FILTER_OPS, type LookupFilter } from './types';

// 2026-10-03 10:00 en Bogotá.
const NOW = Date.parse('2026-10-03T15:00:00Z');

const FIELDS: TrackerField[] = [
  { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
  { key: 'fecha', label: 'Fecha', type: 'date', required: false },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    required: false,
    options: ['en vuelo', 'aterrizado', 'cancelado'],
  },
  { key: 'peso', label: 'Peso', type: 'number', required: false },
  { key: 'hora', label: 'Hora', type: 'text', required: false },
];

const filter = (f: LookupFilter['filters'], match: 'all' | 'any' = 'all'): LookupFilter => ({
  match,
  filters: f,
});
const test = (f: LookupFilter, values: Record<string, string | number>) =>
  matchesLookupFilter(f, FIELDS, values, NOW);

describe('el filtro de una consulta', () => {
  it('«fecha es hoy Y estado no es aterrizado ni cancelado»', () => {
    const f = filter([
      { key: 'fecha', op: 'eq', value: 'hoy' },
      { key: 'estado', op: 'not_in', value: ['aterrizado', 'cancelado'] },
    ]);
    expect(test(f, { fecha: '2026-10-03', estado: 'en vuelo' })).toBe(true);
    // Sin estado todavía: sigue consultándose.
    expect(test(f, { fecha: '2026-10-03' })).toBe(true);
    // Regla de parada: ya aterrizó.
    expect(test(f, { fecha: '2026-10-03', estado: 'aterrizado' })).toBe(false);
    expect(test(f, { fecha: '2026-10-03', estado: 'cancelado' })).toBe(false);
    // Otro día.
    expect(test(f, { fecha: '2026-10-04', estado: 'en vuelo' })).toBe(false);
  });

  it('«hoy» es el día de Bogotá, no el de UTC', () => {
    const f = filter([{ key: 'fecha', op: 'eq', value: 'hoy' }]);
    // 2026-10-04T03:00Z = 22:00 del 3 en Bogotá.
    const late = Date.parse('2026-10-04T03:00:00Z');
    expect(matchesLookupFilter(f, FIELDS, { fecha: '2026-10-03' }, late)).toBe(true);
    expect(matchesLookupFilter(f, FIELDS, { fecha: '2026-10-04' }, late)).toBe(false);
  });

  it('operadores de fecha: antes, después, últimos y próximos días, entre', () => {
    const v = { fecha: '2026-10-05' };
    expect(test(filter([{ key: 'fecha', op: 'after', value: 'hoy' }]), v)).toBe(true);
    expect(test(filter([{ key: 'fecha', op: 'before', value: 'hoy' }]), v)).toBe(false);
    expect(test(filter([{ key: 'fecha', op: 'next_days', value: 2 }]), v)).toBe(true);
    expect(test(filter([{ key: 'fecha', op: 'next_days', value: 1 }]), v)).toBe(false);
    expect(
      test(filter([{ key: 'fecha', op: 'last_days', value: 0 }]), { fecha: '2026-10-03' }),
    ).toBe(true);
    expect(
      test(filter([{ key: 'fecha', op: 'last_days', value: 3 }]), { fecha: '2026-10-01' }),
    ).toBe(true);
    expect(
      test(filter([{ key: 'fecha', op: 'between', value: ['2026-10-01', '2026-10-04'] }]), v),
    ).toBe(false);
    expect(test(filter([{ key: 'fecha', op: 'between', value: ['hoy', '2026-10-06'] }]), v)).toBe(
      true,
    );
  });

  it('una hora guardada como texto también filtra por día', () => {
    const f = filter([{ key: 'hora', op: 'eq', value: 'hoy' }]);
    expect(test(f, { hora: '2026-10-03 14:30' })).toBe(true);
    expect(test(f, { hora: '2026-10-04 01:30' })).toBe(false);
  });

  it('texto: sin tildes ni mayúsculas, contiene, es alguno de, vacío', () => {
    expect(test(filter([{ key: 'vuelo', op: 'contains', value: 'av' }]), { vuelo: 'AV9' })).toBe(
      true,
    );
    expect(test(filter([{ key: 'vuelo', op: 'eq', value: 'bogotá' }]), { vuelo: 'Bogota' })).toBe(
      true,
    );
    expect(test(filter([{ key: 'vuelo', op: 'in', value: 'av9, la40' }]), { vuelo: 'LA40' })).toBe(
      true,
    );
    expect(test(filter([{ key: 'vuelo', op: 'empty' }]), {})).toBe(true);
    expect(test(filter([{ key: 'vuelo', op: 'not_empty' }]), {})).toBe(false);
  });

  it('números', () => {
    expect(test(filter([{ key: 'peso', op: 'gt', value: 10 }]), { peso: 12 })).toBe(true);
    expect(test(filter([{ key: 'peso', op: 'between', value: [1, 5] }]), { peso: 12 })).toBe(false);
    expect(test(filter([{ key: 'peso', op: 'neq', value: 12 }]), {})).toBe(true);
  });

  it('un filtro a medio llenar no filtra todavía; sin filtros pasan todas', () => {
    expect(test(filter([{ key: 'estado', op: 'in' }]), { estado: 'aterrizado' })).toBe(true);
    expect(test(filter([]), { estado: 'aterrizado' })).toBe(true);
  });

  it('«alguno» basta con uno', () => {
    const f = filter(
      [
        { key: 'estado', op: 'in', value: ['en vuelo'] },
        { key: 'vuelo', op: 'eq', value: 'LA40' },
      ],
      'any',
    );
    expect(test(f, { estado: 'aterrizado', vuelo: 'LA40' })).toBe(true);
    expect(test(f, { estado: 'aterrizado', vuelo: 'AV9' })).toBe(false);
  });

  it('avisa de los campos del filtro que la tabla no tiene', () => {
    expect(unknownFilterFields(filter([{ key: 'nada', op: 'empty' }]), FIELDS)).toEqual(['nada']);
  });

  it('los operadores son los de la grilla (components/datagrid/types.ts)', () => {
    const source = readFileSync(
      new URL('../../../../../apps/web/components/datagrid/types.ts', import.meta.url),
      'utf8',
    );
    const block = /export type GridFilterOp =([^;]+);/.exec(source)?.[1] ?? '';
    const ops = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect([...GRID_FILTER_OPS].sort()).toEqual(ops);
  });
});
