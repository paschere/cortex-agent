import { describe, expect, it } from 'vitest';
import type { ViewRow, ViewSource } from '../views/compute';
import {
  computeTableroFromSources,
  parseTableros,
  roleProfileOf,
  suggestTableros,
  tableroProblems,
  tableroSchema,
  tablerosForRole,
} from './tablero';

const tracker = {
  slug: 'envios',
  name: 'Envíos',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Recibido', 'En ruta', 'Entregado'],
    },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    { key: 'vence', label: 'Vence', type: 'date', required: false },
  ],
} as never;

const now = new Date('2026-10-12T15:00:00Z');
const row = (
  id: string,
  values: Record<string, string | number>,
  created = '2026-10-10T12:00:00Z',
  by = 'u1',
): ViewRow => ({
  id,
  label: `E-${id}`,
  values,
  created_at: created,
  updated_at: created,
  created_by: by,
});
const source = (rows: ViewRow[]): Map<string, ViewSource> =>
  new Map([['envios', { tracker, rows, truncated: false }]]);
const ctx = {
  now,
  user: { id: 'u1', name: 'Ana' },
  basePath: '/apps/x',
  visibleScreens: new Set(['lista']),
};

const base = (widgets: unknown[]) => tableroSchema.parse({ id: 't1', title: 'T', widgets });

describe('tablero: validación', () => {
  it('rechaza ids de widget repetidos', () => {
    const r = tableroSchema.safeParse({
      id: 't1',
      title: 'T',
      widgets: [
        { id: 'a', kind: 'pending', title: 'x', source: 'envios' },
        { id: 'a', kind: 'pending', title: 'y', source: 'envios' },
      ],
    });
    expect(r.success).toBe(false);
  });
  it('detecta tabla, campo, pantalla y rol inexistentes', () => {
    const t = base([
      { id: 'a', kind: 'kpi', title: 'k', source: 'nada' },
      { id: 'b', kind: 'status', title: 's', source: 'envios', field: 'cliente' },
      { id: 'c', kind: 'kpi', title: 'k', source: 'envios', aggregate: 'sum', field: 'cliente' },
      { id: 'd', kind: 'pending', title: 'p', source: 'envios', screen: 'ghost', dateField: 'zzz' },
    ]);
    const problems = tableroProblems([{ ...t, roles: ['fantasma'] }], {
      trackers: [tracker],
      screenSlugs: ['lista'],
      roleKeys: ['operario'],
    });
    const text = problems.join('\n');
    expect(text).toContain('rol que no existe');
    expect(text).toContain('la tabla «nada» no existe');
    expect(text).toContain('no es un campo de opciones');
    expect(text).toContain('no es numérico');
    expect(text).toContain('ghost');
    expect(text).toContain('zzz');
  });
  it('parseTableros descarta lo roto sin tumbar lo bueno', () => {
    const ok = base([]);
    expect(parseTableros([ok, { id: 'X', title: '' }, 'basura']).map((t) => t.id)).toEqual(['t1']);
    expect(parseTableros(null)).toEqual([]);
  });
  it('cada rol ve sólo sus tableros', () => {
    const a = { ...base([]), id: 'a', roles: ['gerencia'] };
    const b = { ...base([]), id: 'b', roles: [] };
    expect(tablerosForRole([a, b], { key: 'operario', admin: false }).map((t) => t.id)).toEqual([
      'b',
    ]);
    expect(tablerosForRole([a, b], { key: 'x', admin: true })).toHaveLength(2);
  });
});

