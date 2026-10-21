import { describe, expect, it } from 'vitest';
import { fieldUsesInSpecs, fieldUsesSentence } from './field-usage';

describe('fieldUsesInSpecs', () => {
  const views = [
    {
      id: 'v1',
      title: 'Detalle de vuelo',
      spec: {
        blocks: [
          {
            id: 'b1',
            type: 'detail',
            tracker: 'vuelos',
            titleField: 'numero_vuelo',
            sections: [{ fields: ['estado', 'hora_real'] }],
          },
          { id: 'b2', type: 'table', tracker: 'otra', columns: ['estado'] },
        ],
      },
    },
    {
      id: 'v2',
      title: 'Otra',
      spec: { blocks: [{ id: 'b3', type: 'table', tracker: 'vuelos', columns: ['numero_vuelo'] }] },
    },
  ];
  it('encuentra los bloques de la tabla que usan las llaves', () => {
    const uses = fieldUsesInSpecs(views, 'vuelos', ['estado', 'hora_real', 'observaciones']);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.blocks[0]?.fields).toEqual(['estado', 'hora_real']);
    expect(fieldUsesSentence(uses)).toContain('Detalle de vuelo');
  });
  it('sin llaves o sin coincidencias no hay usos', () => {
    expect(fieldUsesInSpecs(views, 'vuelos', ['zzz'])).toEqual([]);
    expect(fieldUsesInSpecs([{ id: 'x', title: 'x', spec: null }], 'vuelos', ['estado'])).toEqual(
      [],
    );
  });
});
