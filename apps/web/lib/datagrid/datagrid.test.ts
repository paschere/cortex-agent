import type { GridColumn, GridRow } from '@/components/datagrid/types';
import { describe, expect, it } from 'vitest';
import { aggregate, aggregateOf, formatAggregate, groupTotals } from './aggregate';
import { csvFileName, csvValue, detectSeparator, parseCsv, toCsv } from './csv';
import {
  dayKey,
  editorText,
  foldText,
  formatValue,
  hrefFor,
  parseDateTime,
  parseDay,
  parseInput,
  parseNumber,
} from './format';
import {
  UPDATED_KEY,
  fieldKeyFrom,
  guessFieldType,
  planImport,
  slugFromName,
  toTrackerValue,
  toneFor,
  trackerColumns,
  trackerGridRow,
} from './trackers';
import { VIEW_PARAM, decodeView, encodeView, searchWithView } from './url';
import {
  activeFilterCount,
  applyView,
  boardGroups,
  buildSearchIndex,
  describeFilter,
  matchesFilter,
  normalizeView,
  operatorsFor,
  visibleColumns,
} from './view';

const COLUMNS: GridColumn[] = [
  { key: 'guia', label: 'Guía', type: 'text', pinned: true, primary: true },
  { key: 'ciudad', label: 'Ciudad', type: 'text' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'status',
    options: [
      { value: 'recoger', label: 'Por recoger', tone: 'amber' },
      { value: 'transito', label: 'En tránsito', tone: 'primary' },
      { value: 'entregada', label: 'Entregada', tone: 'emerald' },
    ],
  },
  { key: 'valor', label: 'Valor', type: 'money' },
  { key: 'peso', label: 'Peso', type: 'number' },
  { key: 'ocupacion', label: 'Ocupación', type: 'percent' },
  { key: 'despacho', label: 'Despacho', type: 'date' },
  {
    key: 'tipos',
    label: 'Tipo',
    type: 'multi_select',
    options: [{ value: 'seca' }, { value: 'fria' }, { value: 'peligrosa' }],
  },
  { key: 'asegurada', label: 'Asegurada', type: 'boolean' },
];

const ROWS: GridRow[] = [
  {
    id: 'a',
    values: {
      guia: 'Guía 10',
      ciudad: 'Bogotá',
      estado: 'transito',
      valor: 1_250_000,
      peso: 120,
      ocupacion: 50,
      despacho: '2026-10-01',
      tipos: ['seca'],
      asegurada: true,
    },
  },
  {
    id: 'b',
    values: {
      guia: 'Guía 2',
      ciudad: 'Medellín',
      estado: 'entregada',
      valor: 300_000,
      peso: 80,
      ocupacion: 100,
      despacho: '2026-09-20',
      tipos: ['fria', 'peligrosa'],
      asegurada: false,
    },
  },
  {
    id: 'c',
    values: {
      guia: 'Ñapa 1',
      ciudad: 'bogota',
      estado: 'recoger',
      valor: null,
      peso: 40,
      despacho: '2026-10-05',
      tipos: [],
    },
  },
  {
    id: 'd',
    values: { guia: 'Árbol', ciudad: 'Cali', estado: 'transito', valor: 50_000, peso: 10 },
  },
];

const NOW = new Date('2026-10-02T15:00:00Z');

