import { describe, expect, it } from 'vitest';
import { computeView } from '../../views/compute';
import type { ViewSource } from '../../views/compute';
import {
  type AppHome,
  type HomeCard,
  appBrandPatchSchema,
  appBrandSchema,
  appHomeSchema,
  cardText,
  cardsForRole,
  fillCardText,
  greetingFor,
  homeEnabled,
  homeSpecFor,
  lastDays,
  mergeBrand,
  parseBrand,
  parseHome,
  resolveFilterTokens,
  seriesFromPoints,
  seriesPlan,
} from '../appearance';
import { type ResolvedRole, adminRole, rowScopeFor } from '../permissions';

/**
 * LA APARIENCIA Y EL INICIO DE UNA APP (0215), lo puro: la marca que se
 * mezcla por partes, el texto de las tarjetas, qué tarjetas ve cada rol y que
 * las cifras se cuentan con el scope de filas del rol.
 */

const NOW = new Date('2026-10-07T15:00:00Z'); // 10:00 en Bogotá

const operario: ResolvedRole = {
  key: 'operario',
  name: 'Operario',
  admin: false,
  permissions: {
    tables: {
      vuelos: { read: 'all', create: true, edit: 'none', actions: [] },
      guias: { read: 'own', create: true, edit: 'own', actions: [] },
    },
    export: false,
  },
};
const cliente: ResolvedRole = {
  key: 'cliente',
  name: 'Cliente',
  admin: false,
  permissions: {
    tables: {
      vuelos: {
        read: { field: 'cliente', equals: '$user.cliente' },
        create: false,
        edit: 'none',
        actions: [],
      },
    },
    export: false,
  },
};
const ana = { id: 'ana', name: 'Ana Pérez', attributes: { cliente: 'Andina' } };

const counter: HomeCard = {
  id: 'hoy',
  kind: 'counter',
  roles: [],
  tone: 'primary',
  source: 'vuelos',
  filters: [{ field: 'fecha', op: 'eq', value: '{hoy}' }],
  text: 'Hoy llegan {n} vuelos',
  zeroText: 'Aún no hay vuelos hoy',
  screen: 'vuelos',
};
const pending: HomeCard = {
  id: 'dup',
  kind: 'pending',
  roles: ['operario'],
  tone: 'amber',
  source: 'guias',
  filters: [{ field: 'estado', op: 'eq', value: 'Duplicado' }],
  text: '{n} guías duplicadas por corregir',
  screen: 'guias',
  openFilterId: 'estado',
  openFilterValue: 'Duplicado',
};
const shortcut: HomeCard = {
  id: 'reg',
  kind: 'shortcut',
  roles: [],
  tone: 'primary',
  label: 'Registrar atención',
  screen: 'registrar',
};
const HOME: AppHome = { enabled: true, greeting: true, cards: [counter, pending, shortcut] };

describe('marca de la app', () => {
  it('mezcla por partes: null borra, ausente deja, los archivos no se tocan', () => {
    const base = parseBrand({
      primary: '#112233',
      shortName: 'Planta',
      font: 'serif',
      files: { logo: { v: 'abcdef0123456789', t: 'png' } },
    });
    const next = mergeBrand(base, { primary: null, accent: '#abcdef', font: undefined });
    expect(next.primary).toBeUndefined();
    expect(next.accent).toBe('#abcdef');
    expect(next.shortName).toBe('Planta');
    expect(next.font).toBe('serif');
    expect(next.files?.logo?.v).toBe('abcdef0123456789');
  });

  it('rechaza colores y fuentes que no son, y nombres cortos de más de 12', () => {
    expect(appBrandSchema.safeParse({ primary: 'rojo' }).success).toBe(false);
    expect(appBrandSchema.safeParse({ font: 'comic' }).success).toBe(false);
    expect(appBrandSchema.safeParse({ shortName: 'x'.repeat(13) }).success).toBe(false);
    expect(appBrandPatchSchema.safeParse({ primary: '#fff', font: null }).success).toBe(true);
  });

  it('el chat no puede escribir archivos: el patch no los conoce', () => {
    const parsed = appBrandPatchSchema.parse({
      primary: '#123456',
      files: { logo: { v: '00000000', t: 'png' } },
    });
    expect('files' in parsed).toBe(false);
  });

  it('una marca guardada rota se lee como vacía, no revienta', () => {
    expect(parseBrand({ primary: 42 })).toEqual({});
    expect(parseBrand(null)).toEqual({});
  });
});

