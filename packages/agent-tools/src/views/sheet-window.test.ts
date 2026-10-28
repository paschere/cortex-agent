import { describe, expect, it } from 'vitest';
import type { ViewRow } from './compute';
import {
  type WindowPlanRow,
  encodeSheetWindowParams,
  groupsByRecency,
  loadMoreLabel,
  parseReach,
  parseSheetWindowParams,
  parseWindowSize,
  planWindow,
  previousFrom,
  reachLabel,
  windowRangeLabel,
  windowStart,
} from './sheet-window';
import { windowRowsInMemory } from './sheet-window-load';

const TODAY = '2026-10-28';
const days = (size: string) => parseWindowSize({ size });

// Guías de varios meses: cada manifiesto tiene su fecha, y M-OCT-1 tiene una guía vieja (agosto).
const rows: WindowPlanRow[] = [
  { id: 'g1', date: '2026-10-27', group: 'M-OCT-2' },
  { id: 'g2', date: '2026-10-20', group: 'M-OCT-2' },
  { id: 'g3', date: '2026-10-10', group: 'M-OCT-1' },
  { id: 'g4', date: '2026-08-15', group: 'M-OCT-1' },
  { id: 'g5', date: '2026-09-15', group: 'M-SEP' },
  { id: 'g6', date: '2026-08-01', group: 'M-AGO' },
  { id: 'g7', date: '2026-01-03', group: 'M-ENE' },
];

describe('tamaño y fechas', () => {
  it('lee días, meses y grupos; por omisión 30 días', () => {
    expect(parseWindowSize({ size: '30d' })).toEqual({ kind: 'days', n: 30 });
    expect(parseWindowSize({ size: '3m' })).toEqual({ kind: 'months', n: 3 });
    expect(parseWindowSize({ groups: 10 })).toEqual({ kind: 'groups', n: 10 });
    expect(parseWindowSize({})).toEqual({ kind: 'days', n: 30 });
  });

  it('la ventana de N días incluye hoy; la de meses arranca el día 1', () => {
    expect(windowStart(TODAY, days('30d'))).toBe('2026-09-29');
    expect(windowStart(TODAY, days('7d'))).toBe('2026-10-22');
    expect(windowStart(TODAY, parseWindowSize({ size: '1m' }))).toBe('2026-10-01');
    expect(windowStart(TODAY, parseWindowSize({ size: '2m' }))).toBe('2026-09-01');
  });

  it('atajos del selector', () => {
    expect(parseReach('7d', TODAY)).toEqual({ kind: 'from', from: '2026-10-22' });
    expect(parseReach('year', TODAY)).toEqual({ kind: 'from', from: '2026-01-01' });
    expect(parseReach('all', TODAY)).toEqual({ kind: 'all' });
    expect(parseReach('g20', TODAY)).toEqual({ kind: 'groups', n: 20 });
    expect(parseReach('2026-08-01', TODAY)).toEqual({ kind: 'from', from: '2026-08-01' });
    expect(parseReach('1850-01-01', TODAY)).toBeNull();
    expect(parseReach("x'; drop", TODAY)).toBeNull();
  });
});

