import type { ViewSpec } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import type { EditorSource } from './editor-spec';
import {
  type DropMeasure,
  blocksOfPage,
  copyPages,
  deviceSpan,
  insertBlockAt,
  locateDrop,
  pagesOfBlock,
  parseStoredDraft,
  prunePages,
  relativeTime,
  renameBlock,
  studioSuggestions,
  togglePage,
  widthFromFraction,
} from './studio';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

// Dos tercios arriba y una tabla ancha abajo.
const measures: DropMeasure[] = [
  { id: 'a', rect: rect(0, 0, 300, 100), wide: false },
  { id: 'b', rect: rect(320, 0, 300, 100), wide: false },
  { id: 'c', rect: rect(0, 120, 940, 200), wide: true },
];

const spec: ViewSpec = {
  version: 1,
  accent: 'primary',
  refreshSeconds: 30,
  editing: 'off',
  alerts: [],
  blocks: [
    { id: 't', type: 'text', width: 'full', markdown: '## Hola' },
    {
      id: 'm',
      type: 'metric',
      width: 'third',
      tracker: 'remates',
      filters: [],
      title: 'Cuántos',
      aggregate: 'count',
      format: 'number',
      tone: 'primary',
    },
  ],
};

const remates: EditorSource = {
  slug: 'remates',
  name: 'Remates',
  description: '',
  kind: 'tracker',
  sensitivity: 'shareable',
  readOnly: false,
  fields: [
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Abierto', 'Cerrado'],
    },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
  ],
};

describe('el estudio sin pantalla', () => {
  it('ocupa las columnas del dispositivo, no de la ventana', () => {
    expect(deviceSpan('third', 'desktop')).toBe('col-span-2');
    expect(deviceSpan('third', 'tablet')).toBe('col-span-3');
    expect(deviceSpan('full', 'phone')).toBe('col-span-1');
    expect(deviceSpan('raro', 'desktop')).toBe('col-span-6');
  });

  it('el asa de ancho corta a medio camino', () => {
    expect(widthFromFraction(0.3)).toBe('third');
    expect(widthFromFraction(0.5)).toBe('half');
    expect(widthFromFraction(0.9)).toBe('full');
  });

  it('una pieza nueva cae antes, después o al final', () => {
    expect(locateDrop(10, 50, measures, null)).toEqual({
      insert: 0,
      target: { id: 'a', side: 'left' },
    });
    expect(locateDrop(600, 50, measures, null)).toEqual({
      insert: 2,
      target: { id: 'b', side: 'right' },
    });
    expect(locateDrop(400, 140, measures, null)).toEqual({
      insert: 2,
      target: { id: 'c', side: 'top' },
    });
    expect(locateDrop(400, 900, measures, null)).toEqual({
      insert: 3,
      target: { id: 'c', side: 'bottom' },
    });
    expect(locateDrop(0, 0, [], null)).toEqual({ insert: 0, target: null });
  });

  it('mover un bloque junto a sí mismo no cambia nada', () => {
    expect(locateDrop(10, 50, measures, 0)).toEqual({ insert: null, target: null });
    expect(locateDrop(330, 50, measures, 0)).toEqual({ insert: null, target: null });
    expect(locateDrop(600, 50, measures, 0)).toEqual({
      insert: 2,
      target: { id: 'b', side: 'right' },
    });
  });

  it('inserta en una posición sin mutar el spec', () => {
    const block = { id: 'n', type: 'text', width: 'full', markdown: 'x' } as const;
    const next = insertBlockAt(spec, block, 0);
    expect(next.blocks.map((b) => b.id)).toEqual(['n', 't', 'm']);
    expect(spec.blocks).toHaveLength(2);
    expect(insertBlockAt(spec, block, 99).blocks.at(-1)?.id).toBe('n');
  });

  it('renombra los bloques con título, no los textos', () => {
    const metric = spec.blocks[1];
    const text = spec.blocks[0];
    if (!metric || !text) throw new Error('fixture');
    expect(renameBlock(metric, '  Total   de remates')).toMatchObject({
      title: 'Total de remates',
    });
    expect(renameBlock(text, 'x')).toBeNull();
  });

  it('sugiere frases con las tablas y campos de la vista', () => {
    const out = studioSuggestions(spec, [remates], null);
    expect(out).toContain('Agrega un gráfico de remates por estado');
    expect(out).toContain('Haz que suene cuando entre una fila nueva en Remates');
    expect(out.length).toBeLessThanOrEqual(5);
    expect(studioSuggestions(spec, [remates], 'Cuántos')[0]).toContain('«Cuántos»');
    expect(studioSuggestions(spec, [], null).length).toBeGreaterThan(0);
  });

  it('dice el tiempo como la gente', () => {
    const now = new Date('2026-10-01T15:00:00Z');
    expect(relativeTime('2026-10-01T14:59:40Z', now)).toBe('hace un momento');
    expect(relativeTime('2026-10-01T14:30:00Z', now)).toBe('hace 30 min');
    expect(relativeTime('2026-10-01T12:00:00Z', now)).toBe('hace 3 h');
    expect(relativeTime('2026-09-30T12:00:00Z', now)).toBe('ayer');
    expect(relativeTime('2026-09-27T12:00:00Z', now)).toBe('hace 4 días');
    expect(relativeTime('no', now)).toBe('');
  });

  it('un borrador guardado roto no rompe nada', () => {
    expect(parseStoredDraft(null)).toBeNull();
    expect(parseStoredDraft('{')).toBeNull();
    expect(parseStoredDraft('{"at":"x"}')).toBeNull();
    expect(parseStoredDraft('{"draft":{"name":"a"},"at":"2026-10-01","version":3}')).toEqual({
      draft: { name: 'a' },
      at: '2026-10-01',
      version: 3,
    });
  });

  it('trabaja por páginas con la regla del motor', () => {
    const paged = {
      ...spec,
      pages: [
        { id: 'uno', title: 'Uno', blockIds: [] },
        { id: 'dos', title: 'Dos', blockIds: ['m'] },
      ],
    } as ViewSpec;
    // Lo suelto sale en la primera; lo nombrado, donde se nombra.
    expect(blocksOfPage(paged, 'uno').map((b) => b.id)).toEqual(['t']);
    expect(blocksOfPage(paged, 'dos').map((b) => b.id)).toEqual(['m']);
    expect(blocksOfPage(spec, 'uno')).toBe(spec.blocks);
    expect(pagesOfBlock(paged, 't')).toEqual(['uno']);
    // Un bloque puede estar en varias.
    const both = togglePage(paged, 'm', 'uno', true);
    expect(pagesOfBlock(both, 'm')).toEqual(['uno', 'dos']);
    expect(pagesOfBlock(togglePage(both, 'm', 'uno', false), 'm')).toEqual(['dos']);
    // La copia sale donde el original; borrar no deja páginas nombrando fantasmas.
    expect(pagesOfBlock(copyPages(paged, 'm', 'm_2'), 'm_2')).toEqual(['dos']);
    const gone = prunePages({ ...paged, blocks: [spec.blocks[0]] } as ViewSpec);
    expect((gone as { pages: Array<{ blockIds: string[] }> }).pages[1]?.blockIds).toEqual([]);
    expect(prunePages(spec)).toBe(spec);
  });
});
