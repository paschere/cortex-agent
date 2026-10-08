import { describe, expect, it } from 'vitest';
import { type FolderRef, pickFolder, resolveFolderPath } from '../folder-match';

const f = (id: string, name: string): FolderRef => ({ id, name });

describe('búsqueda tolerante de carpetas', () => {
  it('ignora mayúsculas, tildes, guiones y espacios', () => {
    const kids = [f('1', 'AV 204 - 12 Oct'), f('2', 'LA 8001')];
    expect(pickFolder(kids, 'av204')).toEqual({ kind: 'found', folder: kids[0] });
    expect(pickFolder(kids, 'Av-204')).toEqual({ kind: 'found', folder: kids[0] });
    expect(pickFolder([f('3', 'Guía 045-12345678 Nexa')], '04512345678')).toMatchObject({
      kind: 'found',
    });
    expect(pickFolder([f('4', 'Vuelos 2026')], 'vuelos')).toMatchObject({ kind: 'found' });
  });

  it('prefiere la coincidencia exacta y la de palabra completa a la pegada', () => {
    const kids = [f('1', 'AV204'), f('2', 'AV2045'), f('3', 'AV204 copia')];
    expect(pickFolder(kids, 'AV204')).toEqual({ kind: 'found', folder: kids[0] });
    // sin exacta: «AV 204» como palabras no confunde con AV2045
    const kids2 = [f('2', 'AV2045'), f('3', 'AV 204 - oct')];
    expect(pickFolder(kids2, 'AV204')).toMatchObject({ kind: 'found', folder: kids2[1] });
  });

  it('no adivina: sin coincidencia o con varias, lo dice', () => {
    expect(pickFolder([f('1', 'Otra')], 'AV204')).toEqual({ kind: 'none' });
    const two = [f('1', 'AV204 - oct'), f('2', 'AV204 - nov')];
    const r = pickFolder(two, 'AV204');
    expect(r.kind).toBe('ambiguous');
    expect(pickFolder(two, '  ')).toEqual({ kind: 'none' });
  });
});

describe('ruta nivel a nivel', () => {
  const tree: Record<string, FolderRef[]> = {
    root: [f('v1', 'Vuelos'), f('x', 'Otros')],
    v1: [f('a', 'AV204 (12 oct)'), f('b', 'LA 8001')],
    a: [f('g', 'guia 045-12345678'), f('h', 'guia 045-99999999')],
  };
  const list = async (id: string) => tree[id] ?? [];

  it('baja por Vuelos / AV204 / guía y nunca crea nada', async () => {
    const r = await resolveFolderPath(list, f('root', 'Mi unidad'), [
      'vuelos',
      'AV 204',
      '045-12345678',
    ]);
    expect(r.found && r.folder.id).toBe('g');
    expect(r.found && r.trail.map((x) => x.id)).toEqual(['root', 'v1', 'a', 'g']);
  });

  it('si falta un nivel, dice cuál y hasta dónde llegó', async () => {
    const r = await resolveFolderPath(list, f('root', 'Mi unidad'), ['Vuelos', 'AV999']);
    expect(r.found).toBe(false);
    if (!r.found) {
      expect(r.reason).toContain('AV999');
      expect(r.trail.map((x) => x.id)).toEqual(['root', 'v1']);
    }
  });

  it('dos carpetas posibles en un nivel: ambigua, con candidatas', async () => {
    const r = await resolveFolderPath(list, f('a', 'AV204'), ['guia 045']);
    expect(r.found).toBe(false);
    if (!r.found) expect(r.candidates?.length).toBe(2);
  });

  it('niveles en blanco (variable vacía) se ignoran', async () => {
    const r = await resolveFolderPath(list, f('root', 'r'), ['Vuelos', '  ']);
    expect(r.found && r.folder.id).toBe('v1');
  });
});