describe('textos de las tarjetas', () => {
  it('pone la cifra con separador de miles y usa el texto de cero', () => {
    expect(fillCardText('Hoy llegan {n} vuelos', 3)).toBe('Hoy llegan 3 vuelos');
    expect(fillCardText('{n} por revisar', 1250)).toMatch(/^1[.  ]?250 por revisar$/);
    expect(cardText(counter as HomeCard & { kind: 'counter' }, 0)).toBe('Aún no hay vuelos hoy');
    expect(cardText(pending as HomeCard & { kind: 'pending' }, 2)).toBe(
      '2 guías duplicadas por corregir',
    );
  });

  it('{hoy}, {ayer} y {manana} son fechas de Bogotá', () => {
    const [a, b, c, d] = resolveFilterTokens(
      [{ value: '{hoy}' }, { value: '{ayer}' }, { value: '{manana}' }, { value: 'Pendiente' }],
      NOW,
    );
    expect(a?.value).toBe('2026-10-07');
    expect(b?.value).toBe('2026-10-06');
    expect(c?.value).toBe('2026-10-08');
    expect(d?.value).toBe('Pendiente');
  });

  it('el saludo sigue la hora de Bogotá y usa el primer nombre', () => {
    expect(greetingFor('Ana Pérez', NOW).title).toBe('Buenos días, Ana');
    expect(greetingFor('Ana Pérez', new Date('2026-10-07T20:00:00Z')).title).toBe(
      'Buenas tardes, Ana',
    );
    expect(greetingFor('', new Date('2026-10-08T03:00:00Z')).title).toBe('Buenas noches');
    expect(greetingFor('Ana', NOW).date).toMatch(/miércoles/);
  });
});

describe('tarjetas por rol', () => {
  const screens = new Set(['vuelos', 'guias', 'registrar']);

  it('cada rol ve las suyas; el administrador, todas', () => {
    const ids = (role: ResolvedRole) => cardsForRole(HOME, role, screens, ana).map((c) => c.id);
    expect(ids(operario)).toEqual(['hoy', 'dup', 'reg']);
    // El cliente no lee «guias»: la tarjeta de pendientes (además de ser de otro rol) no aparece.
    expect(ids(cliente)).toEqual(['hoy', 'reg']);
    expect(ids(adminRole())).toEqual(['hoy', 'dup', 'reg']);
  });

  it('una tarjeta sobre una tabla que el rol no lee no aparece, aunque el rol esté en su lista', () => {
    const home: AppHome = { ...HOME, cards: [{ ...pending, roles: [] }] };
    expect(cardsForRole(home, cliente, screens, ana)).toEqual([]);
  });

  it('un acceso directo a una pantalla que el rol no ve no se ofrece', () => {
    const only = new Set(['vuelos']);
    expect(cardsForRole(HOME, operario, only, ana).map((c) => c.id)).toEqual(['hoy', 'dup']);
  });

  it('las cifras se cuentan con el scope de filas del rol', () => {
    const spec = homeSpecFor(cardsForRole(HOME, operario, screens, ana), NOW);
    expect(spec).not.toBeNull();
    if (!spec) return;
    const scope = rowScopeFor(operario, ana, spec);
    expect(scope.find((s) => s.tracker === 'guias')?.access).toEqual({
      kind: 'own',
      userId: 'ana',
    });
    expect(scope.find((s) => s.tracker === 'vuelos')?.access.kind).toBe('all');
    // El cliente cuenta sólo los vuelos de SU cliente.
    const specCliente = homeSpecFor(cardsForRole(HOME, cliente, screens, ana), NOW);
    expect(
      rowScopeFor(cliente, ana, specCliente as NonNullable<typeof specCliente>)[0]?.access,
    ).toEqual({
      kind: 'equals',
      field: 'cliente',
      value: 'Andina',
    });
  });

  it('el spec lleva una cifra por tarjeta y 3 filas de ejemplo por pendiente, con la fecha de hoy ya puesta', () => {
    const spec = homeSpecFor([counter, pending], NOW);
    expect(spec?.blocks.map((b) => b.id)).toEqual(['n_hoy', 's_hoy', 'n_dup', 'r_dup']);
    const metric = spec?.blocks[0];
    expect(metric && 'filters' in metric ? metric.filters[0]?.value : null).toBe('2026-10-07');
    const table = spec?.blocks[3];
    expect(table && 'limit' in table ? table.limit : null).toBe(3);
  });

  it('sin tarjetas que cuenten, no hay spec (sólo accesos directos)', () => {
    expect(homeSpecFor([shortcut], NOW)).toBeNull();
  });
});

