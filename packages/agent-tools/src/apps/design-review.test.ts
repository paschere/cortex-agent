import { describe, expect, it } from 'vitest';
import type { TrackerField } from '../trackers/schema';
import { type ViewSpec, viewSpecSchema } from '../views/spec';
import type { AppDraft } from './design';
import { humanizeTitle, looksTechnical, reviewAppDesign } from './design-review';
import { buildScreenFromPattern } from './screen-patterns';

const f = (x: Partial<TrackerField> & Pick<TrackerField, 'key' | 'type'>): TrackerField =>
  ({ label: x.key, required: false, ...x }) as TrackerField;

const PEDIDOS = {
  slug: 'pedidos',
  name: 'Pedidos',
  fields: [
    f({ key: 'referencia', label: 'Referencia', type: 'text', required: true }),
    f({ key: 'cliente', label: 'Cliente', type: 'text' }),
    f({ key: 'fecha', label: 'Fecha', type: 'date' }),
    f({ key: 'estado', label: 'Estado', type: 'select', options: ['Nuevo', 'En ruta', 'Entregado'] }),
    f({ key: 'total', label: 'Total', type: 'money' }),
    f({ key: 'direccion', label: 'Dirección', type: 'text' }),
    f({ key: 'foto', label: 'Foto', type: 'file', accept: 'image' }),
    f({ key: 'nota', label: 'Nota', type: 'longtext' }),
    f({ key: 'telefono', label: 'Teléfono', type: 'text' }),
    f({ key: 'canal', label: 'Canal', type: 'select', options: ['Web', 'Tienda'] }),
  ],
};

const spec = (blocks: unknown[], theme?: unknown): ViewSpec =>
  viewSpecSchema.parse({ version: 1, blocks, ...(theme ? { theme } : {}) });

const operario = {
  key: 'operario',
  name: 'Operario',
  description: '',
  permissions: {
    tables: { pedidos: { read: 'own' as const, create: true, edit: 'own' as const, actions: [] } },
    export: false,
  },
};
const gerencia = {
  key: 'gerencia',
  name: 'Gerencia',
  description: '',
  permissions: {
    tables: { pedidos: { read: 'all' as const, create: false, edit: 'none' as const, actions: [] } },
    export: true,
  },
};

const draftOf = (screens: Array<{ title: string; roles: string[]; spec: ViewSpec }>): AppDraft => ({
  name: 'App',
  description: '',
  roles: [operario, gerencia] as AppDraft['roles'],
  screens: screens.map((s, i) => ({ ...s, slug: `p${i + 1}`, icon: 'Home' })),
  homeScreen: 'p1',
  tables: [],
});

describe('titulos', () => {
  it('detecta nombres técnicos y los vuelve humanos', () => {
    expect(looksTechnical('ventas_por_mes')).toBe(true);
    expect(looksTechnical('cortex.invoices')).toBe(true);
    expect(looksTechnical('totalVentas')).toBe(true);
    expect(looksTechnical('Ventas por mes')).toBe(false);
    expect(looksTechnical('pedidos', new Set(['pedidos']))).toBe(true);
    expect(humanizeTitle('ventas_por_mes')).toBe('Ventas por mes');
    expect(humanizeTitle('totalVentas')).toBe('Total ventas');
    expect(humanizeTitle('pedidos', new Map([['pedidos', 'Pedidos']]))).toBe('Pedidos');
  });
});

