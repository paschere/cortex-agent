import { describe, expect, it } from 'vitest';
import { referenceList } from '../reference-lists';
import { mergeSuggestions } from './autofill-shape';
import {
  type MatchConfig,
  cortexTargetsAfterMatch,
  extractMatchKey,
  normalizeMatchText,
  runMatch,
  toMatchTable,
} from './match-shape';

const cfg: MatchConfig = {
  from: 'numero_vuelo',
  extract: { mode: 'prefix', length: 2 },
  source: 'cortex.aerolineas',
  key: 'codigo',
  fills: { aerolinea: 'nombre', pais_aerolinea: 'pais' },
};
const table = toMatchTable(referenceList('cortex.aerolineas')?.rows ?? [], 'codigo', [
  'codigo',
  'nombre',
  'pais',
]);

describe('normalizado y extracción', () => {
  it('mayúsculas, sin espacios, guiones ni tildes', () => {
    expect(normalizeMatchText(' k4-865 ')).toBe('K4865');
    expect(normalizeMatchText('Bogotá D.C.')).toBe('BOGOTADC');
  });
  it('prefijo, completo y regex con grupo', () => {
    expect(extractMatchKey({ mode: 'prefix', length: 2 }, 'av 123')).toBe('AV');
    expect(extractMatchKey({ mode: 'prefix', length: 2 }, 'a')).toBeNull();
    expect(extractMatchKey(undefined, 'k4 865')).toBe('K4865');
    expect(extractMatchKey({ mode: 'regex', pattern: '^([A-Z0-9]{2})\\d' }, 'k4865')).toBe('K4');
    expect(extractMatchKey({ mode: 'regex', pattern: '^(\\d+)$' }, 'abc')).toBeNull();
    expect(extractMatchKey({ mode: 'regex', pattern: '(a+)+' }, 'aaa')).toBeNull();
  });
});

describe('runMatch', () => {
  it('K4865 → Kalitta Air', () => {
    const r = runMatch(cfg, table, { numero_vuelo: 'k4865' });
    expect(r.hit).toBe(true);
    expect(r.suggestions.aerolinea?.value).toBe('Kalitta Air');
    expect(r.suggestions.pais_aerolinea?.value).toBe('Estados Unidos');
  });
  it('AV 123 → Avianca; código desconocido no encuentra', () => {
    expect(runMatch(cfg, table, { numero_vuelo: 'AV 123' }).suggestions.aerolinea?.value).toBe(
      'Avianca',
    );
    expect(runMatch(cfg, table, { numero_vuelo: 'ZZ99' }).hit).toBe(false);
    expect(runMatch(cfg, table, { numero_vuelo: '' }).key).toBeNull();
  });
  it('no pisa lo que la persona escribió (mismo merge del autofill)', () => {
    const fields = [
      { key: 'numero_vuelo', label: 'Vuelo', type: 'text' },
      { key: 'aerolinea', label: 'Aerolínea', type: 'text' },
    ];
    const out = runMatch(cfg, table, { numero_vuelo: 'AV1' });
    const merged = mergeSuggestions(
      fields,
      { fills: ['aerolinea'] },
      { aerolinea: 'Mi aerolínea' },
      out.suggestions,
    );
    expect(merged.applied).toEqual({});
    expect(merged.skipped[0]?.reason).toBe('escrito');
  });
});

describe('cascada con Cortex', () => {
  const fills = ['aerolinea', 'origen', 'fecha'];
  it('sin coincidencia, Cortex llena todo', () => {
    expect(cortexTargetsAfterMatch(fills, undefined, { hit: false, matched: [] })).toEqual(fills);
  });
  it('con coincidencia y sin `rest`, Cortex no corre', () => {
    expect(
      cortexTargetsAfterMatch(fills, 'no_match', { hit: true, matched: ['aerolinea'] }),
    ).toEqual([]);
  });
  it('con `rest`, Cortex completa lo que la lista no llenó', () => {
    expect(cortexTargetsAfterMatch(fills, 'rest', { hit: true, matched: ['aerolinea'] })).toEqual([
      'origen',
      'fecha',
    ]);
  });
});

describe('listas de la plataforma', () => {
  it('todas tienen clave única y las columnas declaradas', () => {
    for (const id of [
      'cortex.aerolineas',
      'cortex.aeropuertos',
      'cortex.bancos_colombia',
      'cortex.monedas',
    ]) {
      const l = referenceList(id);
      expect(l).not.toBeNull();
      const keys = (l?.rows ?? []).map((r) => normalizeMatchText(r[l?.keyColumn ?? '']));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.every(Boolean)).toBe(true);
    }
  });
});

import { trackerFieldsSchema } from './schema';

describe('match en el esquema', () => {
  const base = [
    { key: 'numero_vuelo', label: 'Vuelo', type: 'text' },
    { key: 'aerolinea', label: 'Aerolínea', type: 'text' },
  ];
  const withMatch = (match: unknown, extra: object = {}) => [
    { ...base[0], match, ...extra },
    base[1],
  ];
  const ok = {
    from: 'numero_vuelo',
    extract: { mode: 'prefix', length: 2 },
    source: 'cortex.aerolineas',
    key: 'codigo',
    fills: { aerolinea: 'nombre' },
  };
  it('acepta una lista de la plataforma con cascada a Cortex', () => {
    const r = trackerFieldsSchema.safeParse(
      withMatch(ok, {
        autofill: {
          instruction: 'Búscala en la web',
          from: ['numero_vuelo'],
          fills: ['aerolinea'],
          when: 'rest',
        },
      }),
    );
    expect(r.success).toBe(true);
  });
  it('rechaza una lista que no existe, una columna que no existe y un destino que no existe', () => {
    const msg = (m: unknown) => {
      const r = trackerFieldsSchema.safeParse(withMatch(m));
      return r.success ? '' : JSON.stringify(r.error.issues);
    };
    expect(msg({ ...ok, source: 'cortex.zzz' })).toMatch(/no existe/);
    expect(msg({ ...ok, fills: { aerolinea: 'color' } })).toMatch(/no tiene la columna/);
    expect(msg({ ...ok, fills: { nada: 'nombre' } })).toMatch(/no existe el campo destino/);
    expect(msg({ ...ok, fills: {} })).toMatch(/Entre 1 y 8|destino/);
  });
  it('un campo calculado no lleva match', () => {
    const r = trackerFieldsSchema.safeParse([
      { key: 'a', label: 'A', type: 'number' },
      { key: 'b', label: 'B', type: 'number', formula: '[A] × 2', match: ok },
    ]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data[1]?.match).toBeUndefined();
  });
});