describe('tablero: cálculo', () => {
  it('KPI mensual compara con el mes anterior y dibuja la serie', () => {
    const rows = [
      row('1', { valor: 1000 }, '2026-10-02T12:00:00Z'),
      row('2', { valor: 3000 }, '2026-10-05T12:00:00Z'),
      row('3', { valor: 2000 }, '2026-09-20T12:00:00Z'),
    ];
    const t = base([
      {
        id: 'k',
        kind: 'kpi',
        title: 'Valor',
        source: 'envios',
        aggregate: 'sum',
        field: 'valor',
        period: 'month',
      },
    ]);
    const w = computeTableroFromSources(t, source(rows), ctx).widgets[0];
    expect(w?.kind).toBe('kpi');
    if (w?.kind !== 'kpi') return;
    expect(w.value).toBe(4000);
    expect(w.deltaRatio).toBe(1);
    expect(w.format).toBe('money');
    expect(w.display).toContain('4.000');
    expect(w.series.at(-1)).toBe(4000);
    expect(w.series.at(-2)).toBe(2000);
  });
  it('estado, ranking y pendientes', () => {
    const rows = [
      row('1', { estado: 'Recibido', cliente: 'Andina', vence: '2026-10-01' }),
      row('2', { estado: 'Entregado', cliente: 'Andina', vence: '2026-10-01' }),
      row('3', { estado: 'Recibido', cliente: 'Pacífico', vence: '2026-10-20' }),
    ];
    const t = base([
      { id: 's', kind: 'status', title: 'Estado', source: 'envios', field: 'estado' },
      { id: 'r', kind: 'ranking', title: 'Clientes', source: 'envios', groupBy: 'cliente' },
      {
        id: 'p',
        kind: 'pending',
        title: 'Atrasados',
        source: 'envios',
        screen: 'lista',
        dateField: 'vence',
        filters: [{ field: 'estado', op: 'neq', value: 'Entregado' }],
      },
    ]);
    const [s, r, p] = computeTableroFromSources(t, source(rows), ctx).widgets;
    if (s?.kind !== 'status' || r?.kind !== 'ranking' || p?.kind !== 'pending')
      throw new Error('tipos');
    expect(s.segments.map((x) => [x.label, x.value])).toEqual([
      ['Recibido', 2],
      ['Entregado', 1],
    ]);
    expect(r.items[0]).toMatchObject({ label: 'Andina', value: 2 });
    expect(p.total).toBe(2);
    expect(p.items[0]?.overdue).toBe(true);
    expect(p.items[0]?.href).toBe('/apps/x/lista?fila=1');
    expect(p.items[1]?.overdue).toBe(false);
  });
  it('«lo mío» filtra por creador', () => {
    const rows = [row('1', {}, undefined, 'u1'), row('2', {}, undefined, 'u2')];
    const t = base([
      { id: 'p', kind: 'pending', title: 'Mis', source: 'envios', mine: { by: 'creator' } },
    ]);
    const w = computeTableroFromSources(t, source(rows), ctx).widgets[0];
    expect(w?.kind === 'pending' && w.total).toBe(1);
  });
  it('un widget sobre una fuente bloqueada o ausente no aparece', () => {
    const t = base([{ id: 'k', kind: 'kpi', title: 'k', source: 'envios' }]);
    const blocked = new Map([
      ['envios', { tracker, rows: [], truncated: false, blocked: 'sin permiso' }],
    ]) as Map<string, ViewSource>;
    expect(computeTableroFromSources(t, blocked, ctx).widgets).toHaveLength(0);
    expect(computeTableroFromSources(t, new Map(), ctx).widgets).toHaveLength(0);
  });
  it('un gráfico trae los registros para abrir un punto', () => {
    const t = base([
      { id: 'c', kind: 'chart', title: 'Por día', source: 'envios', screen: 'lista' },
    ]);
    const w = computeTableroFromSources(t, source([row('1', {}), row('2', {})]), ctx).widgets[0];
    expect(w?.kind === 'chart' && w.metric.records).toHaveLength(2);
    expect(w?.kind === 'chart' && w.metric.daily[0]?.value).toBe(2);
  });
});

describe('tablero: sugerencias por rol', () => {
  it('clasifica roles y arma un tablero por papel', () => {
    expect(roleProfileOf({ key: 'operario', name: 'Operario' })).toBe('operario');
    expect(roleProfileOf({ key: 'jefe_planta', name: 'Jefe' })).toBe('supervisor');
    expect(roleProfileOf({ key: 'gerencia', name: 'Gerencia' })).toBe('gerencia');
    expect(roleProfileOf({ key: 'cliente', name: 'Cliente' })).toBe('cliente');
    const list = suggestTableros({
      trackers: [tracker],
      roles: [
        { key: 'operario', name: 'Operario' },
        { key: 'supervisor', name: 'Supervisor' },
        { key: 'gerencia', name: 'Gerencia' },
        { key: 'cliente', name: 'Cliente' },
      ],
      screen: 'lista',
    });
    expect(list.map((t) => t.title)).toEqual(['Lo mío hoy', 'Equipo y atrasos', 'Indicadores']);
    expect(list.every((t) => t.roles.length === 1 && !t.roles.includes('cliente'))).toBe(true);
    expect(
      tableroProblems(list, {
        trackers: [tracker],
        screenSlugs: ['lista'],
        roleKeys: ['operario', 'supervisor', 'gerencia'],
      }),
    ).toEqual([]);
  });
});
