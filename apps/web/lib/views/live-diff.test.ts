import { viewAlertSchema } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { blockFingerprints, detectAlertHits, flashKeys, parseWatchMode } from './live-diff';

const row = (id: string, rev: string) => ({ id, label: `fila ${id}`, rev });

describe('viewAlertSchema.on', () => {
  it("por defecto es 'new' (retrocompatible)", () => {
    const a = viewAlertSchema.parse({ id: 'a', source: 'pedidos' });
    expect(a.on).toBe('new');
    expect(viewAlertSchema.parse({ id: 'a', source: 'pedidos', on: 'both' }).on).toBe('both');
    expect(viewAlertSchema.safeParse({ id: 'a', source: 'pedidos', on: 'otra' }).success).toBe(
      false,
    );
  });
});

describe('detectAlertHits', () => {
  const known = new Map([
    ['1', 'r1'],
    ['2', 'r1'],
  ]);
  const rows = [row('1', 'r1'), row('2', 'r2'), row('3', 'r1')];
  it('sin refresco anterior nada es noticia', () => {
    expect(detectAlertHits(undefined, rows, 'both')).toEqual([]);
  });
  it("'new' sólo filas nuevas", () => {
    expect(detectAlertHits(known, rows, 'new').map((h) => [h.row.id, h.kind])).toEqual([
      ['3', 'new'],
    ]);
  });
  it("'change' sólo filas ya vistas que cambiaron", () => {
    expect(detectAlertHits(known, rows, 'change').map((h) => [h.row.id, h.kind])).toEqual([
      ['2', 'change'],
    ]);
  });
  it("'both' las dos", () => {
    expect(detectAlertHits(known, rows, 'both')).toHaveLength(2);
  });
});

describe('flashKeys', () => {
  it('marca lo nuevo y lo cambiado, no lo igual', () => {
    const prev = new Map([
      ['b:1', 'a'],
      ['b:2', 'a'],
    ]);
    const next = new Map([
      ['b:1', 'a'],
      ['b:2', 'z'],
      ['b:3', 'a'],
    ]);
    expect([...flashKeys(prev, next)].sort()).toEqual(['b:2', 'b:3']);
    expect(flashKeys(null, next).size).toBe(0);
  });
});

describe('blockFingerprints', () => {
  it('cambia cuando cambia el estado de una fila de tabla', () => {
    const mk = (estado: string) =>
      [
        {
          id: 't',
          type: 'table',
          rows: [{ id: 'r', cells: ['G1', estado], sort: [], alert: estado === 'Duplicado' }],
        },
      ] as never;
    const a = blockFingerprints(mk('Abierto'));
    const b = blockFingerprints(mk('Duplicado'));
    expect(flashKeys(a, b)).toEqual(new Set(['t:r']));
  });
});

describe('parseWatchMode', () => {
  it('por defecto: toast con alertas, titilar sin ellas', () => {
    expect(parseWatchMode(null, true)).toBe('toast');
    expect(parseWatchMode(null, false)).toBe('flash');
    expect(parseWatchMode('off', true)).toBe('off');
    expect(parseWatchMode('on', true)).toBe('sound');
  });
});
