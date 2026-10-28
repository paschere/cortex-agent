import { describe, expect, it } from 'vitest';
import {
  type CatalogTracker,
  type ViewRow,
  type ViewSource,
  checkSpecAgainst,
  computeView,
  sheetCsv,
  sheetMatrix,
  viewExportSheets,
  viewSpecSchema,
} from '../index';
import {
  buildPasteRows,
  mapPasteColumns,
  normalizePasteCell,
  parseClipboard,
  parsePastedDate,
  parsePastedNumber,
  toClipboard,
} from './sheet-paste';
import { sheetTotalDisplay } from './sheet-math';

const manifiestos: CatalogTracker = {
  slug: 'manifiestos',
  name: 'Manifiestos',
  fields: [
    { key: 'nombre', label: 'Manifiesto', type: 'text', required: true },
    { key: 'numero', label: 'N° manifiesto', type: 'text', required: false },
    { key: 'estado', label: 'Estado', type: 'select', required: false, options: ['OK-BBIC', 'Por revisar'] },
  ],
};
const guias: CatalogTracker = {
  slug: 'guias',
  name: 'Guías',
  fields: [
    { key: 'guia', label: 'Guía', type: 'text', required: true },
    { key: 'parcial', label: 'Parcial', type: 'select', required: false, options: ['Sí', 'No'] },
    { key: 'kilos', label: 'Kilos', type: 'number', required: false },
    { key: 'tarifa', label: 'Tarifa', type: 'number', required: false },
    { key: 'total_usd', label: 'Total USD', type: 'money', currency: 'USD', formula: '[kilos] × [tarifa]', required: false },
    { key: 'total_cop', label: 'Total COP', type: 'money', required: false },
    { key: 'manifiesto', label: 'Manifiesto', type: 'relation', tracker: 'manifiestos', required: false },
  ],
};
const at = '2026-10-27T00:00:00.000Z';
const row = (id: string, label: string, values: ViewRow['values']): ViewRow => ({
  id,
  label,
  values,
  created_by: null,
  created_at: at,
  updated_at: at,
});
const M1 = '00000000-0000-4000-8000-000000000001';
const M2 = '00000000-0000-4000-8000-000000000002';
const rel = (id: string, label: string) => JSON.stringify({ id, label });
const sources = new Map<string, ViewSource>([
  [
    'manifiestos',
    {
      tracker: manifiestos,
      truncated: false,
      rows: [
        row(M1, 'FLEX 1', { nombre: 'FLEX 1', numero: '3478', estado: 'OK-BBIC' }),
        row(M2, 'FLEX 2', { nombre: 'FLEX 2', numero: '3492', estado: 'Por revisar' }),
      ],
    },
  ],
  [
    'guias',
    {
      tracker: guias,
      truncated: false,
      rows: [
        row('g1', 'G1', { guia: 'A-1', parcial: 'No', kilos: 100, tarifa: 0.09, total_usd: 9, total_cop: 30903, manifiesto: rel(M1, 'FLEX 1') }),
        row('g2', 'G2', { guia: 'A-2', parcial: 'Sí', kilos: 50, tarifa: 0.09, total_usd: 4.5, total_cop: 15451, manifiesto: rel(M1, 'FLEX 1') }),
        row('g3', 'G3', { guia: 'B-1', parcial: 'No', kilos: 10, tarifa: 0.09, total_usd: 0.9, total_cop: 3090, manifiesto: rel(M2, 'FLEX 2') }),
        row('g4', 'G4', { guia: 'S-1', parcial: 'No', kilos: 1 }),
      ],
    },
  ],
]);

