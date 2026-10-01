import { describe, expect, it } from 'vitest';
import { type DesignCatalogEntry, checkDesign, salvageDesign } from './design';

const catalog: DesignCatalogEntry[] = [];
const guias = {
  slug: 'guias',
  name: 'Guías',
  description: '',
  fields: [
    { key: 'guia', label: 'Guía', type: 'text' as const, required: true, options: [] },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select' as const,
      required: false,
      options: ['Pendiente', 'En plataforma', 'Entregado'],
    },
    { key: 'dolly', label: 'Dolly', type: 'select' as const, required: false, options: [] },
  ],
};

const object = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  name: 'Operación de carga',
  description: '',
  explanation: 'Armé el tablero.',
  questions: [],
  newTrackers: [guias],
  specJson: JSON.stringify({ version: 1, blocks, ...extra }),
});

describe('el diseñador no se rinde por errores menores', () => {
  it('un tablero arrastrable sin «editing» queda editable por el equipo; un select sin opciones es texto', () => {
    const res = checkDesign(
      object([
        {
          id: 'b',
          type: 'board',
          title: 'Guías',
          tracker: 'guias',
          groupBy: 'estado',
          draggable: true,
        },
      ]),
      catalog,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.spec.editing).toBe('team');
    expect(res.result.newTrackers[0]?.fields.find((f) => f.key === 'dolly')?.type).toBe('text');
  });

  it('si un bloque no cuadra, se quita ese y se entrega el resto', () => {
    const bad = object([
      {
        id: 'hoy',
        type: 'metric',
        title: 'Hoy',
        tracker: 'guias',
        aggregate: 'sum',
        field: 'estado',
      },
      { id: 'b', type: 'board', title: 'Guías', tracker: 'guias', groupBy: 'estado' },
    ]);
    expect(checkDesign(bad, catalog).ok).toBe(false);
    const saved = salvageDesign(bad, catalog);
    expect(saved?.dropped).toEqual(['hoy']);
    expect(saved?.result.spec.blocks.map((b) => b.id)).toEqual(['b']);
  });
});
