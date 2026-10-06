import { describe, expect, it } from 'vitest';
import type { SheetData } from '../kb/spreadsheets';
import type { TrackerField } from '../trackers/schema';
import { REVIEW_FIELD } from './plan';
import { readSheetRows } from './sheet-read';

const fields: TrackerField[] = [
  { key: 'numero', label: 'Número', type: 'text', required: false },
  { key: 'cliente', label: 'Cliente', type: 'text', required: false },
  { key: 'fecha', label: 'Fecha', type: 'date', required: false },
  { key: 'total', label: 'Total', type: 'money', required: false },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    required: false,
    options: ['Pendiente', 'Pagada'],
  },
  REVIEW_FIELD,
];
const mapping = {
  numero: 'N° Factura',
  cliente: 'Cliente',
  fecha: 'Fecha',
  total: 'Valor',
  estado: 'Estado',
};
const header = ['N° Factura', 'Cliente', 'Fecha', 'Valor', 'Estado'];
const sheet = (rows: SheetData['rows'], name = 'Octubre'): SheetData => ({
  name,
  rows: [header, ...rows],
});
const read = (sheets: SheetData[], over: Partial<Parameters<typeof readSheetRows>[0]> = {}) =>
  readSheetRows({ sheets, mapping, fields, keyFields: ['numero'], fileId: 'F1', ...over });

describe('una hoja de la carpeta, fila por fila y sin modelo', () => {
  it('cada fila es un registro: coerción por tipo y clave con el archivo', () => {
    const out = read([
      sheet([
        ['FE-1', 'Flores SAS', '2026-10-03', '1.500,50', 'Pendiente'],
        ['fe 2', 'Agro', '04/10/2026', 200, 'Pagada'],
      ]),
    ]);
    expect(out.notes).toEqual([]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({
      key: 'hoja:F1:0:FE1',
      keyMissing: false,
      values: { numero: 'FE-1', cliente: 'Flores SAS', fecha: '2026-10-03', estado: 'Pendiente' },
      review: [],
    });
    expect(out.rows[1]?.values).toMatchObject({ fecha: '2026-10-04', total: 200 });
    // «fe 2» y «FE-2» son la misma clave: leerla otra vez no duplica.
    expect(out.rows[1]?.key).toBe('hoja:F1:0:FE2');
  });

  it('un valor que no cabe en su tipo se descarta y la fila queda por revisar', () => {
    const out = read([
      sheet([
        ['FE-1', 'Flores', 'mañana', 100, 'Archivada'],
        ['', 'Sin número', '2026-10-01', 5, 'Pendiente'],
      ]),
    ]);
    const [bad, noKey] = out.rows;
    expect(bad?.values.fecha).toBeUndefined();
    expect(bad?.values.estado).toBeUndefined();
    expect(bad?.review.length).toBeGreaterThanOrEqual(1);
    // Sin clave la fila igual entra, con clave por posición, y se marca.
    expect(noKey).toMatchObject({ keyMissing: true, key: 'hoja:F1:0:fila3' });
    expect(noKey?.review.join(' ')).toContain('falta «Número»');
  });

  it('encabezados distintos: no se inventa, se avisa por qué', () => {
    const other: SheetData = {
      name: 'Otra',
      rows: [
        ['Código', 'Cosa'],
        ['A', 'B'],
      ],
    };
    const out = read([other]);
    expect(out.rows).toEqual([]);
    expect(out.tabsRead).toBe(0);
    expect(out.tabsSkipped).toBe(1);
    expect(out.notes[0]).toContain('no cuadra');
    expect(out.notes[0]).toContain('N° Factura');
  });

  it('una pestaña buena y una distinta: lee la buena y avisa de la otra', () => {
    const out = read([
      sheet([['FE-1', 'A', '2026-10-01', 1, 'Pendiente']]),
      {
        name: 'Resumen',
        rows: [
          ['Mes', 'Total'],
          ['Oct', 10],
        ],
      },
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.tabsSkipped).toBe(1);
    expect(out.notes.join(' ')).toContain('«Resumen»');
  });

  it('el mismo código en dos pestañas no choca; en la misma pestaña gana la última', () => {
    const out = read([
      sheet([
        ['FE-1', 'A', '2026-10-01', 1, 'Pendiente'],
        ['FE-1', 'B', '2026-10-01', 2, 'Pendiente'],
      ]),
      sheet([['FE-1', 'C', '2026-10-02', 3, 'Pendiente']], 'Noviembre'),
    ]);
    expect(out.rows.map((r) => r.key)).toEqual(['hoja:F1:0:FE1', 'hoja:F1:1:FE1']);
    expect(out.rows[0]?.values.cliente).toBe('B');
    expect(out.notes.join(' ')).toContain('misma clave');
  });

  it('el tope de filas se cuenta y se avisa', () => {
    const rows = Array.from({ length: 12 }, (_, i) => [
      `FE-${i}`,
      'X',
      '2026-10-01',
      i,
      'Pendiente',
    ]);
    const out = read([sheet(rows)], { cap: 5 });
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(true);
    expect(out.notes.join(' ')).toContain('sólo leí las primeras 5');
  });

  it('la subcarpeta no entra en la clave de una fila de hoja (mover el archivo no duplica)', () => {
    const f = [
      ...fields,
      { key: 'carpeta', label: 'Carpeta', type: 'text' as const, required: false },
    ];
    const out = readSheetRows({
      sheets: [sheet([['FE-1', 'A', '2026-10-01', 1, 'Pendiente']])],
      mapping,
      fields: f,
      keyFields: ['numero', 'carpeta'],
      fileId: 'F1',
    });
    expect(out.rows[0]?.key).toBe('hoja:F1:0:FE1');
    expect(out.rows[0]?.keyMissing).toBe(false);
  });
});
