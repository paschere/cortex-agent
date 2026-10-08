import { describe, expect, it } from 'vitest';
import { addDay, eventsByDay, step, weekDays, weekStart } from './agenda';
import { EMPTY_CARD_FILTER, filterCards, groupCards, pageOf, sortCards } from './cards-filter';
import { type ViewRow, type ViewSource, computeView } from './compute';
import { type RecordHistoryRaw, buildTimeline, findDetailTarget } from './record';
import { type CatalogTracker, checkSpecAgainst, findWriteBlock, viewSpecSchema } from './spec';
import { tvClock, tvSecondsLeft, tvSlideAt, tvSlides } from './tv';

/**
 * Los tipos de pantalla nuevos: detalle de un registro (con relacionados y
 * línea de tiempo), lista de tarjetas con filtros rápidos, agenda por rangos
 * y tablero TV. Aquí se prueba lo que protege: que el scope ya aplicado a las
 * fuentes llegue a los relacionados, que la historia sólo cuente campos que la
 * pantalla muestra, que los filtros y los rangos caigan donde deben.
 */

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const vuelos: CatalogTracker = {
  slug: 'vuelos',
  name: 'Vuelos',
  fields: [
    { key: 'numero', label: 'Número', type: 'text', required: true },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Programado', 'En camino', 'Aterrizó'],
    },
    { key: 'llegada', label: 'Llegada', type: 'date', required: false },
    { key: 'hora', label: 'Hora', type: 'time', required: false },
    { key: 'interno', label: 'Nota interna', type: 'text', required: false },
    { key: 'manifiesto', label: 'Manifiesto', type: 'file', required: false },
  ],
};
const guias: CatalogTracker = {
  slug: 'guias',
  name: 'Guías',
  fields: [
    { key: 'awb', label: 'Guía', type: 'text', required: true },
    { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
    {
      key: 'vuelo_rel',
      label: 'Vuelo (relación)',
      type: 'relation',
      tracker: 'vuelos',
      required: false,
    },
    { key: 'peso', label: 'Peso', type: 'number', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'Entregada'],
    },
  ],
};

const row = (
  id: string,
  label: string,
  values: Record<string, string | number>,
  extra: Partial<ViewRow> = {},
): ViewRow => ({
  id,
  label,
  values,
  created_at: '2026-10-01T15:00:00Z',
  updated_at: '2026-10-02T15:00:00Z',
  ...extra,
});

const V1 = UUID(1);
const V2 = UUID(2);
const VUELOS: ViewRow[] = [
  row(
    V1,
    'AV-204',
    {
      numero: 'AV-204',
      estado: 'En camino',
      llegada: '2026-10-07',
      hora: '14:30',
      interno: 'secreto',
    },
    { created_by: 'u1' },
  ),
  row(
    V2,
    'LA-880',
    { numero: 'LA-880', estado: 'Programado', llegada: '2026-10-08', hora: '09:00' },
    { created_by: 'u2' },
  ),
];
const rel = (id: string) => JSON.stringify({ id, label: 'x' });
const GUIAS: ViewRow[] = [
  row(UUID(11), 'G-1', {
    awb: 'G-1',
    vuelo: 'AV-204',
    vuelo_rel: rel(V1),
    peso: 10,
    estado: 'Pendiente',
  }),
  row(UUID(12), 'G-2', { awb: 'G-2', vuelo: 'av-204', peso: 5, estado: 'Entregada' }),
  row(UUID(13), 'G-3', { awb: 'G-3', vuelo: 'LA-880', vuelo_rel: rel(V2), peso: 7 }),
];

const sources = (g: ViewRow[] = GUIAS, v: ViewRow[] = VUELOS) =>
  new Map<string, ViewSource>([
    ['vuelos', { tracker: vuelos, truncated: false, rows: v }],
    ['guias', { tracker: guias, truncated: false, rows: g }],
  ]);
const NOW = new Date('2026-10-07T17:00:00Z'); // 12:00 en Bogotá, miércoles