const spec = viewSpecSchema.parse({
  version: 1,
  editing: 'team',
  blocks: [
    {
      id: 'hoja',
      type: 'sheet',
      tracker: 'guias',
      title: 'Guías',
      columns: ['guia', 'parcial', 'kilos', 'total_usd', 'total_cop'],
      editable: ['guia', 'parcial', 'kilos', 'total_usd', 'manifiesto'],
      group: { by: 'manifiesto', parentTracker: 'manifiestos', parentFields: ['numero', 'estado'], subtotals: ['kilos', 'total_usd', 'total_cop'] },
      rules: [{ field: 'parcial', op: 'eq', value: 'Sí', tone: 'rose' }],
      sort: { field: 'guia', dir: 'asc' },
    },
  ],
});

describe('sheet: spec', () => {
  it('valida contra los campos reales y rechaza una fórmula editable', () => {
    const catalog = [manifiestos, guias].map((t) => ({ ...t }));
    const problems = checkSpecAgainst(spec, catalog as never);
    expect(problems.join(' ')).toContain('Total USD');
    expect(problems.join(' ')).toContain('se calcula sola');
  });
  it('rechaza agrupar por algo que no es la relación al padre', () => {
    const bad = viewSpecSchema.parse({
      ...spec,
      blocks: [{ ...(spec.blocks[0] as object), editable: [], group: { by: 'parcial', parentTracker: 'manifiestos', parentFields: ['numero'] } }],
    });
    expect(checkSpecAgainst(bad, [manifiestos, guias] as never).join(' ')).toContain('relación');
  });
});

describe('sheet: cálculo', () => {
  const sheetSpec = viewSpecSchema.parse({
    ...spec,
    blocks: [{ ...(spec.blocks[0] as object), editable: ['guia', 'parcial', 'kilos', 'manifiesto'] }],
  });
  const view = computeView(sheetSpec, sources, new Date(at), { writable: true });
  const block = view.blocks[0];
  if (block?.type !== 'sheet') throw new Error('no es una hoja');

  it('agrupa por el padre con sus campos y "Sin manifiesto" al final', () => {
    expect(block.groups?.map((g) => g.label)).toEqual(['FLEX 1', 'FLEX 2', 'Sin manifiesto']);
    expect(block.groups?.[0]?.fields).toEqual([
      { label: 'N° manifiesto', value: '3478' },
      { label: 'Estado', value: 'OK-BBIC' },
    ]);
    expect(block.rows.map((r) => r.group)).toEqual([0, 0, 1, 2]);
  });
  it('USD con 2 decimales y COP en pesos completos', () => {
    const i = block.columns.findIndex((c) => c.key === 'total_usd');
    expect(block.columns[i]?.fmt).toEqual({ kind: 'money', currency: 'USD' });
    expect(block.rows[0]?.cells[i]).toMatch(/9,00/);
    const j = block.columns.findIndex((c) => c.key === 'total_cop');
    expect(block.rows[0]?.cells[j]).toMatch(/30\.903/);
  });
  it('el parcial queda en rosado; las fórmulas no se editan', () => {
    const p = block.columns.findIndex((c) => c.key === 'parcial');
    expect(block.rows[1]?.tones[p]).toBe('rose');
    expect(block.rows[0]?.tones[p]).toBeNull();
    expect(block.columns.find((c) => c.key === 'total_usd')?.edit).toBeUndefined();
    expect(block.columns.find((c) => c.key === 'total_usd')?.readonly).toBe(true);
    expect(block.columns.find((c) => c.key === 'kilos')?.edit).toBeDefined();
  });
  it('totales: suma de toda columna numérica por omisión', () => {
    expect(block.totals.map((t) => t.col)).toContain(block.columns.findIndex((c) => c.key === 'kilos'));
    const k = block.columns.findIndex((c) => c.key === 'kilos');
    expect(sheetTotalDisplay(block.rows.map((r) => r.sort[k] ?? null), 'sum', block.columns[k]!.fmt)).toBe('161');
  });
  it('sin permiso de escribir no hay edición ni pegado', () => {
    const ro = computeView(sheetSpec, sources, new Date(at), { writable: false }).blocks[0];
    if (ro?.type !== 'sheet') throw new Error();
    expect(ro.write).toBeNull();
    expect(ro.columns.every((c) => !c.edit)).toBe(true);
  });
  it('exporta respetando el agrupado: grupo, subtotales y total', () => {
    const m = sheetMatrix(block);
    expect(m.header.slice(0, 3)).toEqual(['Grupo', 'N° manifiesto', 'Estado']);
    expect(m.rows[0]?.[0]).toBe('FLEX 1');
    const sub = m.rows.find((r) => String(r[0]).startsWith('Subtotal FLEX 1'));
    expect(sub).toBeTruthy();
    expect(m.rows[m.rows.length - 1]?.[0]).toBe('Total');
    expect(sheetCsv(m).startsWith('﻿')).toBe(true);
    const sheets = viewExportSheets(view);
    expect(sheets[0]?.rows.length).toBe(m.rows.length);
  });
});

