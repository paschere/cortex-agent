import { describe, expect, it } from 'vitest';
import { type ViewSource, computeView } from './compute';
import { type CatalogTracker, checkSpecAgainst, viewSpecSchema } from './spec';

/**
 * Formularios compuestos: líneas con monto al instante, varias secciones y un
 * formulario que completa un registro que ya existe (comenzar y cerrar una atención).
 */

const f = (key: string, type: string, extra: object = {}) => ({
  key,
  label: key,
  type,
  required: false,
  ...extra,
});

const atenciones: CatalogTracker = {
  slug: 'atenciones',
  name: 'Atenciones',
  fields: [
    f('vuelo', 'text'),
    f('estado', 'select', { options: ['En curso', 'Terminada'] }),
    f('novedades', 'longtext'),
  ] as never,
};
const tarifas: CatalogTracker = {
  slug: 'tarifas',
  name: 'Tarifas',
  fields: [f('equipo', 'text'), f('precio', 'money')] as never,
};
const usados: CatalogTracker = {
  slug: 'equipos_usados',
  name: 'Equipos usados',
  fields: [
    f('atencion', 'relation', { tracker: 'atenciones' }),
    f('tarifa', 'relation', { tracker: 'tarifas' }),
    f('precio_unit', 'money', { lookup: { via: 'tarifa', field: 'precio' } }),
    f('cantidad', 'number'),
    f('costo', 'money', { formula: '[cantidad] × [precio_unit]' }),
  ] as never,
};
const materiales: CatalogTracker = {
  slug: 'materiales',
  name: 'Materiales',
  fields: [
    f('atencion', 'relation', { tracker: 'atenciones' }),
    f('mat', 'relation', { tracker: 'tarifas' }),
    f('cant', 'number'),
  ] as never,
};
const catalog = [atenciones, tarifas, usados, materiales];

const A = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const rel = (id: string, label: string) => JSON.stringify({ id, label });

const spec = (over: Record<string, unknown> = {}) =>
  viewSpecSchema.parse({
    version: 1,
    blocks: [
      {
        id: 'cierre',
        type: 'form',
        title: 'Cerrar atención',
        tracker: 'atenciones',
        fields: ['estado', 'novedades'],
        onRecord: true,
        lines: {
          tracker: 'equipos_usados',
          parent: 'atencion',
          item: 'tarifa',
          qty: 'cantidad',
          title: 'Equipos usados',
          amount: 'costo',
        },
        moreLines: [
          {
            tracker: 'materiales',
            parent: 'atencion',
            item: 'mat',
            qty: 'cant',
            title: 'Materiales',
          },
        ],
        ...over,
      },
      { id: 'ficha', type: 'detail', tracker: 'atenciones', completeWith: 'cierre' },
    ],
  });

describe('formulario compuesto: spec', () => {
  it('cuadra con las tablas (monto calculado, dos secciones, onRecord con detalle)', () => {
    expect(checkSpecAgainst(spec(), catalog)).toEqual([]);
  });
  it('el monto tiene que calcularse solo', () => {
    const s = spec({
      lines: {
        tracker: 'equipos_usados',
        parent: 'atencion',
        item: 'tarifa',
        qty: 'cantidad',
        amount: 'cantidad',
      },
    });
    expect(checkSpecAgainst(s, catalog).join(' ')).toMatch(/calcularse solo/);
  });
  it('dos secciones no pueden usar la misma tabla hija', () => {
    const s = spec({
      moreLines: [
        { tracker: 'equipos_usados', parent: 'atencion', item: 'tarifa', qty: 'cantidad' },
      ],
    });
    expect(checkSpecAgainst(s, catalog).join(' ')).toMatch(/su propia tabla hija/);
  });
  it('onRecord sin un detalle que lo nombre se avisa', () => {
    const s = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'cierre',
          type: 'form',
          title: 'x',
          tracker: 'atenciones',
          fields: ['estado'],
          onRecord: true,
        },
      ],
    });
    expect(checkSpecAgainst(s, catalog).join(' ')).toMatch(/completeWith/);
  });
});