const detailBlock = (extra: Record<string, unknown> = {}) => ({
  id: 'detalle',
  type: 'detail',
  tracker: 'vuelos',
  titleField: 'numero',
  statusField: 'estado',
  sections: [
    { title: 'Vuelo', fields: ['llegada', 'hora'] },
    { title: 'Carga', fields: ['manifiesto'] },
  ],
  related: [
    {
      id: 'guias',
      title: 'Guías del vuelo',
      tracker: 'guias',
      field: 'vuelo',
      match: 'value',
      parentField: 'numero',
      columns: ['awb', 'peso', 'estado'],
      actions: [
        {
          id: 'entregar',
          label: 'Entregar',
          kind: 'set_field',
          field: 'estado',
          value: 'Entregada',
        },
      ],
    },
    { id: 'guias_rel', title: 'Por relación', tracker: 'guias', field: 'vuelo_rel' },
  ],
  actions: [],
  ...extra,
});
const spec = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  viewSpecSchema.parse({ version: 1, editing: 'team', blocks, ...extra });

describe('detalle de un registro', () => {
  it('sin fila elegida el detalle queda en reposo', () => {
    const view = computeView(spec([detailBlock()]), sources(), NOW, { writable: true });
    const b = view.blocks[0];
    expect(b?.type === 'detail' && b.state).toBe('idle');
    expect(view.record).toBeNull();
  });

  it('con ?fila= arma cabecera, secciones y relacionados por valor común y por relación', () => {
    const view = computeView(spec([detailBlock()]), sources(), NOW, {
      writable: true,
      record: { rowId: V1 },
    });
    const b = view.blocks[0];
    expect(b?.type).toBe('detail');
    if (b?.type !== 'detail') return;
    expect(b.state).toBe('ready');
    expect(b.header).toMatchObject({ title: 'AV-204', status: { label: 'En camino' } });
    expect(b.sections.map((s) => s.title)).toEqual(['Vuelo']); // «Carga» sin archivo no se pinta
    // Valor común: G-1 y G-2 (sin distinguir mayúsculas); G-3 es de otro vuelo.
    expect(b.related[0]?.rows.map((r) => r.cells[0])).toEqual(
      expect.arrayContaining(['G-1', 'G-2']),
    );
    expect(b.related[0]?.total).toBe(2);
    expect(b.related[0]?.actions.map((a) => a.id)).toEqual(['entregar']);
    // Relación formal: sólo G-1.
    expect(b.related[1]?.rows.map((r) => r.cells[0])).toEqual(['G-1']);
    expect(view.record).toEqual({ blockId: 'detalle', rowId: V1, found: true });
  });

  it('el scope de filas llega a los relacionados: lo que el rol no ve no se lista', () => {
    // El rol «own» ya recortó las guías antes de calcular (loadViewSources).
    const view = computeView(spec([detailBlock()]), sources([GUIAS[0] as ViewRow]), NOW, {
      writable: true,
      record: { rowId: V1 },
    });
    const b = view.blocks[0];
    if (b?.type !== 'detail') throw new Error('detail');
    expect(b.related[0]?.rows.map((r) => r.cells[0])).toEqual(['G-1']);
    expect(b.related[0]?.total).toBe(1);
  });

  it('una fila que el rol no ve se reporta como no encontrada, sin datos', () => {
    const view = computeView(spec([detailBlock()]), sources(GUIAS, [VUELOS[1] as ViewRow]), NOW, {
      record: { rowId: V1 },
    });
    expect(view.record?.found).toBe(false);
    const b = view.blocks[0];
    expect(b?.type === 'detail' && b.state).toBe('missing');
    expect(b?.type === 'detail' && b.header).toBeNull();
  });

  it('una tabla relacionada bloqueada por el rol se pinta como aviso, no como vacía', () => {
    const src = sources();
    src.set('guias', {
      tracker: guias,
      truncated: false,
      rows: [],
      blocked: 'Tu rol en esta aplicación no ve esta tabla.',
    });
    const view = computeView(spec([detailBlock()]), src, NOW, { record: { rowId: V1 } });
    const b = view.blocks[0];
    if (b?.type !== 'detail') throw new Error('detail');
    expect(b.related[0]?.problem).toContain('no ve esta tabla');
    expect(b.related[0]?.rows).toEqual([]);
  });

  it('los campos editables sólo aparecen si quien mira puede escribir', () => {
    const s = spec([detailBlock({ recordEditable: ['llegada'] })]);
    const ro = computeView(s, sources(), NOW, { writable: false, record: { rowId: V1 } });
    const rw = computeView(s, sources(), NOW, { writable: true, record: { rowId: V1 } });
    const item = (v: typeof ro) => {
      const b = v.blocks[0];
      return b?.type === 'detail'
        ? b.sections[0]?.items.find((i) => i.key === 'llegada')
        : undefined;
    };
    expect(item(ro)?.edit).toBeUndefined();
    expect(item(rw)?.edit?.type).toBe('date');
  });

  it('las filas de otros bloques abren el detalle de su tabla', () => {
    const s = spec([
      { id: 'tabla', type: 'table', tracker: 'vuelos', title: 'Vuelos', columns: ['numero'] },
      detailBlock(),
    ]);
    const view = computeView(s, sources(), NOW);
    const t = view.blocks[0];
    expect(t?.type === 'table' && t.record?.detail).toBe('detalle');
  });

  it('findDetailTarget respeta los filtros del detalle', () => {
    const s = spec([detailBlock({ filters: [{ field: 'estado', op: 'eq', value: 'Aterrizó' }] })]);
    expect(findDetailTarget(s, sources(), V1, null, '2026-10-07')).toBeNull();
  });

  it('el id `detalle:lista` escribe sobre la tabla relacionada con sus propios botones', () => {
    const s = spec([detailBlock()]);
    const w = findWriteBlock(s, 'detalle:guias');
    expect(w).toMatchObject({ id: 'detalle', type: 'table', tracker: 'guias' });
    expect(w && 'actions' in w && w.actions.map((a) => a.id)).toEqual(['entregar']);
    expect(findWriteBlock(s, 'detalle:nope')).toBeUndefined();
    expect(findWriteBlock(s, 'detalle')?.type).toBe('detail');
  });
});