describe('sheet: pegar desde Excel', () => {
  it('lee TSV con comillas y saltos', () => {
    const m = parseClipboard('a\tb\n"x\ny"\t"he said ""hi"""\n');
    expect(m).toEqual([['a', 'b'], ['x\ny', 'he said "hi"']]);
    expect(parseClipboard(toClipboard(m))).toEqual(m);
  });
  it('números a la colombiana', () => {
    expect(parsePastedNumber('3.433,71')).toBe(3433.71);
    expect(parsePastedNumber('0,09')).toBe(0.09);
    expect(parsePastedNumber('$ 1.234.567')).toBe(1234567);
    expect(parsePastedNumber('1,234.56')).toBe(1234.56);
    expect(parsePastedNumber('12')).toBe(12);
    expect(parsePastedNumber('1.500')).toBe(1500);
    expect(parsePastedNumber('hola')).toBeNull();
  });
  it('fechas día/mes/año, ISO, texto y serial de Excel', () => {
    expect(parsePastedDate('04/03/2026')).toBe('2026-03-04');
    expect(parsePastedDate('2026-03-04')).toBe('2026-03-04');
    expect(parsePastedDate('4-mar-26')).toBe('2026-03-04');
    expect(parsePastedDate('31/02/2026')).toBeNull();
    expect(parsePastedDate('46085')).toBe('2026-03-04');
  });
  it('mapea por encabezados y normaliza cada celda', () => {
    const fields = [
      { key: 'guia', label: 'Guía', type: 'text', options: [] },
      { key: 'parcial', label: 'Parcial', type: 'select', options: ['Sí', 'No'] },
      { key: 'kilos', label: 'Kilos', type: 'number', options: [] },
    ];
    const matrix = parseClipboard('Guía\tParcial\tKilos\nA-9\tsi\t1.234,5\nA-10\tno\tx');
    const mapped = mapPasteColumns(matrix, fields);
    expect(mapped.header).toBe(true);
    const rows = buildPasteRows(mapped.body, mapped.targets);
    expect(rows[0]).toMatchObject({ values: { guia: 'A-9', parcial: 'Sí', kilos: '1234.5' }, errors: [] });
    expect(rows[1]?.errors[0]).toContain('no es un número');
  });
  it('sin encabezados pega en orden', () => {
    const fields = [
      { key: 'guia', label: 'Guía', type: 'text', options: [] },
      { key: 'kilos', label: 'Kilos', type: 'number', options: [] },
    ];
    const mapped = mapPasteColumns(parseClipboard('A-1\t5\nA-2\t6'), fields);
    expect(mapped.header).toBe(false);
    expect(buildPasteRows(mapped.body, mapped.targets).map((r) => r.values)).toEqual([
      { guia: 'A-1', kilos: '5' },
      { guia: 'A-2', kilos: '6' },
    ]);
    expect(normalizePasteCell(fields[1]!, '')).toEqual({ ok: true, value: '' });
  });
});