describe('forma del inicio', () => {
  it('acepta lo válido, repara los valores por defecto y rechaza ids repetidos', () => {
    const parsed = appHomeSchema.parse({
      enabled: true,
      cards: [{ ...shortcut, roles: undefined }],
    });
    expect(parsed.greeting).toBe(true);
    expect(parsed.cards[0]?.roles).toEqual([]);
    expect(appHomeSchema.safeParse({ enabled: true, cards: [shortcut, shortcut] }).success).toBe(
      false,
    );
    expect(
      appHomeSchema.safeParse({
        cards: new Array(9).fill(0).map((_, i) => ({ ...shortcut, id: `a${i}` })),
      }).success,
    ).toBe(false);
  });

  it('un JSON guardado roto es «sin inicio»', () => {
    expect(parseHome({})).toMatchObject({ enabled: false });
    expect(parseHome('basura')).toBeNull();
    expect(homeEnabled(parseHome({}))).toBe(false);
    expect(homeEnabled(HOME)).toBe(true);
  });
});

describe('micrográfico de las tarjetas (series)', () => {
  const plain: HomeCard = {
    ...counter,
    id: 'nuevos',
    filters: [{ field: 'estado', op: 'eq', value: 'Activo' }],
  };

  it('sin fecha de hoy en los filtros cuenta por día de creación con los mismos filtros', () => {
    expect(seriesPlan(plain)).toEqual({ groupBy: 'created_at', filters: plain.filters });
  });

  it('con {hoy} en un solo campo, ese campo es el día y su filtro de fecha se suelta', () => {
    const extra: HomeCard = {
      ...counter,
      filters: [...counter.filters, { field: 'estado', op: 'eq', value: 'Activo' }],
    };
    expect(seriesPlan(extra)).toEqual({
      groupBy: 'fecha',
      filters: [{ field: 'estado', op: 'eq', value: 'Activo' }],
    });
  });

  it('no hay serie para pendientes, accesos directos ni fechas en varios campos u otros operadores', () => {
    expect(seriesPlan(pending)).toBeNull();
    expect(seriesPlan(shortcut)).toBeNull();
    const two: HomeCard = {
      ...counter,
      filters: [
        { field: 'a', op: 'eq', value: '{hoy}' },
        { field: 'b', op: 'eq', value: '{ayer}' },
      ],
    };
    expect(seriesPlan(two)).toBeNull();
    expect(
      seriesPlan({ ...counter, filters: [{ field: 'fecha', op: 'gte', value: '{hoy}' }] }),
    ).toBeNull();
  });

  it('los últimos 7 días acaban hoy en la fecha de Bogotá', () => {
    expect(lastDays(NOW)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
  });

  it('rellena con cero los días sin filas y descarta lo que cae fuera de la ventana', () => {
    const points = [
      { label: '28 sep 2026', value: 9 },
      { label: '3 oct 2026', value: 2 },
      { label: '7 oct 2026', value: 5 },
      { label: '9 oct 2026', value: 4 },
    ];
    expect(seriesFromPoints(points, NOW)).toEqual([0, 0, 2, 0, 0, 0, 5]);
  });

  it('sin filas en la ventana no hay serie', () => {
    expect(seriesFromPoints([], NOW)).toBeUndefined();
    expect(seriesFromPoints([{ label: '1 ene 2026', value: 3 }], NOW)).toBeUndefined();
  });

  it('el bloque del spec, calculado con filas reales, da la serie del contador', () => {
    const spec = homeSpecFor([plain], NOW);
    expect(spec?.blocks.map((b) => b.id)).toEqual(['n_nuevos', 's_nuevos']);
    if (!spec) return;
    const mk = (id: string, created: string, estado: string) => ({
      id,
      label: id,
      values: { estado },
      created_at: created,
      updated_at: created,
    });
    const sources = new Map<string, ViewSource>([
      [
        'vuelos',
        {
          tracker: {
            slug: 'vuelos',
            name: 'Vuelos',
            fields: [{ key: 'estado', label: 'Estado', type: 'text', required: false }],
          },
          rows: [
            mk('1', '2026-10-07T15:00:00Z', 'Activo'),
            mk('2', '2026-10-07T16:00:00Z', 'Activo'),
            mk('3', '2026-10-05T15:00:00Z', 'Activo'),
            mk('4', '2026-10-06T15:00:00Z', 'Cerrado'),
          ],
          truncated: false,
        },
      ],
    ]);
    const view = computeView(spec, sources, NOW, {
      writable: false,
      audience: 'team',
      filters: {},
    });
    const chart = view.blocks.find((b) => b.id === 's_nuevos');
    if (chart?.type !== 'chart') throw new Error('se esperaba el gráfico');
    // Los filtros de la tarjeta valen: la fila «Cerrado» no cuenta.
    expect(seriesFromPoints(chart.points, NOW)).toEqual([0, 0, 0, 0, 1, 0, 2]);
  });
});