describe('línea de tiempo', () => {
  const history: RecordHistoryRaw = {
    created: { at: '2026-10-01T15:00:00Z', by: 'Ana' },
    events: [
      {
        id: 'e1',
        at: '2026-10-02T10:00:00Z',
        kind: 'edit',
        actionId: null,
        by: 'Luis',
        changes: {
          estado: { from: 'Programado', to: 'En camino' },
          interno: { from: 'a', to: 'secreto' },
        },
      },
      {
        id: 'e2',
        at: '2026-10-03T10:00:00Z',
        kind: 'edit',
        actionId: null,
        by: 'Luis',
        changes: { interno: { from: 'a', to: 'b' } },
      },
      {
        id: 'e3',
        at: '2026-10-04T10:00:00Z',
        kind: 'action',
        actionId: '__approve',
        by: 'Marta',
        changes: { estado: { from: 'En camino', to: 'Aterrizó' } },
      },
      {
        id: 'e4',
        at: '2026-10-05T10:00:00Z',
        kind: 'edit',
        actionId: null,
        by: 'Tú',
        changes: {
          manifiesto: {
            from: null,
            to: JSON.stringify({
              url: 'https://x/a.pdf',
              name: 'manifiesto.pdf',
              mime: 'application/pdf',
              size: 10,
            }),
          },
        },
      },
      {
        id: 'e5',
        at: '2026-10-06T10:00:00Z',
        kind: 'action',
        actionId: 'avisar',
        by: 'Tú',
        changes: {},
      },
    ],
    runs: [{ id: 'r1', at: '2026-10-04T10:00:05Z', automation: 'Avisar al cliente', ok: true }],
  };
  const all = new Set(['created', 'changes', 'approvals', 'automations', 'files'] as const);
  const visible = new Set(['estado', 'manifiesto', 'llegada']);
  const build = (show: ReadonlySet<never> | Set<string> = all) =>
    buildTimeline(history, {
      tracker: vuelos,
      visible,
      show: show as never,
      limit: 30,
      labels: new Map([['avisar', 'Avisar al jefe']]),
    });

  it('cuenta creación, cambios con antes → después, aprobación, archivos y automatización, lo nuevo primero', () => {
    const t = build();
    expect(t.map((e) => e.kind)).toEqual([
      'action',
      'file',
      'automation',
      'approval',
      'changed',
      'created',
    ]);
    const changed = t.find((e) => e.kind === 'changed');
    expect(changed?.changes).toEqual([{ label: 'Estado', from: 'Programado', to: 'En camino' }]);
    expect(t.find((e) => e.kind === 'approval')?.title).toBe('Aprobado');
    expect(t.find((e) => e.kind === 'file')?.files?.[0]?.names).toEqual(['manifiesto.pdf']);
    expect(t.find((e) => e.kind === 'action')?.title).toBe('Usó el botón «Avisar al jefe»');
  });

  it('la historia de un campo que la pantalla no muestra no se cuenta (ni el evento que sólo lo tocó)', () => {
    const t = build();
    const texts = JSON.stringify(t);
    expect(texts).not.toContain('secreto');
    expect(t.some((e) => e.id === 'e2')).toBe(false);
  });

  it('show filtra por parte', () => {
    expect(build(new Set(['created'])).map((e) => e.kind)).toEqual(['created']);
    expect(build(new Set(['approvals'])).map((e) => e.kind)).toEqual(['approval']);
    expect(build(new Set(['files'])).map((e) => e.kind)).toEqual(['file']);
  });

  it('un detalle sin historia cargada muestra al menos la creación', () => {
    const s = spec([detailBlock()]);
    const view = computeView(s, sources(), NOW, { record: { rowId: V1 } });
    const b = view.blocks[0];
    if (b?.type !== 'detail') throw new Error('detail');
    expect(b.timeline?.map((e) => e.kind)).toEqual(['created']);
  });

  it('timeline:false la apaga', () => {
    const s = spec([detailBlock({ timeline: false })]);
    const view = computeView(s, sources(), NOW, { record: { rowId: V1, history } });
    const b = view.blocks[0];
    expect(b?.type === 'detail' && b.timeline).toBeNull();
  });

  it('el límite corta lo más viejo', () => {
    const t = buildTimeline(history, { tracker: vuelos, visible, show: all as never, limit: 2 });
    expect(t).toHaveLength(2);
    expect(t[0]?.kind).toBe('action');
  });
});

