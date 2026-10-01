import { describe, expect, it } from 'vitest';
import { type ViewSource, computeView, zoneLayout } from './compute';
import { type CatalogTracker, checkSpecAgainst, viewSpecSchema } from './spec';

const tracker: CatalogTracker = {
  slug: 'equipos',
  name: 'Equipos',
  fields: [
    { key: 'nombre', label: 'Nombre', type: 'text', required: true },
    {
      key: 'zona',
      label: 'Zona',
      type: 'select',
      required: false,
      options: ['Muelle 1', 'Muelle 2', 'Bodega'],
    },
  ],
};
const row = (id: string, nombre: string, zona?: string) => ({
  id,
  label: nombre,
  values: { nombre, ...(zona ? { zona } : {}) },
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
});
const sources = new Map<string, ViewSource>([
  [
    'equipos',
    {
      tracker,
      truncated: false,
      rows: [row('1', 'D-01', 'Muelle 1'), row('2', 'D-02', 'Bodega'), row('3', 'D-03')],
    },
  ],
]);

describe('el plano', () => {
  it('ubica las zonas del spec y acomoda solas las que faltan, sin pisarlas', () => {
    expect(
      zoneLayout([{ zone: 'Bodega', x: 0, y: 0, w: 12, h: 2 }], ['Muelle 1', 'Bodega', '__none']),
    ).toEqual([
      { zone: 'Bodega', x: 0, y: 0, w: 12, h: 2 },
      { zone: 'Muelle 1', x: 0, y: 2, w: 4, h: 2 },
      { zone: '__none', x: 4, y: 2, w: 4, h: 2 },
    ]);
  });

  it('reparte las fichas por zona y deja las sueltas aparte', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'p', type: 'zones', title: 'Plano', tracker: 'equipos', groupBy: 'zona' }],
    });
    expect(checkSpecAgainst(spec, [tracker])).toEqual([]);
    const [block] = computeView(spec, sources).blocks;
    if (block?.type !== 'zones') throw new Error('plano');
    expect(block.columns.map((c) => [c.key, c.count])).toEqual([
      ['Muelle 1', 1],
      ['Muelle 2', 0],
      ['Bodega', 1],
      ['__none', 1],
    ]);
    expect(block.layout).toHaveLength(4);
  });

  it('rechaza zonas que no son opciones y zonas que se salen del plano', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'p',
          type: 'zones',
          title: 'Plano',
          tracker: 'equipos',
          groupBy: 'zona',
          layout: [
            { zone: 'Patio', x: 0, y: 0 },
            { zone: 'Bodega', x: 10, y: 0, w: 4 },
          ],
        },
      ],
    });
    const problems = checkSpecAgainst(spec, [tracker]).join(' ');
    expect(problems).toContain('«Patio» no es una opción');
    expect(problems).toContain('se sale del plano');
  });
});