describe('format', () => {
  it('lee números como los escribe una persona en Colombia', () => {
    expect(parseNumber('1.250.000')).toBe(1_250_000);
    expect(parseNumber('$ 1.250.000,50')).toBe(1_250_000.5);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber('2.5')).toBe(2.5);
    expect(parseNumber('1.500')).toBe(1500);
    expect(parseNumber('1,250,000.75')).toBe(1_250_000.75);
    expect(parseNumber('-3')).toBe(-3);
    expect(parseNumber('(450)')).toBe(-450);
    expect(parseNumber('12 %')).toBe(12);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1.2.3')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });

  it('muestra plata, porcentajes y fechas en es-CO', () => {
    const money = formatValue(COLUMNS[3] as GridColumn, 1_250_000);
    expect(money.replace(/\s/g, ' ')).toBe('$ 1.250.000');
    expect(formatValue(COLUMNS[5] as GridColumn, 12.5)).toBe('12,5 %');
    expect(formatValue(COLUMNS[6] as GridColumn, '2026-10-02')).toBe('2 oct 2026');
    expect(formatValue(COLUMNS[2] as GridColumn, 'transito')).toBe('En tránsito');
    expect(formatValue(COLUMNS[7] as GridColumn, ['fria', 'seca'])).toBe('fria, seca');
    expect(formatValue(COLUMNS[8] as GridColumn, true)).toBe('Sí');
    expect(formatValue(COLUMNS[3] as GridColumn, null)).toBe('');
  });

  it('entiende fechas escritas a mano y respeta el día de Bogotá', () => {
    expect(parseDay('2/10/2026')).toBe('2026-10-02');
    expect(parseDay('31/02/2026')).toBeNull();
    expect(parseDay('2026-10-02')).toBe('2026-10-02');
    // 02:00 UTC del 3 es todavía el 2 en Bogotá.
    expect(dayKey('2026-10-03T02:00:00Z')).toBe('2026-10-02');
    expect(parseDateTime('2026-10-02T15:30')).toBe('2026-10-02T20:30:00.000Z');
  });

  it('valida lo que se teclea por tipo', () => {
    const estado = COLUMNS[2] as GridColumn;
    expect(parseInput(estado, 'en transito')).toEqual({ ok: true, value: 'transito' });
    expect(parseInput(estado, 'Perdida').ok).toBe(false);
    expect(parseInput(COLUMNS[3] as GridColumn, '$ 2.000.000')).toEqual({
      ok: true,
      value: 2_000_000,
    });
    expect(parseInput(COLUMNS[7] as GridColumn, 'Seca, FRIA')).toEqual({
      ok: true,
      value: ['seca', 'fria'],
    });
    expect(parseInput({ key: 'm', label: 'Correo', type: 'email' }, 'no-es')).toMatchObject({
      ok: false,
    });
    expect(parseInput({ key: 'l', label: 'Enlace', type: 'link' }, 'cortex.co/x')).toEqual({
      ok: true,
      value: 'https://cortex.co/x',
    });
    expect(parseInput({ key: 'l', label: 'Enlace', type: 'link' }, 'javascript:alert(1)').ok).toBe(
      false,
    );
    expect(parseInput({ key: 'g', label: 'Guía', type: 'text', required: true }, '  ').ok).toBe(
      false,
    );
    expect(parseInput(COLUMNS[8] as GridColumn, 'sí')).toEqual({ ok: true, value: true });
    expect(editorText(COLUMNS[3] as GridColumn, 1250.5)).toBe('1250,5');
  });

  it('solo arma enlaces seguros', () => {
    expect(hrefFor({ key: 'l', label: 'L', type: 'link' }, 'javascript:alert(1)')).toBeNull();
    expect(hrefFor({ key: 'p', label: 'P', type: 'phone' }, '+57 300 123 4567')).toBe(
      'tel:+573001234567',
    );
    expect(hrefFor({ key: 'e', label: 'E', type: 'email' }, 'a@b.co')).toBe('mailto:a@b.co');
  });

  it('pliega tildes', () => {
    expect(foldText('  Bogotá D.C. ')).toBe('bogota d.c.');
  });
});

describe('applyView', () => {
  it('busca sin tildes ni mayúsculas, en todas las columnas', () => {
    const r = applyView(ROWS, COLUMNS, { search: 'BOGOTA' }, { now: NOW });
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'c']);
    const idx = buildSearchIndex(ROWS, COLUMNS);
    expect(
      applyView(ROWS, COLUMNS, { search: '1.250.000' }, { now: NOW, searchIndex: idx }).rows.map(
        (x) => x.id,
      ),
    ).toEqual(['a']);
    expect(
      applyView(ROWS, COLUMNS, { search: 'tránsito cali' }, { now: NOW }).rows.map((x) => x.id),
    ).toEqual(['d']);
  });

  it('ordena en español, con números dentro del texto y vacíos al final', () => {
    const asc = applyView(ROWS, COLUMNS, { sort: [{ key: 'guia', dir: 'asc' }] }, { now: NOW });
    expect(asc.rows.map((x) => x.values.guia)).toEqual(['Árbol', 'Guía 2', 'Guía 10', 'Ñapa 1']);
    const byValue = applyView(
      ROWS,
      COLUMNS,
      { sort: [{ key: 'valor', dir: 'desc' }] },
      { now: NOW },
    );
    expect(byValue.rows.map((x) => x.id)).toEqual(['a', 'b', 'd', 'c']);
    const multi = applyView(
      ROWS,
      COLUMNS,
      {
        sort: [
          { key: 'estado', dir: 'asc' },
          { key: 'peso', dir: 'desc' },
        ],
      },
      { now: NOW },
    );
    expect(multi.rows.map((x) => x.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('filtra por tipo, con y/o', () => {
    const f = (filters: Parameters<typeof applyView>[2]['filters'], match: 'all' | 'any' = 'all') =>
      applyView(ROWS, COLUMNS, { filters, match }, { now: NOW }).rows.map((x) => x.id);
    expect(f([{ key: 'valor', op: 'gte', value: 300000 }])).toEqual(['a', 'b']);
    expect(f([{ key: 'valor', op: 'between', value: [40000, '400.000'] }])).toEqual(['b', 'd']);
    expect(f([{ key: 'valor', op: 'empty' }])).toEqual(['c']);
    expect(f([{ key: 'estado', op: 'in', value: ['transito'] }])).toEqual(['a', 'd']);
    expect(f([{ key: 'estado', op: 'not_in', value: ['transito'] }])).toEqual(['b', 'c']);
    expect(f([{ key: 'tipos', op: 'in', value: ['peligrosa'] }])).toEqual(['b']);
    expect(f([{ key: 'ciudad', op: 'eq', value: 'Bogota' }])).toEqual(['a', 'c']);
    expect(f([{ key: 'ciudad', op: 'not_contains', value: 'bog' }])).toEqual(['b', 'd']);
    expect(f([{ key: 'despacho', op: 'last_days', value: 7 }])).toEqual(['a']);
    expect(f([{ key: 'despacho', op: 'next_days', value: 7 }])).toEqual(['c']);
    expect(f([{ key: 'despacho', op: 'before', value: '2026-10-01' }])).toEqual(['b']);
    expect(f([{ key: 'asegurada', op: 'eq', value: false }])).toEqual(['b', 'c', 'd']);
    expect(
      f(
        [
          { key: 'estado', op: 'in', value: ['entregada'] },
          { key: 'ciudad', op: 'contains', value: 'cali' },
        ],
        'any',
      ),
    ).toEqual(['b', 'd']);
    // Un filtro a medio llenar no filtra.
    expect(f([{ key: 'valor', op: 'gt' }])).toEqual(['a', 'b', 'c', 'd']);
    expect(
      activeFilterCount({
        filters: [
          { key: 'valor', op: 'gt' },
          { key: 'valor', op: 'empty' },
        ],
      }),
    ).toBe(1);
  });

  it('agrupa con el orden de las opciones y «Sin valor» al final', () => {
    const r = applyView(ROWS, COLUMNS, { groupBy: 'estado' }, { now: NOW });
    expect(r.groups?.map((g) => [g.label, g.rows.length])).toEqual([
      ['Por recoger', 1],
      ['En tránsito', 2],
      ['Entregada', 1],
    ]);
    const byMonth = applyView(ROWS, COLUMNS, { groupBy: 'despacho' }, { now: NOW });
    expect(byMonth.groups?.map((g) => g.label)).toEqual([
      'Septiembre de 2026',
      'Octubre de 2026',
      'Sin valor',
    ]);
    const board = boardGroups(ROWS, COLUMNS[2] as GridColumn);
    expect(board.map((g) => g.key)).toEqual(['recoger', 'transito', 'entregada']);
  });

  it('normaliza vistas viejas y respeta columnas fijas', () => {
    const v = normalizeView(COLUMNS, {
      filters: [{ key: 'borrada', op: 'eq', value: 1 }],
      hidden: ['guia', 'peso', 'nope'],
      order: ['peso', 'guia', 'valor'],
      widths: { valor: 9999, peso: 200 },
      layout: 'raro' as never,
    });
    expect(v.filters).toEqual([]);
    expect(v.hidden).toEqual(['peso']);
    expect(v.layout).toBe('table');
    expect(v.widths).toEqual({ peso: 200 });
    expect(
      visibleColumns(COLUMNS, v)
        .map((c) => c.key)
        .slice(0, 3),
    ).toEqual(['guia', 'valor', 'ciudad']);
  });

  it('ofrece operadores según el tipo y describe filtros', () => {
    expect(operatorsFor('money').map((o) => o.op)).toContain('between');
    expect(operatorsFor('status').map((o) => o.op)).toEqual(['in', 'not_in', 'empty', 'not_empty']);
    expect(
      describeFilter(COLUMNS[2] as GridColumn, {
        key: 'estado',
        op: 'in',
        value: ['transito', 'recoger'],
      }),
    ).toBe('Estado es alguno de En tránsito, Por recoger');
    expect(
      matchesFilter(
        COLUMNS[4] as GridColumn,
        5,
        { key: 'peso', op: 'neq', value: 5 },
        '2026-10-02',
      ),
    ).toBe(false);
  });

  it('aguanta 5.000 filas rápido', () => {
    const many: GridRow[] = Array.from({ length: 5000 }, (_, i) => ({
      id: String(i),
      values: {
        guia: `Guía ${i}`,
        ciudad: i % 2 ? 'Bogotá' : 'Cali',
        valor: i * 1000,
        estado: i % 3 ? 'transito' : 'entregada',
      },
    }));
    const t = performance.now();
    const r = applyView(
      many,
      COLUMNS,
      {
        search: 'bogota',
        filters: [{ key: 'valor', op: 'gt', value: 100000 }],
        sort: [{ key: 'guia', dir: 'desc' }],
        groupBy: 'estado',
      },
      { now: NOW },
    );
    expect(performance.now() - t).toBeLessThan(1500);
    expect(r.rows.length).toBe(2450);
  });
});

describe('aggregate', () => {
  it('suma, promedia y cuenta solo lo que tiene valor', () => {
    expect(aggregate(ROWS, 'valor', 'sum')).toBe(1_600_000);
    expect(aggregate(ROWS, 'valor', 'avg')).toBeCloseTo(533_333.33, 1);
    expect(aggregate(ROWS, 'valor', 'min')).toBe(50_000);
    expect(aggregate(ROWS, 'valor', 'max')).toBe(1_250_000);
    expect(aggregate(ROWS, 'valor', 'count')).toBe(3);
    expect(aggregate([], 'valor', 'sum')).toBeNull();
    expect(aggregateOf(COLUMNS[5] as GridColumn, undefined)).toBe('avg');
    expect(aggregateOf(COLUMNS[3] as GridColumn, { valor: 'max' })).toBe('max');
    expect(formatAggregate(COLUMNS[5] as GridColumn, 'avg', 75)).toBe('75 %');
    expect(groupTotals(ROWS, COLUMNS).map((t) => [t.column.key, t.value])).toEqual([
      ['valor', 1_600_000],
      ['peso', 250],
    ]);
  });
});

describe('csv', () => {
  it('exporta con BOM, punto y coma, números es-CO y sin fórmulas', () => {
    const rows: GridRow[] = [
      {
        id: '1',
        values: {
          guia: '=HYPERLINK("x")',
          valor: 1250000.5,
          estado: 'transito',
          despacho: '2026-10-02',
          ciudad: 'Bogotá; centro',
        },
      },
    ];
    const cols = [COLUMNS[0], COLUMNS[3], COLUMNS[2], COLUMNS[6], COLUMNS[1]] as GridColumn[];
    const csv = toCsv(rows, cols);
    expect(csv.startsWith('﻿')).toBe(true);
    const [head, line] = csv.slice(1).split('\r\n');
    expect(head).toBe('Guía;Valor;Estado;Despacho;Ciudad');
    expect(line).toBe(`"'=HYPERLINK(""x"")";1250000,5;En tránsito;2026-10-02;"Bogotá; centro"`);
    expect(csvValue(COLUMNS[4] as GridColumn, -3)).toBe('-3');
    expect(csvFileName('Guías de carga', '2026-10-02')).toBe('guias-de-carga-2026-10-02.csv');
  });

  it('lee CSV con comillas, saltos de línea, CRLF y cualquier separador', () => {
    expect(detectSeparator('a;b;c\n1;2;3')).toBe(';');
    expect(detectSeparator('"a,b";c\n')).toBe(';');
    expect(detectSeparator('a,b,c')).toBe(',');
    expect(parseCsv('﻿nombre;valor\r\n"Hola; ""tú""";1.200\r\n\r\n"dos\nlíneas";3\n')).toEqual([
      ['nombre', 'valor'],
      ['Hola; "tú"', '1.200'],
      ['dos\nlíneas', '3'],
    ]);
    // Lo que exporta, lo vuelve a leer.
    const back = parseCsv(toCsv(ROWS, COLUMNS));
    expect(back[0]?.[0]).toBe('Guía');
    expect(back.length).toBe(ROWS.length + 1);
  });
});

describe('url', () => {
  it('una vista viaja en el enlace y vuelve igual', () => {
    const view = normalizeView(COLUMNS, {
      search: 'bogotá',
      filters: [
        { key: 'estado', op: 'in', value: ['transito'] },
        { key: 'valor', op: 'empty' },
      ],
      match: 'any',
      sort: [{ key: 'valor', dir: 'desc' }],
      groupBy: 'estado',
      hidden: ['peso'],
      layout: 'board',
      layoutKey: 'estado',
      aggregates: { valor: 'avg' },
    });
    const encoded = encodeView(view);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeView(encoded, COLUMNS)).toEqual(view);
    expect(searchWithView('?ws=org&x=1', view)).toContain(`${VIEW_PARAM}=`);
    expect(searchWithView(`?ws=org&${VIEW_PARAM}=abc`, null)).toBe('?ws=org');
  });

  it('un enlace roto o viejo no rompe nada', () => {
    expect(decodeView('%%%nope', COLUMNS)).toBeNull();
    expect(decodeView('', COLUMNS)).toBeNull();
    expect(encodeView({ filters: [], sort: [], hidden: [], layout: 'table' })).toBe('');
    const stale = encodeView({
      filters: [{ key: 'ya_no_existe', op: 'eq', value: 1 }],
      sort: [],
      hidden: [],
      layout: 'table',
    });
    expect(decodeView(stale, COLUMNS)?.filters).toEqual([]);
  });
});

describe('trackers', () => {
  const fields = [
    { key: 'placa', label: 'Placa', type: 'text' as const, required: true },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select' as const,
      options: ['Pendiente', 'Entregado', 'Cancelado'],
    },
    { key: 'valor', label: 'Valor', type: 'money' as const },
    { key: 'vence', label: 'Vence', type: 'date' as const },
  ];

  it('convierte campos a columnas con nombre fijo y tonos con sentido', () => {
    const cols = trackerColumns(fields);
    expect(cols[0]).toMatchObject({ key: 'placa', pinned: true, primary: true, required: true });
    expect(cols[1]?.options?.map((o) => o.tone)).toEqual(['amber', 'emerald', 'rose']);
    expect(cols.at(-1)).toMatchObject({ key: UPDATED_KEY, editable: false });
    expect(toneFor('En tránsito')).toBe('amber');
    expect(
      trackerGridRow({
        id: 'r',
        label: 'X',
        values: { placa: 'ABC' },
        updated_at: '2026-10-01T00:00:00Z',
      }).values,
    ).toEqual({
      placa: 'ABC',
      [UPDATED_KEY]: '2026-10-01T00:00:00Z',
    });
  });

  it('traduce valores de la grilla a lo que la tabla acepta', () => {
    expect(toTrackerValue('money', '1.500.000')).toBe(1_500_000);
    expect(toTrackerValue('date', '2/10/2026')).toBe('2026-10-02');
    expect(toTrackerValue('text', null)).toBe('');
    expect(toTrackerValue('select', 'Pendiente')).toBe('Pendiente');
  });

  it('arma claves y slugs válidos y únicos', () => {
    expect(slugFromName('Guías de carga')).toBe('guias_de_carga');
    expect(slugFromName('Guías de carga', ['guias_de_carga'])).toBe('guias_de_carga_2');
    expect(slugFromName('2026 ventas')).toBe('tabla_2026_ventas');
    expect(fieldKeyFrom('Fecha de entrega')).toBe('fecha_de_entrega');
    expect(fieldKeyFrom('Valor', ['valor'])).toBe('valor_2');
    expect(fieldKeyFrom('¿?')).toBe('campo');
  });

  it('adivina tipos y planea una importación', () => {
    expect(guessFieldType('Valor flete', ['1.200.000', '$ 300.000'])).toEqual({ type: 'money' });
    expect(guessFieldType('Peso', ['12', '4,5'])).toEqual({ type: 'number' });
    expect(guessFieldType('Despacho', ['2/10/2026', '2026-10-01'])).toEqual({ type: 'date' });
    expect(guessFieldType('Estado', ['A', 'B', 'A', 'A', 'B', 'A'])).toEqual({
      type: 'select',
      options: ['A', 'B'],
    });
    const plan = planImport(
      ['Guía', 'Valor', 'Fecha'],
      [
        ['G-1', '1.000', '2/10/2026'],
        ['G-2', '2.000', '3/10/2026'],
        ['', '', ''],
      ],
    );
    expect(plan.fields.map((f) => [f.key, f.type])).toEqual([
      ['guia', 'text'],
      ['valor', 'money'],
      ['fecha', 'date'],
    ]);
    expect(plan.rows).toEqual([
      { guia: 'G-1', valor: 1000, fecha: '2026-10-02' },
      { guia: 'G-2', valor: 2000, fecha: '2026-10-03' },
    ]);
    const into = planImport(['PLACA', 'Otra'], [['XYZ', '1']], fields);
    expect(into.fields.map((f) => f.key)).toEqual(['placa']);
    expect(into.notes[0]).toContain('Otra');
  });
});