describe('lista de tarjetas', () => {
  const cards = (extra: Record<string, unknown> = {}) => ({
    id: 'tarjetas',
    type: 'cards',
    tracker: 'vuelos',
    title: 'Vuelos',
    titleField: 'numero',
    statusField: 'estado',
    dateField: 'llegada',
    dataFields: ['llegada', 'hora'],
    chips: ['status', 'today', 'week', 'mine'],
    sortOptions: ['llegada'],
    ...extra,
  });
  const get = (extra: Record<string, unknown> = {}, opts = {}) => {
    const view = computeView(spec([cards(extra)]), sources(), NOW, opts);
    const b = view.blocks[0];
    if (b?.type !== 'cards') throw new Error(`cards: ${JSON.stringify(b)}`);
    return b;
  };

  it('«mío» sólo se ofrece si se sabe quién mira, y marca lo que esa persona creó', () => {
    expect(get().chips).not.toContain('mine');
    const b = get({}, { viewer: { id: 'u1', kind: 'member' } });
    expect(b.chips).toContain('mine');
    expect(b.cards.filter((c) => c.mine).map((c) => c.title)).toEqual(['AV-204']);
  });

  it('chips de hoy / semana / estado y búsqueda corren sobre lo entregado', () => {
    const b = get({}, { viewer: { id: 'u1', kind: 'member' } });
    const range = { today: b.today, weekFrom: b.week.from, weekTo: b.week.to };
    expect(b.today).toBe('2026-10-07');
    expect(b.week).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(
      filterCards(b.cards, { ...EMPTY_CARD_FILTER, when: 'today' }, range).map((c) => c.title),
    ).toEqual(['AV-204']);
    expect(filterCards(b.cards, { ...EMPTY_CARD_FILTER, when: 'week' }, range)).toHaveLength(2);
    expect(
      filterCards(b.cards, { ...EMPTY_CARD_FILTER, status: 'Programado' }, range).map(
        (c) => c.title,
      ),
    ).toEqual(['LA-880']);
    expect(
      filterCards(b.cards, { ...EMPTY_CARD_FILTER, mine: true }, range).map((c) => c.title),
    ).toEqual(['AV-204']);
    expect(filterCards(b.cards, { ...EMPTY_CARD_FILTER, query: 'la-8' }, range)).toHaveLength(1);
    expect(filterCards(b.cards, { ...EMPTY_CARD_FILTER, query: 'zzz' }, range)).toHaveLength(0);
  });

  it('ordena por una llave elegida, agrupa por opciones y pagina', () => {
    const b = get({ groupBy: 'estado' });
    expect(b.groupLabel).toBe('Estado');
    // Por el orden de las opciones: Programado, En camino.
    expect(groupCards(b.cards).map((g) => g.group)).toEqual(['Programado', 'En camino']);
    const asc = sortCards(b.cards, { index: 0, dir: 'asc' });
    expect(asc.map((c) => c.title)).toEqual(['AV-204', 'LA-880']);
    expect(sortCards(b.cards, { index: 0, dir: 'desc' }).map((c) => c.title)).toEqual([
      'LA-880',
      'AV-204',
    ]);
    expect(pageOf([1, 2, 3, 4, 5], 1, 2)).toEqual({ shown: [1, 2], more: 3 });
    expect(pageOf([1, 2, 3, 4, 5], 3, 2)).toEqual({ shown: [1, 2, 3, 4, 5], more: 0 });
  });

  it('el spec exige fecha y estado para los chips que los usan', () => {
    expect(() => spec([cards({ dateField: undefined })])).toThrow(/dateField/);
    expect(() => spec([cards({ statusField: undefined, chips: ['status'] })])).toThrow(
      /statusField/,
    );
  });
});

