import { describe, expect, it } from 'vitest';
import { TABLE_WORK_CORE_IDS, tableWorkAdditions } from '../affinity';
import { intentFamilies } from '../intent';

const tool = (id: string) => ({ id, description: id });
const all = [
  ...TABLE_WORK_CORE_IDS.map(tool),
  tool('trackers.row_lookup_create'),
  tool('gmail.send_message'),
  tool('web.search'),
];

describe('trabajo sobre tablas, apps y vistas', () => {
  it('con sólo apps en el turno, trae el paquete de trackers y views', () => {
    const selected = [tool('apps.update'), tool('apps.get'), tool('web.search')];
    const extra = tableWorkAdditions(selected, all).map((t) => t.id);
    expect(extra).toContain('trackers.upsert');
    expect(extra).toContain('trackers.upsert_many');
    expect(extra).toContain('trackers.query');
    expect(extra).toContain('views.update');
    expect(extra).not.toContain('apps.update');
    expect(extra).not.toContain('trackers.row_lookup_create');
  });

  it('la conversación que ya usó apps lo activa aunque el turno no traiga nada', () => {
    const extra = tableWorkAdditions([tool('web.search')], all, ['apps']);
    expect(extra.map((t) => t.id)).toContain('trackers.upsert');
  });

  it('un turno sin tablas, apps ni vistas no agrega nada', () => {
    expect(tableWorkAdditions([tool('gmail.send_message')], all)).toEqual([]);
  });

  it('no ofrece lo que no está permitido', () => {
    const allowed = [tool('apps.get'), tool('apps.update')];
    expect(tableWorkAdditions([tool('apps.get')], allowed).map((t) => t.id)).toEqual([
      'apps.update',
    ]);
  });
});

describe('intención de trabajo sobre tablas', () => {
  it('reconoce la frase con typos de la conversación real', () => {
    for (const f of [
      'Edita la aplicaicón, para que al elegir la Doli se tenga en cuenta este tarfiario',
      'en operario, donde debo seleccionar el dollie',
      'agrega una columna a la tabla',
    ]) {
      const families = intentFamilies(f);
      expect(families, f).toContain('trackers');
      expect(families, f).toContain('apps');
    }
  });
});
