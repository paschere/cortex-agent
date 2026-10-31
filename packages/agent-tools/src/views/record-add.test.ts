import { describe, expect, it } from 'vitest';
import { resolveAddPrefill } from './record';

const row = {
  id: '11111111-1111-1111-1111-111111111111',
  label: 'AV204 · 30 oct',
  values: { vuelo: '{"id":"22222222-2222-2222-2222-222222222222","label":"AV204"}', kilos: 1200 },
};

describe('resolveAddPrefill', () => {
  it('liga el formulario a este registro y copia campos tal cual', () => {
    expect(resolveAddPrefill({ atencion: '{{fila}}', vuelo: '{{vuelo}}', nota: 'De {{fila}}: {{kilos}} kg', n: 3 }, row)).toEqual({
      atencion: JSON.stringify({ id: row.id, label: row.label }),
      vuelo: row.values.vuelo,
      nota: 'De AV204 · 30 oct: 1200 kg',
      n: '3',
    });
  });
  it('no manda lo vacío', () => {
    expect(resolveAddPrefill({ x: '{{nada}}' }, row)).toEqual({});
  });
});
