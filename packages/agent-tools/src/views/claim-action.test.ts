import { describe, expect, it } from 'vitest';
import { type CatalogTracker, checkSpecAgainst, viewSpecSchema } from './spec';

const vuelos: CatalogTracker = {
  slug: 'vuelos',
  name: 'Vuelos',
  fields: [
    { key: 'numero', label: 'Vuelo', type: 'text', required: true },
    { key: 'estado', label: 'Estado', type: 'select', required: false, options: ['Aterrizó', 'En atención'] },
    { key: 'tomado_por_id', label: 'Tomado por (id)', type: 'text', required: false },
    { key: 'tomado_por', label: 'Tomado por', type: 'text', required: false },
    { key: 'tomado_fecha', label: 'Fecha', type: 'date', required: false },
    { key: 'tomado_hora', label: 'Hora', type: 'time', required: false },
  ],
};

const spec = (action: Record<string, unknown>) => ({
  version: 1,
  editing: 'team',
  blocks: [
    { id: 'c', type: 'cards', title: 'Por atender', tracker: 'vuelos', titleField: 'numero', actions: [action] },
  ],
});

const claim = {
  id: 'tomar',
  label: 'Tomar',
  kind: 'claim',
  field: 'tomado_por_id',
  nameField: 'tomado_por',
  statusField: 'estado',
  when: 'Aterrizó',
  value: 'En atención',
  dateField: 'tomado_fecha',
  timeField: 'tomado_hora',
};

describe('botón «Tomar» (claim)', () => {
  it('la forma completa pasa', () => {
    expect(viewSpecSchema.safeParse(spec(claim)).success).toBe(true);
  });
  it('exige quién y su nombre', () => {
    expect(viewSpecSchema.safeParse(spec({ ...claim, nameField: undefined })).success).toBe(false);
    expect(viewSpecSchema.safeParse(spec({ ...claim, field: undefined })).success).toBe(false);
  });
  it('when necesita statusField', () => {
    expect(viewSpecSchema.safeParse(spec({ ...claim, statusField: undefined })).success).toBe(false);
  });
  it('los campos se comprueban contra la tabla', () => {
    const ok = viewSpecSchema.parse(spec(claim));
    expect(checkSpecAgainst(ok, [vuelos])).toEqual([]);
    const bad = viewSpecSchema.parse(spec({ ...claim, nameField: 'nadie', dateField: 'tampoco' }));
    expect(checkSpecAgainst(bad, [vuelos]).join(' ')).toMatch(/nadie/);
  });
});