describe('agenda por rangos', () => {
  const cal = (mode: string, extra: Record<string, unknown> = {}) =>
    spec([
      {
        id: 'agenda',
        type: 'calendar',
        tracker: 'vuelos',
        title: 'Llegadas',
        dateField: 'llegada',
        timeField: 'hora',
        colorField: 'estado',
        mode,
        ...extra,
      },
    ]);
  const get = (mode: string, extra = {}) => {
    const b = computeView(cal(mode, extra), sources(), NOW).blocks[0];
    if (b?.type !== 'calendar') throw new Error('calendar');
    return b;
  };

  it('semana y día llevan la hora y el color por estado', () => {
    for (const mode of ['week', 'day'] as const) {
      const b = get(mode);
      expect(b.mode).toBe(mode);
      expect(b.events.map((e) => e.time)).toEqual(['14:30', '09:00']);
      expect(b.events[0]?.tone).toBeTruthy();
      expect(b.legend.length).toBe(3);
    }
  });

  it('con selector abre en el modo pedido o en el primero elegible', () => {
    expect(get('week', { modes: ['day', 'week', 'month'] }).mode).toBe('week');
    expect(get('month', { modes: ['day', 'week'] }).mode).toBe('day');
    expect(get('week', { modes: ['day', 'week', 'month'] }).modes).toEqual([
      'day',
      'week',
      'month',
    ]);
  });

  it('semanas empiezan en lunes y los eventos de cada día salen por hora', () => {
    expect(weekStart('2026-10-07')).toBe('2026-10-05');
    expect(weekDays('2026-10-11')[0]).toBe('2026-10-05');
    expect(weekDays('2026-10-07')).toHaveLength(7);
    const evs = [
      { id: 'a', day: '2026-10-07', time: null },
      { id: 'b', day: '2026-10-07', time: '13:00' },
      { id: 'c', day: '2026-10-07', time: '08:30' },
      { id: 'd', day: '2026-10-09', time: '10:00' },
    ];
    const week = eventsByDay(evs, weekDays('2026-10-07'));
    expect(week.find((d) => d.day === '2026-10-07')?.events.map((e) => e.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(week.find((d) => d.day === '2026-10-09')?.events).toHaveLength(1);
    expect(week.find((d) => d.day === '2026-10-06')?.events).toEqual([]);
  });

  it('navegar no sale del rango que el cálculo cubre', () => {
    const range = { from: '2026-09-01', to: '2026-11-30' };
    expect(step('week', '2026-10-07', 1, range)).toBe('2026-10-14');
    expect(step('day', '2026-09-01', -1, range)).toBe('2026-09-01');
    expect(step('month', '2026-10-07', 1, range)).toBe('2026-11-01');
    expect(step('month', '2026-11-15', 1, range)).toBe('2026-11-15');
    expect(addDay('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('el campo de hora tiene que ser de hora', () => {
    const s = cal('week', { timeField: 'llegada' });
    const problems = checkSpecAgainst(s, [vuelos, guias]);
    expect(problems.join(' ')).toMatch(/hora/);
  });
});

describe('tablero TV', () => {
  const tvSpec = (theme: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    spec(
      [
        { id: 'k1', type: 'metric', tracker: 'vuelos', title: 'Vuelos' },
        { id: 'k2', type: 'metric', tracker: 'guias', title: 'Guías' },
        { id: 'tabla', type: 'table', tracker: 'vuelos', title: 'Vuelos' },
        { id: 'form', type: 'form', tracker: 'guias', title: 'Registrar', fields: [] },
      ],
      { theme: { layout: 'tv', ...theme }, ...extra },
    );

  it('layout tv fuerza el panel oscuro y trae rotación y reloj', () => {
    const v = computeView(tvSpec({ style: 'clean', tv: { rotateSeconds: 20 } }), sources(), NOW);
    expect(v.theme).toMatchObject({
      layout: 'tv',
      style: 'dark-panel',
      tv: { rotateSeconds: 20, clock: true },
    });
    const none = computeView(spec([{ id: 't', type: 'text', markdown: 'x' }]), sources(), NOW);
    expect(none.theme?.tv).toBeUndefined();
  });

  it('el refresco nunca pasa de 30 s en una pantalla TV', () => {
    expect(computeView(tvSpec({}, { refreshSeconds: 60 }), sources(), NOW).refreshSeconds).toBe(30);
    expect(computeView(tvSpec({}, { refreshSeconds: 10 }), sources(), NOW).refreshSeconds).toBe(10);
  });

  it('sin páginas: indicadores juntos y cada bloque solo; no hay formularios en la pared', () => {
    const v = computeView(tvSpec(), sources(), NOW);
    const slides = tvSlides(v.blocks, v.pages);
    expect(slides.map((s) => s.blockIds)).toEqual([['k1', 'k2'], ['tabla']]);
  });

  it('con páginas, cada página es una sección', () => {
    const s = tvSpec(
      {},
      {
        pages: [
          { id: 'a', title: 'Cifras', blockIds: ['k1', 'k2'] },
          { id: 'b', title: 'Lista', blockIds: ['tabla', 'form'] },
        ],
      },
    );
    const v = computeView(s, sources(), NOW);
    expect(tvSlides(v.blocks, v.pages).map((x) => [x.id, x.blockIds])).toEqual([
      ['a', ['k1', 'k2']],
      ['b', ['tabla']],
    ]);
  });

  it('la sección sale del reloj: rota cada N s, da la vuelta y no se desfasa', () => {
    expect([0, 14_999, 15_000, 29_999, 30_000, 45_000].map((ms) => tvSlideAt(3, ms, 15))).toEqual([
      0, 0, 1, 1, 2, 0,
    ]);
    expect(tvSlideAt(1, 99_999, 15)).toBe(0);
    expect(tvSlideAt(0, 99_999, 15)).toBe(0);
    expect(tvSecondsLeft(0, 15)).toBe(15);
    expect(tvSecondsLeft(14_000, 15)).toBe(1);
  });

  it('el reloj es de Bogotá, 24 h', () => {
    expect(tvClock(NOW).time).toBe('12:00');
    expect(tvClock(new Date('2026-10-07T23:30:00Z')).time).toBe('18:30');
  });

  it('rotateSeconds fuera de rango se rechaza', () => {
    expect(() => tvSpec({ tv: { rotateSeconds: 2 } })).toThrow();
    expect(() => tvSpec({ tv: { rotateSeconds: 500 } })).toThrow();
  });
});

describe('validación contra el catálogo', () => {
  const problems = (block: unknown) => checkSpecAgainst(spec([block]), [vuelos, guias]);

  it('un detalle sano no tiene problemas', () => {
    expect(problems(detailBlock())).toEqual([]);
  });

  it('relacionar por relación exige un campo relación hacia la tabla del detalle', () => {
    const p = problems(
      detailBlock({ related: [{ id: 'g', title: 'G', tracker: 'guias', field: 'vuelo' }] }),
    );
    expect(p.join(' ')).toMatch(/campo relación hacia Vuelos/);
  });

  it('campos y tablas inexistentes se nombran', () => {
    expect(
      problems(detailBlock({ sections: [{ title: 'X', fields: ['nope'] }] })).join(' '),
    ).toMatch(/nope/);
    expect(
      problems(
        detailBlock({ related: [{ id: 'g', title: 'G', tracker: 'fantasma', field: 'vuelo' }] }),
      ).join(' '),
    ).toMatch(/fantasma/);
  });

  it('los botones de una lista relacionada se validan contra SU tabla', () => {
    const p = problems(
      detailBlock({
        related: [
          {
            id: 'g',
            title: 'G',
            tracker: 'guias',
            field: 'vuelo_rel',
            actions: [
              { id: 'x', label: 'X', kind: 'set_field', field: 'estado', value: 'Perdida' },
            ],
          },
        ],
      }),
    );
    expect(p.join(' ')).toMatch(/Perdida/);
  });

  it('la galería pide campos de archivos y el estado uno de opciones', () => {
    expect(problems(detailBlock({ gallery: ['numero'] })).join(' ')).toMatch(/archivos/);
    expect(problems(detailBlock({ statusField: 'numero' })).join(' ')).toMatch(/opciones/);
  });

  it('las tablas relacionadas cuentan como fuentes de la vista (para el scope)', async () => {
    const { trackersOf } = await import('./spec');
    expect(trackersOf(spec([detailBlock()])).sort()).toEqual(['guias', 'vuelos']);
  });

  it('un botón en una lista relacionada obliga a dejar editar', () => {
    const s = viewSpecSchema.parse({ version: 1, editing: 'off', blocks: [detailBlock()] });
    expect(checkSpecAgainst(s, [vuelos, guias]).join(' ')).toMatch(/editing/);
  });
});

describe('quién hizo qué, según quién mira', () => {
  const names = {
    members: new Map([['m1', 'Marta']]),
    appUsers: new Map([['a1', 'Cliente Uno']]),
  };
  it('un miembro ve nombres; un externo o el enlace ven «Tú» y «El equipo», nunca nombres internos', async () => {
    const { actorLabel } = await import('./record-history');
    const member = { kind: 'member' as const, id: 'm1' };
    const ext = { kind: 'app_user' as const, id: 'a1' };
    expect(actorLabel({ id: 'm1', kind: 'member' }, member, names)).toBe('Tú');
    expect(actorLabel({ id: 'a1', kind: 'app_user' }, member, names)).toBe('Cliente Uno');
    expect(actorLabel({ id: 'm1', kind: 'member' }, ext, names)).toBe('El equipo');
    expect(actorLabel({ id: 'a1', kind: 'app_user' }, ext, names)).toBe('Tú');
    expect(actorLabel({ id: 'm1', kind: 'member' }, { kind: 'public' }, names)).toBe('El equipo');
    expect(actorLabel(null, member, names)).toBe('Alguien con el enlace');
  });

  it('loadRecordContext no lee historia de una fila que el rol no ve', async () => {
    const { loadRecordContext } = await import('./record-history');
    let queried = 0;
    const db = {
      from: () => {
        queried++;
        throw new Error('no debía consultar');
      },
    } as never;
    const s = spec([detailBlock()]);
    // La fuente ya llegó recortada por el scope: la fila V1 no está.
    const ctx = await loadRecordContext(db, s, sources(GUIAS, [VUELOS[1] as ViewRow]), {
      rowId: V1,
    });
    expect(ctx).toEqual({ rowId: V1, blockId: null, history: null });
    expect(queried).toBe(0);
    expect(await loadRecordContext(db, s, sources(), { rowId: 'no-es-uuid' })).toBeNull();
    expect(await loadRecordContext(db, s, sources(), { rowId: null })).toBeNull();
  });
});

describe('diseño por rol de una app', () => {
  it('avisa de listas sin detalle, formularios de planta sin diseño operario y TV con formularios', async () => {
    const { designWarnings } = await import('../apps/design');
    const form = { id: 'f', type: 'form', tracker: 'guias', title: 'Registrar', fields: [] };
    const table = { id: 't', type: 'table', tracker: 'vuelos', title: 'Vuelos' };
    const roles = [
      {
        key: 'operario',
        name: 'Operario',
        permissions: { tables: { guias: { read: 'own', create: true, edit: 'own' } } },
      },
      {
        key: 'jefe',
        name: 'Jefe',
        permissions: { tables: { vuelos: { read: 'all', create: false, edit: 'all' } } },
      },
    ];
    const w = designWarnings(
      [
        { title: 'Registrar', roles: ['operario'], spec: spec([form]) },
        { title: 'Vuelos', roles: ['jefe'], spec: spec([table]) },
        { title: 'Pared', roles: [], spec: spec([table, form], { theme: { layout: 'tv' } }) },
      ],
      roles as never,
    );
    expect(w.some((x) => /«Vuelos» lista «vuelos»/.test(x))).toBe(true);
    expect(w.some((x) => /Operario.*diseño operario/.test(x))).toBe(true);
    expect(w.some((x) => /tablero TV/.test(x))).toBe(true);
    const ok = designWarnings(
      [
        {
          title: 'Registrar',
          roles: ['operario'],
          spec: spec([form], { theme: { layout: 'operator' } }),
        },
      ],
      roles as never,
    );
    expect(ok).toEqual([]);
  });
});
