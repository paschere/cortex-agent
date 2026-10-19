import { describe, expect, it } from 'vitest';
import { type CatalogTracker, autofixSpecAgainst, checkSpecAgainst, viewSpecSchema } from './spec';

const atenciones: CatalogTracker = {
  slug: 'atenciones',
  name: 'Atenciones',
  fields: [
    { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
    { key: 'hora_inicio', label: 'Hora de inicio', type: 'time', required: false },
    { key: 'fecha', label: 'Fecha', type: 'date', required: false },
  ],
};

const spec = (dateField: string) =>
  viewSpecSchema.parse({
    version: 1,
    blocks: [
      {
        id: 'cards_atenciones',
        type: 'cards',
        tracker: 'atenciones',
        title: 'Mis atenciones',
        dateField,
        chips: ['mine', 'today', 'week'],
      },
    ],
  });

describe('autofixSpecAgainst', () => {
  it('un campo que no es de fecha en las tarjetas: se quitan los chips de fecha, con aviso', () => {
    const s = spec('hora_inicio');
    expect(checkSpecAgainst(s, [atenciones]).join(' ')).toContain('no es un campo de fecha');
    const fixed = autofixSpecAgainst(s, [atenciones]);
    expect(fixed.fixes).toHaveLength(1);
    expect(fixed.fixes[0]).toContain('hora_inicio');
    const block = fixed.spec.blocks[0] as { chips: string[]; dateField?: string };
    expect(block.chips).toEqual(['mine']);
    expect(block.dateField).toBeUndefined();
    expect(checkSpecAgainst(fixed.spec, [atenciones])).toEqual([]);
  });

  it('un campo de fecha de verdad no se toca', () => {
    const s = spec('fecha');
    const fixed = autofixSpecAgainst(s, [atenciones]);
    expect(fixed.fixes).toEqual([]);
    expect(fixed.spec).toBe(s);
  });

  it('un campo que no existe sigue siendo un problema (no se inventa)', () => {
    const fixed = autofixSpecAgainst(spec('no_existe'), [atenciones]);
    expect(fixed.fixes).toEqual([]);
    expect(checkSpecAgainst(fixed.spec, [atenciones]).join(' ')).toContain('no_existe');
  });

  it('no muta el spec original', () => {
    const s = spec('hora_inicio');
    autofixSpecAgainst(s, [atenciones]);
    expect((s.blocks[0] as { chips: string[] }).chips).toContain('today');
  });
});