describe('reviewAppDesign', () => {
  it('corrige lo seguro: pesos, títulos, detalle, pasos, tarjetas y operario', () => {
    const draft = draftOf([
      {
        title: 'registro_pedidos',
        roles: ['operario'],
        spec: spec([
          { id: 'form', type: 'form', tracker: 'pedidos', title: 'pedidos', fields: [] },
          { id: 'lista', type: 'table', tracker: 'pedidos', title: 'Mis pedidos', columns: ['referencia', 'cliente', 'fecha', 'estado', 'total'] },
        ]),
      },
      {
        title: 'Resumen',
        roles: ['gerencia'],
        spec: spec([
          { id: 'g1', type: 'chart', tracker: 'pedidos', title: 'Por mes', groupBy: 'fecha', aggregate: 'sum', field: 'total' },
          { id: 'm1', type: 'metric', tracker: 'pedidos', title: 'Ventas', aggregate: 'sum', field: 'total' },
          { id: 'm2', type: 'metric', tracker: 'pedidos', title: 'Pedidos' },
        ]),
      },
    ]);
    const r = reviewAppDesign(draft, [PEDIDOS]);
    const [reg, res] = r.draft.screens;
    expect(reg?.title).toBe('Registro pedidos');
    expect(reg?.spec.theme?.layout).toBe('operator');
    const form = reg?.spec.blocks.find((b) => b.type === 'form');
    expect(form && form.type === 'form' ? form.steps?.length : 0).toBeGreaterThan(1);
    expect(reg?.spec.blocks.some((b) => b.type === 'cards')).toBe(true);
    expect(reg?.spec.blocks.some((b) => b.type === 'table')).toBe(false);
    expect(reg?.spec.blocks.some((b) => b.type === 'detail')).toBe(true);
    const chart = res?.spec.blocks.find((b) => b.type === 'chart');
    expect(chart && chart.type === 'chart' ? chart.format : '').toBe('money');
    // las métricas suben y quedan en fila de 2
    expect(res?.spec.blocks.map((b) => b.type).slice(0, 2)).toEqual(['metric', 'metric']);
    expect(res?.spec.blocks[0]?.width).toBe('half');
    expect(r.fixes.length).toBeGreaterThanOrEqual(6);
    expect(r.notes.filter((n) => n.rule !== 'inicio_por_rol')).toEqual([]);
  });

  it('una pantalla ya bien hecha (del catálogo) no cambia ni genera notas', () => {
    const built = buildScreenFromPattern('panel_gerencial', PEDIDOS, { roles: ['gerencia'] });
    const mine = buildScreenFromPattern('mi_lista_hoy', PEDIDOS, { roles: ['operario'] });
    if (!built.ok || !mine.ok) throw new Error('patrón');
    const draft = draftOf([mine.screen, built.screen]);
    const r = reviewAppDesign(draft, [PEDIDOS]);
    expect(r.fixes).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it('un solo bloque grande recibe cifras arriba', () => {
    const draft = draftOf([
      {
        title: 'Todo',
        roles: ['gerencia'],
        spec: spec([{ id: 't', type: 'table', tracker: 'pedidos', title: 'Pedidos', columns: ['referencia', 'estado'] }]),
      },
    ]);
    const r = reviewAppDesign(draft, [PEDIDOS]);
    const types = r.draft.screens[0]?.spec.blocks.map((b) => b.type);
    expect(types?.[0]).toBe('metric');
    expect(types).toContain('table');
    expect(r.notes.find((n) => n.rule === 'un_solo_bloque')).toBeUndefined();
  });

  it('más de 8 bloques se parten en páginas', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      type: 'chart',
      tracker: 'pedidos',
      title: `Gráfico ${i + 1}`,
      groupBy: 'estado',
      width: 'half',
    }));
    const draft = draftOf([{ title: 'Muchos', roles: ['gerencia'], spec: spec(blocks) }]);
    const r = reviewAppDesign(draft, [PEDIDOS]);
    expect(r.draft.screens[0]?.spec.pages?.length).toBeGreaterThan(1);
    expect(r.notes.find((n) => n.rule === 'pantalla_larga')).toBeUndefined();
  });

  it('demasiados bloques fuertes con página ya definida quedan como nota', () => {
    const strong = ['board', 'board', 'board'].map((t, i) => ({
      id: `b${i}`,
      type: t,
      tracker: 'pedidos',
      title: `Tablero ${i + 1}`,
      groupBy: 'estado',
    }));
    const base = spec([
      ...strong,
      { id: 'd', type: 'detail', tracker: 'pedidos' },
    ]);
    const withPage = { ...base, pages: [{ id: 'a', title: 'Todo', blockIds: ['b0', 'b1', 'b2', 'd'] }] };
    const draft = draftOf([{ title: 'Tableros', roles: ['gerencia'], spec: withPage }]);
    const r = reviewAppDesign(draft, [PEDIDOS]);
    expect(r.notes.some((n) => n.rule === 'jerarquia')).toBe(true);
  });

  it('énfasis strong de más baja a normal cuando el bloque trae design', () => {
    const blocks = ['a', 'b', 'c'].map((id) => ({
      id,
      type: 'chart',
      tracker: 'pedidos',
      title: `G ${id}`,
      groupBy: 'estado',
    }));
    const s = spec(blocks);
    for (const b of s.blocks) (b as unknown as { design: object }).design = { emphasis: 'strong' };
    const r = reviewAppDesign(draftOf([{ title: 'Panel', roles: ['gerencia'], spec: s }]), [PEDIDOS]);
    const emph = r.draft.screens[0]?.spec.blocks.map((b) => (b as unknown as { design?: { emphasis?: string } }).design?.emphasis);
    expect(emph?.filter((e) => e === 'strong')).toHaveLength(2);
  });

  it('colores de estado consistentes: alinea al campo del tablero', () => {
    const draft = draftOf([
      {
        title: 'Operación',
        roles: ['gerencia'],
        spec: spec([
          { id: 'tab', type: 'board', tracker: 'pedidos', title: 'Estado', groupBy: 'estado' },
          { id: 'cards', type: 'cards', tracker: 'pedidos', title: 'Lista', statusField: 'canal' },
          { id: 'det', type: 'detail', tracker: 'pedidos' },
        ]),
      },
    ]);
    const r = reviewAppDesign(draft, [PEDIDOS]);
    const cards = r.draft.screens[0]?.spec.blocks.find((b) => b.type === 'cards');
    expect(cards && cards.type === 'cards' ? cards.statusField : '').toBe('estado');
  });

  it('avisa si un rol de planta aterriza en un tablero de gráficos', () => {
    const draft = draftOf([
      {
        title: 'Gráficos',
        roles: [],
        spec: spec([
          { id: 'c1', type: 'chart', tracker: 'pedidos', title: 'Por estado', groupBy: 'estado' },
          { id: 'c2', type: 'chart', tracker: 'pedidos', title: 'Por canal', groupBy: 'canal' },
        ]),
      },
    ]);
    const r = reviewAppDesign(draft, [PEDIDOS]);
    expect(r.notes.some((n) => n.rule === 'inicio_por_rol' && n.message.includes('Operario'))).toBe(true);
  });

  it('descarta una corrección que rompe la pantalla (tabla desconocida)', () => {
    const draft = draftOf([
      {
        title: 'ventas_x',
        roles: ['gerencia'],
        spec: spec([{ id: 'm', type: 'metric', tracker: 'pedidos', title: 'Pedidos' }]),
      },
    ]);
    // Sin la tabla en el catálogo el título se arregla igual (no depende de ella) pero el chequeo contra tablas falla.
    const r = reviewAppDesign(draft, []);
    expect(r.draft.screens[0]?.title).toBe('ventas_x');
    expect(r.notes.some((n) => n.rule === 'autocorreccion_descartada')).toBe(true);
  });
});

describe('plantillas existentes', () => {
  it('revisarlas no rompe ninguna pantalla', async () => {
    const { APP_TEMPLATES } = await import('./templates');
    for (const t of APP_TEMPLATES) {
      const draft = {
        name: t.name,
        description: '',
        roles: t.roles,
        screens: t.screens.map((s) => ({ ...s })),
        homeScreen: t.homeScreen,
        tables: [],
      } as unknown as AppDraft;
      const r = reviewAppDesign(draft, t.trackers);
      expect(r.notes.filter((n) => n.rule === 'autocorreccion_descartada'), t.id).toEqual([]);
      expect(r.draft.screens).toHaveLength(t.screens.length);
    }
  });
});
