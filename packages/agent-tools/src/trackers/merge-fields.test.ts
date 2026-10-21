import { describe, expect, it } from 'vitest';
import { mergeFields } from './merge-fields';

const f = (
  key: string,
  extra: Record<string, unknown> = {},
): { key: string; [k: string]: unknown } => ({
  key,
  label: key,
  type: 'text',
  ...extra,
});

describe('mergeFields', () => {
  const existing = [
    f('numero_vuelo'),
    f('estado', { type: 'select', options: ['A', 'B'] }),
    f('hora_real', { type: 'time' }),
    f('observaciones', { type: 'longtext' }),
  ];

  it('conserva los campos que no vienen (el caso de GROUNDFLEX)', () => {
    const r = mergeFields(existing, [
      f('numero_vuelo', {
        autofill: { instruction: 'x', from: ['numero_vuelo'], fills: ['aerolinea'] },
      }),
      f('aerolinea'),
    ]);
    expect(r.fields.map((x) => x.key)).toEqual([
      'numero_vuelo',
      'estado',
      'hora_real',
      'observaciones',
      'aerolinea',
    ]);
    expect(r.added).toEqual(['aerolinea']);
    expect(r.changed).toEqual(['numero_vuelo']);
    expect(r.kept).toEqual(['estado', 'hora_real', 'observaciones']);
    expect(r.removed).toEqual([]);
  });

  it('cambia en su lugar y no duplica', () => {
    const r = mergeFields(existing, [f('estado', { type: 'select', options: ['A', 'B', 'C'] })]);
    expect(r.fields).toHaveLength(4);
    expect(r.fields[1]?.options).toEqual(['A', 'B', 'C']);
    expect(r.changed).toEqual(['estado']);
  });

  it('un campo idéntico cuenta como conservado', () => {
    const r = mergeFields(existing, [f('numero_vuelo')]);
    expect(r.changed).toEqual([]);
    expect(r.kept).toContain('numero_vuelo');
  });

  it('sólo quita lo que se nombra en removeFields', () => {
    const r = mergeFields(existing, [f('numero_vuelo')], ['hora_real', 'nada']);
    expect(r.fields.map((x) => x.key)).toEqual(['numero_vuelo', 'estado', 'observaciones']);
    expect(r.removed).toEqual(['hora_real']);
    expect(r.unknownRemovals).toEqual(['nada']);
  });

  it('rechaza un campo que viene y se quita a la vez', () => {
    expect(() => mergeFields(existing, [f('estado')], ['estado'])).toThrow(/removeFields/);
  });

  it('conserva el flujo si el campo se redefine sin él', () => {
    const withFlow = [
      f('estado', { type: 'select', options: ['A', 'B'], flow: { states: ['A', 'B'] } }),
    ];
    const r = mergeFields(withFlow, [f('estado', { type: 'select', options: ['A', 'B'] })]);
    expect(r.fields[0]?.flow).toEqual({ states: ['A', 'B'] });
  });

  it('una tabla nueva queda como viene', () => {
    const r = mergeFields([], [f('a'), f('b')]);
    expect(r.fields.map((x) => x.key)).toEqual(['a', 'b']);
    expect(r.added).toEqual(['a', 'b']);
  });
});
