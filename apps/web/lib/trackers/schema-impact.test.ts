import { checkSpecAgainst, trackersOf, viewSpecSchema } from '@cortex/agent-tools';
import type { CatalogTracker, TrackerField } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  diffSchemas,
  introducedProblems,
  ruleBlockers,
  unsafeRetypes,
  viewsBroken,
} from './schema-impact';

const f = (
  key: string,
  type: TrackerField['type'] = 'text',
  extra: Partial<TrackerField> = {},
): TrackerField => ({
  key,
  label: key.toUpperCase(),
  type,
  required: false,
  ...extra,
});

const before = [
  f('cliente'),
  f('estado', 'select', { options: ['Nuevo', 'Listo'] }),
  f('valor', 'money'),
];

describe('diffSchemas', () => {
  it('detecta quitados, retipados y opciones perdidas', () => {
    const after = [f('cliente', 'longtext'), f('estado', 'select', { options: ['Nuevo'] })];
    const d = diffSchemas(before, after);
    expect(d.removed.map((r) => r.key)).toEqual(['valor']);
    expect(d.retyped).toEqual([{ key: 'cliente', label: 'CLIENTE', from: 'text', to: 'longtext' }]);
    expect(d.droppedOptions).toEqual([{ key: 'estado', label: 'ESTADO', options: ['Listo'] }]);
  });
  it('agregar o reordenar no cuenta', () => {
    const d = diffSchemas(before, [f('nuevo'), ...before]);
    expect(d).toEqual({ removed: [], retyped: [], droppedOptions: [] });
  });
});

describe('impacto en vistas', () => {
  const spec = viewSpecSchema.parse({
    version: 1,
    title: 'Ventas',
    blocks: [
      {
        id: 'lista',
        type: 'table',
        tracker: 'pedidos',
        title: 'Pedidos',
        columns: ['cliente', 'valor'],
      },
      {
        id: 'total',
        type: 'metric',
        tracker: 'pedidos',
        title: 'Total',
        aggregate: 'sum',
        field: 'valor',
      },
      { id: 'otra', type: 'table', tracker: 'otra', title: 'Otra', columns: [] },
    ],
  });
  const cat = (fields: TrackerField[]): CatalogTracker[] => [
    { slug: 'pedidos', name: 'Pedidos', fields },
    { slug: 'otra', name: 'Otra', fields: [] },
  ];

  it('una vista que usa el campo quitado queda marcada, con el bloque', () => {
    const after = before.filter((x) => x.key !== 'valor');
    const out = viewsBroken(
      [{ id: 'v1', slug: 'ventas', name: 'Ventas', spec }],
      (s) => trackersOf(s).includes('pedidos'),
      (s, which) => checkSpecAgainst(s, cat(which === 'before' ? before : after)),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.problems.join(' ')).toMatch(/lista|total/);
  });

  it('quitar un campo que ninguna vista usa no rompe nada', () => {
    const after = before.filter((x) => x.key !== 'estado');
    const out = viewsBroken(
      [{ id: 'v1', slug: 'ventas', name: 'Ventas', spec }],
      () => true,
      (s, which) => checkSpecAgainst(s, cat(which === 'before' ? before : after)),
    );
    expect(out).toEqual([]);
  });

  it('un problema que la vista ya tenía no se le achaca al cambio', () => {
    expect(introducedProblems(['a', 'b'], ['b', 'c'])).toEqual(['c']);
  });
});

describe('bloqueos por reglas y sincronizaciones', () => {
  const diff = diffSchemas(before, [f('estado', 'select', { options: ['Nuevo', 'Listo'] })]);
  it('la columna clave de una sincronización bloquea', () => {
    const b = ruleBlockers(diff, [{ kind: 'table_sync', keyFields: ['cliente'] }], null);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatch(/columna clave/);
  });
  it('la regla de duplicados bloquea sólo si la regla nueva sigue usando el campo', () => {
    expect(ruleBlockers(diff, [], { key: 'cliente', flagField: 'estado' })[0]).toMatch(
      /duplicados/,
    );
    expect(ruleBlockers(diff, [], null)).toEqual([]);
  });
  it('«Qué se mide» también bloquea', () => {
    expect(ruleBlockers(diff, [], null, [{ key: 'valor', where: 'la medición' }])[0]).toMatch(
      /medición/,
    );
  });
  it('retipar con datos sólo se permite entre tipos compatibles', () => {
    const d = diffSchemas([f('a'), f('b', 'number')], [f('a', 'number'), f('b', 'money')]);
    const bad = unsafeRetypes(d, { a: 4, b: 9 });
    expect(bad.map((x) => x.key)).toEqual(['a']);
    expect(unsafeRetypes(d, { a: 0, b: 9 })).toEqual([]);
  });
});