describe('formulario compuesto: lo que llega al navegador', () => {
  const src = (t: CatalogTracker, rows: ViewSource['rows'] = []): [string, ViewSource] => [
    t.slug,
    { tracker: t, rows, truncated: false },
  ];
  const at = '2026-10-20T10:00:00Z';
  const row = (id: string, values: Record<string, string | number>) => ({
    id,
    label: id,
    values,
    created_at: at,
    updated_at: at,
  });
  const sources = new Map<string, ViewSource>([
    src(atenciones, [row(A, { vuelo: 'AV1', estado: 'En curso' })]),
    src(tarifas, [row(T1, { equipo: 'Dolly', precio: 100 })]),
    src(usados, [
      row('u1', {
        atencion: rel(A, 'AV1'),
        tarifa: rel(T1, 'Dolly'),
        precio_unit: 100,
        cantidad: 3,
        costo: 300,
      }),
    ]),
    src(materiales),
  ]);

  it('trae el registro abierto: valores y líneas guardadas con su tarifa', () => {
    const view = computeView(spec(), sources, new Date('2026-10-20T12:00:00Z'), {
      writable: true,
      record: { rowId: A, blockId: 'ficha' },
    });
    const form = view.blocks.find((b) => b.id === 'cierre');
    expect(form?.type).toBe('form');
    if (form?.type !== 'form') return;
    expect(form.onRecord).toBe(true);
    expect(form.record?.values.estado).toBe('En curso');
    expect(form.record?.lines.__lines).toEqual([
      { item: { id: T1, label: 'Dolly' }, qty: 3, pick: { precio_unit: 100 } },
    ]);
    expect(form.record?.lines.__lines2).toEqual([]);
    // El monto de cada línea se calcula en el navegador con los campos de la tabla hija.
    expect(form.lines?.amount?.key).toBe('costo');
    expect(form.lines?.amount?.format).toBe('money');
    expect(form.lines?.amount?.fields.map((x) => x.key)).toContain('precio_unit');
    expect(form.moreLines?.[0]?.title).toBe('Materiales');
    const detail = view.blocks.find((b) => b.id === 'ficha');
    expect(detail?.type === 'detail' && detail.completeWith).toBe('cierre');
  });

  it('sin registro abierto el formulario no trae record', () => {
    const view = computeView(spec(), sources, new Date('2026-10-20T12:00:00Z'), { writable: true });
    const form = view.blocks.find((b) => b.id === 'cierre');
    expect(form?.type === 'form' && form.record).toBeFalsy();
  });
});

describe('Buscar en una lista dentro de un formulario', () => {
  const vuelos: CatalogTracker = {
    slug: 'vuelos',
    name: 'Vuelos',
    fields: [
      f('numero_vuelo', 'text', {
        match: {
          from: 'numero_vuelo',
          extract: { mode: 'prefix', length: 2 },
          source: 'cortex.aerolineas',
          key: 'codigo',
          fills: { aerolinea: 'nombre' },
        },
      }),
      f('aerolinea', 'text'),
    ] as never,
  };
  it('el bloque trae sólo las columnas usadas de la lista de la plataforma', () => {
    const s = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'reg',
          type: 'form',
          title: 'Vuelo',
          tracker: 'vuelos',
          fields: ['numero_vuelo', 'aerolinea'],
        },
      ],
    });
    const view = computeView(
      s,
      new Map([['vuelos', { tracker: vuelos, rows: [], truncated: false }]]),
      new Date(),
      { writable: true },
    );
    const form = view.blocks[0];
    expect(form?.type).toBe('form');
    if (form?.type !== 'form') return;
    const table = form.matchTables?.['cortex.aerolineas'];
    expect(table?.key).toBe('codigo');
    const av = table?.rows.find((r) => r.codigo === 'AV');
    expect(av).toEqual({ codigo: 'AV', nombre: 'Avianca' });
    expect(form.fields[0]?.match?.fills).toEqual({ aerolinea: 'nombre' });
  });
});