describe('ventana por días', () => {
  it('trae sólo lo reciente y completa el grupo con sus guías viejas', () => {
    const plan = planWindow(rows, { size: days('30d'), reach: null, today: TODAY });
    // Ventana: 29 sep → hoy. g4 (agosto) entra porque su manifiesto M-OCT-1 tiene g3 adentro.
    expect([...plan.ids].sort()).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect(plan.info.from).toBe('2026-09-29');
    expect(plan.info.more).toBe(true);
    expect(plan.info.groupCount).toBe(2);
  });

  it('la frontera es la fecha más nueva que quedó afuera y el siguiente bloque termina ahí', () => {
    const plan = planWindow(rows, { size: days('30d'), reach: null, today: TODAY });
    expect(plan.info.frontier).toBe('2026-09-15');
    // Siguiente bloque de 30 días, que termina el 15 de septiembre (salta el hueco vacío).
    expect(plan.info.next).toBe('2026-08-17');
    const second = planWindow(rows, { size: days('30d'), reach: parseReach('2026-08-17', TODAY), today: TODAY });
    expect([...second.ids].sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
    expect(second.info.more).toBe(true);
    expect(second.info.frontier).toBe('2026-08-01');
  });

  it('al llegar al fondo ya no hay más', () => {
    const all = planWindow(rows, { size: days('30d'), reach: parseReach('2026-01-01', TODAY), today: TODAY });
    expect(all.ids.size).toBe(rows.length);
    expect(all.info.more).toBe(false);
    expect(all.info.next).toBeNull();
  });

  it('«todo» trae todo', () => {
    const plan = planWindow(rows, { size: days('7d'), reach: { kind: 'all' }, today: TODAY });
    expect(plan.ids.size).toBe(rows.length);
    expect(plan.info.reach).toBe('all');
  });

  it('con datos viejos y nada reciente, el primer bloque cae donde están los datos', () => {
    const old = rows.filter((r) => r.date !== null && r.date < '2026-09-01');
    const plan = planWindow(old, { size: days('30d'), reach: null, today: TODAY });
    expect(plan.ids.size).toBeGreaterThan(0);
    expect(plan.info.from).toBe('2026-07-17');
  });

  it('una fila sin fecha nunca queda fuera', () => {
    const plan = planWindow([...rows, { id: 'sin', date: null, group: '' }], {
      size: days('7d'),
      reach: null,
      today: TODAY,
    });
    expect(plan.ids.has('sin')).toBe(true);
  });

  it('el bloque siguiente de meses respeta el tamaño', () => {
    expect(previousFrom('2026-10-01', parseWindowSize({ size: '1m' }), '2026-09-15')).toBe('2026-09-01');
    expect(previousFrom('2026-10-01', parseWindowSize({ size: '1m' }), null)).toBeNull();
  });
});

describe('ventana por grupos', () => {
  const size = parseWindowSize({ groups: 2 });
  it('los N manifiestos más recientes, completos', () => {
    expect(groupsByRecency(rows).slice(0, 3)).toEqual(['M-OCT-2', 'M-OCT-1', 'M-SEP']);
    const plan = planWindow(rows, { size, reach: null, today: TODAY });
    expect([...plan.ids].sort()).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect(plan.info.more).toBe(true);
    expect(plan.info.next).toBe('g4');
    expect(plan.info.frontier).toBe('2026-09-15');
  });

  it('cargar más suma otro bloque del mismo tamaño y termina', () => {
    const next = planWindow(rows, { size, reach: parseReach('g4', TODAY), today: TODAY });
    expect(next.ids.has('g5')).toBe(true);
    expect(next.ids.has('g6')).toBe(true);
    expect(next.ids.has('g7')).toBe(false);
    const end = planWindow(rows, { size, reach: parseReach('g6', TODAY), today: TODAY });
    expect(end.ids.size).toBe(rows.length);
    expect(end.info.more).toBe(false);
    expect(end.info.next).toBeNull();
  });
});

describe('parámetros de la dirección', () => {
  const windowed = new Set(['hoja']);
  it('ida y vuelta, y sólo valen las hojas con ventana', () => {
    const { sw, sq } = encodeSheetWindowParams({
      hoja: { reach: '2026-08-17', q: '172-488', cols: { estado: ['Pendiente', ''] } },
      otra: { reach: '30d' },
    });
    const back = parseSheetWindowParams(windowed, sw, sq);
    expect(Object.keys(back)).toEqual(['hoja']);
    expect(back.hoja).toEqual({
      reach: '2026-08-17',
      q: '172-488',
      cols: { estado: ['Pendiente', ''] },
    });
  });

  it('descarta basura sin romper', () => {
    expect(parseSheetWindowParams(windowed, 'hoja~' + 'x'.repeat(40), '{no json')).toEqual({});
    const odd = parseSheetWindowParams(windowed, null, JSON.stringify({ hoja: { q: "a,b(c)'%", c: { 'bad key!': ['x'] } } }));
    expect(odd.hoja?.q).toBe('a b c');
    expect(odd.hoja?.cols).toBeUndefined();
  });
});

describe('textos', () => {
  it('el botón según el tamaño', () => {
    expect(loadMoreLabel({ size: '1m', groupNoun: null, rowNoun: 'guías' })).toBe('Cargar mes anterior');
    expect(loadMoreLabel({ size: '30d', groupNoun: null, rowNoun: 'guías' })).toBe('Cargar 30 días anteriores');
    expect(loadMoreLabel({ size: 'g10', groupNoun: 'manifiestos', rowNoun: 'guías' })).toBe('Cargar 10 manifiestos más');
  });
  it('rango y alcance', () => {
    expect(windowRangeLabel('2026-09-01', '2026-10-28', TODAY)).toBe('1 sep – 28 oct');
    expect(windowRangeLabel('2025-12-20', '2026-01-03', TODAY)).toBe('20 dic 2025 – 3 ene 2026');
    expect(reachLabel({ reach: '2026-09-29', size: '30d', from: '2026-09-29' }, TODAY)).toBe('Últimos 30 días');
    expect(reachLabel({ reach: 'all', size: '30d', from: null }, TODAY)).toBe('Todo');
  });
});

describe('fuentes en memoria y búsqueda en todo el histórico', () => {
  const row = (id: string, fecha: string, manifiesto: string, estado: string): ViewRow => ({
    id,
    label: id,
    values: { fecha, manifiesto, estado, guia: `G-${id}` },
    created_at: `${fecha}T12:00:00Z`,
    updated_at: `${fecha}T12:00:00Z`,
  });
  const data = [
    row('a', '2026-10-27', 'M2', 'Pendiente'),
    row('b', '2026-08-02', 'M1', 'Pendiente'),
    row('c', '2026-01-03', 'M0', 'OK'),
  ];
  const block = { id: 'h', columns: ['guia', 'estado'], window: { field: 'fecha', size: '30d' }, group: { by: 'manifiesto' } };
  const fields = [{ key: 'manifiesto', type: 'text' }];

  it('sin búsqueda, sólo la ventana', () => {
    const w = windowRowsInMemory(data, { block, fields, request: undefined, today: TODAY });
    expect(w.rows.map((r) => r.id)).toEqual(['a']);
    expect(w.info.more).toBe(true);
  });

  it('la búsqueda mira todo el histórico, no sólo lo cargado', () => {
    const w = windowRowsInMemory(data, { block, fields, request: { q: 'G-c' }, today: TODAY });
    expect(w.rows.map((r) => r.id)).toEqual(['c']);
    expect(w.info.search).toBe(true);
    expect(w.info.more).toBe(false);
  });

  it('el filtro de columna también', () => {
    const w = windowRowsInMemory(data, { block, fields, request: { cols: { estado: ['Pendiente'] } }, today: TODAY });
    expect(w.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('computeView con ventana', () => {
  const parent = { slug: 'manifiestos', name: 'Manifiestos', fields: [{ key: 'nombre', label: 'Manifiesto', type: 'text' as const, required: true }] };
  const guias = {
    slug: 'guias',
    name: 'Guías',
    fields: [
      { key: 'guia', label: 'Guía', type: 'text' as const, required: true },
      { key: 'fecha', label: 'Fecha', type: 'date' as const, required: false },
      { key: 'kilos', label: 'Kilos', type: 'number' as const, required: false },
      { key: 'manifiesto', label: 'Manifiesto', type: 'relation' as const, tracker: 'manifiestos', required: false },
    ],
  };
  const M = '00000000-0000-4000-8000-0000000000a1';
  const mk = (id: string, fecha: string, kilos: number): ViewRow => ({
    id,
    label: id,
    values: { guia: id, fecha, kilos, manifiesto: JSON.stringify({ id: M, label: 'FLEX 9' }) },
    created_at: `${fecha}T12:00:00Z`,
    updated_at: `${fecha}T12:00:00Z`,
  });

  it('la hoja pinta la ventana, el grupo completo y la fecha frontera; los demás bloques ven la tabla entera', async () => {
    const { computeView } = await import('./compute');
    const { viewSpecSchema } = await import('./spec');
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'h',
          type: 'sheet',
          tracker: 'guias',
          title: 'Guías',
          columns: ['guia', 'fecha', 'kilos'],
          group: { by: 'manifiesto', parentTracker: 'manifiestos', parentFields: ['nombre'], subtotals: ['kilos'] },
          window: { field: 'fecha', size: '30d' },
        },
        { id: 'k', type: 'metric', tracker: 'guias', title: 'Total', op: 'sum', field: 'kilos' },
      ],
    });
    const all = [mk('a', '2026-10-27', 10), mk('b', '2026-08-01', 5)];
    const win = windowRowsInMemory(all, {
      block: { id: 'h', columns: ['guia'], window: { field: 'fecha', size: '30d' }, group: { by: 'manifiesto', parentTracker: 'manifiestos' } },
      fields: guias.fields,
      request: undefined,
      today: TODAY,
    });
    // Ambas guías comparten manifiesto: b (de agosto) entra con su grupo.
    expect(win.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    const sources = new Map([
      ['guias', { tracker: guias, rows: all, truncated: false, windows: new Map([['h', { ...win, rows: win.rows.slice(0, 1) }]]) }],
      ['manifiestos', { tracker: parent, rows: [], truncated: false }],
    ]);
    const out = computeView(spec, sources, new Date('2026-10-28T15:00:00Z'));
    const sheet = out.blocks.find((b) => b.id === 'h');
    if (sheet?.type !== 'sheet') throw new Error('sin hoja');
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.window?.today).toBe(TODAY);
    expect(sheet.window?.rowNoun).toBe('guías');
    expect(sheet.window?.groupNoun).toBe('manifiestos');
    expect(sheet.window?.shownFrom).toBe('2026-10-27');
    expect(sheet.window?.more).toBe(false);
    const metric = out.blocks.find((b) => b.id === 'k');
    expect(metric?.type).not.toBe('problem');
  });
});

describe('carga incremental', () => {
  const entries: WindowPlanRow[] = rows;
  it('sólo el bloque nuevo (lo de reach que no está en until), con sus grupos completos', async () => {
    const { planDelta } = await import('./sheet-window');
    const first = planWindow(entries, { size: days('30d'), reach: null, today: TODAY });
    const d = planDelta(entries, {
      size: days('30d'),
      reach: parseReach('2026-08-17', TODAY),
      until: parseReach(first.info.reach, TODAY),
      today: TODAY,
    });
    // g5 (15 sep) es nuevo; g1..g4 ya estaban.
    expect([...d.ids].sort()).toEqual(['g5']);
    expect(d.info.more).toBe(true);
  });

  it('por grupos: los siguientes N', async () => {
    const { planDelta } = await import('./sheet-window');
    const d = planDelta(entries, {
      size: parseWindowSize({ groups: 2 }),
      reach: parseReach('g4', TODAY),
      until: parseReach('g2', TODAY),
      today: TODAY,
    });
    expect([...d.ids].sort()).toEqual(['g5', 'g6']);
  });

  it('unir lo fresco con lo cargado atrás: gana lo fresco, grupos reordenados y filas contiguas', async () => {
    const { mergeSheetBlocks, reachIsWider } = await import('./sheet-window');
    const g = (key: string) => ({ key, sortKey: key, fields: [], label: key, subtotals: [], collapsed: false });
    const r = (id: string, group: number, cell: string) => ({ id, group, cells: [cell] });
    const newer = { rows: [r('a', 0, 'nuevo'), r('b', 1, 'x')], groups: [g('FLEX 2'), g('FLEX 10')], groupDir: 1 as const, total: 2, truncated: false, window: { rows: 2, shownFrom: '2026-10-01', shownTo: '2026-10-27' } };
    const older = { rows: [r('a', 0, 'viejo'), r('c', 1, 'y')], groups: [g('FLEX 3'), g('FLEX 2')], groupDir: 1 as const, total: 2, truncated: false, window: { rows: 2, shownFrom: '2026-08-01', shownTo: '2026-09-20', more: false } };
    const m = mergeSheetBlocks(newer, older);
    // Orden natural: 2, 3, 10.
    expect(m.groups?.map((x) => x.key)).toEqual(['FLEX 2', 'FLEX 3', 'FLEX 10']);
    expect(m.rows.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(m.rows.find((x) => x.id === 'a')?.cells).toEqual(['nuevo']);
    expect(m.rows.find((x) => x.id === 'c')?.group).toBe(0);
    expect(m.window?.shownFrom).toBe('2026-08-01');
    expect(m.window?.shownTo).toBe('2026-10-27');
    expect(m.total).toBe(3);
    expect(reachIsWider({ kind: 'all' }, { kind: 'from', from: '2026-01-01' })).toBe(true);
    expect(reachIsWider({ kind: 'from', from: '2026-10-22' }, { kind: 'from', from: '2026-09-29' })).toBe(false);
  });
});
