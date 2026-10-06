import { describe, expect, it } from 'vitest';
import type { SheetData } from '../kb/spreadsheets';
import { XLSX_MIME } from '../kb/spreadsheets';
import { type FolderTree, inventoryOf } from './inventory';
import type { FolderFile } from './plan';
import { REVIEW_FIELD } from './plan';
import { type DocProposal, combineFolderProposal } from './propose-folder';

const folder = { id: 'root', name: 'Facturas' };
const f = (id: string, name: string, mimeType: string, path = ''): FolderFile => ({
  id,
  name,
  mimeType,
  revision: 'r',
  modifiedTime: null,
  size: null,
  path,
});
const dims = { maxDepth: 3, maxFiles: 500 };
function inv(
  files: FolderFile[],
  folders: FolderTree['folders'] = [],
  recursive = folders.length > 0,
) {
  return inventoryOf(
    { files, folders, truncated: false, tooDeep: [], skipped: [], problems: [] },
    { recursive, ...dims },
  );
}
const head = ['Factura', 'Cliente', 'Fecha', 'Valor'];
function sheet(rows: Array<Array<string | number>>, header = head, name = 'Hoja 1'): SheetData {
  return { name, rows: [header, ...rows] };
}
const many = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => [
    `${prefix}-${i}`,
    `C${i % 3}`,
    `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
    100 + i,
  ]);

const doc: DocProposal = {
  name: 'Facturas',
  description: 'Facturas de proveedores',
  fields: [
    { key: 'numero', label: 'Número', type: 'text', required: false },
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'nit', label: 'NIT', type: 'text', required: false },
    REVIEW_FIELD,
  ],
  extract: [
    { key: 'numero', hint: 'arriba a la derecha' },
    { key: 'cliente', hint: '' },
    { key: 'nit', hint: 'bajo la razón social' },
  ],
  keyFields: ['numero'],
  sampleName: 'f-001.pdf',
};

describe('propuesta de una carpeta', () => {
  it('hoja + documentos + subcarpetas: campos con su origen, carpeta y revisión', () => {
    const s1 = f('s1', 'oct.xlsx', XLSX_MIME, 'Cliente A');
    const p = combineFolderProposal({
      folder,
      recursive: true,
      inventory: inv(
        [s1, f('d1', 'f-001.pdf', 'application/pdf', 'Cliente A')],
        [{ id: 'A', name: 'Cliente A', path: 'Cliente A', depth: 1, files: 2 }],
      ),
      sheets: [{ file: s1, tab: sheet(many('FE', 30)) }],
      doc,
    });
    const by = (k: string) => p.fields.find((x) => x.key === k);
    expect(p.sheetRows).toBe(30);
    expect(by('factura')?.sourceColumn).toBe('Factura');
    expect(by('nit')).toMatchObject({ fromDocument: true, hint: 'bajo la razón social' });
    expect(by('nit')?.sourceColumn).toBeUndefined();
    expect(by('carpeta')).toMatchObject({ fromFolder: true, type: 'text' });
    expect(by('carpeta')?.samples).toEqual(['Cliente A']);
    expect(by('revision')?.type).toBe('select');
    expect(p.keyFields).toEqual(['factura']);
    expect(p.markdown).toContain('¿La creo así o quieres cambiar algo');
    expect(p.markdown).toContain('subcarpetas');
    expect(p.markdown).toContain('no se borra de la tabla');
  });

  it('el mismo código en carpetas distintas: la carpeta entra a la clave', () => {
    const a = f('s1', 'a.xlsx', XLSX_MIME, 'Cliente A');
    const b = f('s2', 'b.xlsx', XLSX_MIME, 'Cliente B');
    const rows = many('FE', 12);
    const p = combineFolderProposal({
      folder,
      recursive: true,
      inventory: inv(
        [a, b],
        [
          { id: 'A', name: 'Cliente A', path: 'Cliente A', depth: 1, files: 1 },
          { id: 'B', name: 'Cliente B', path: 'Cliente B', depth: 1, files: 1 },
        ],
      ),
      sheets: [
        { file: a, tab: sheet(rows) },
        { file: b, tab: sheet(rows) },
      ],
      doc: null,
    });
    expect(p.keyFields).toEqual(['factura', 'carpeta']);
    expect(p.keyWhy).toContain('carpetas distintas');
    expect(p.sheetFiles).toBe(2);
  });

  it('hojas con encabezados compatibles se unen; con otros encabezados no se mezclan y se pregunta', () => {
    const a = f('s1', 'a.xlsx', XLSX_MIME);
    const b = f('s2', 'b.xlsx', XLSX_MIME);
    const c = f('s3', 'inventario.xlsx', XLSX_MIME);
    const p = combineFolderProposal({
      folder,
      recursive: false,
      inventory: inv([a, b, c]),
      sheets: [
        { file: a, tab: sheet(many('FE', 10)) },
        { file: b, tab: sheet(many('FG', 8)) },
        {
          file: c,
          tab: sheet(
            [['Sku', 'Bodega', 'Existencias'].map(String)],
            ['Sku', 'Bodega', 'Existencias'],
          ),
        },
        { file: c, tab: sheet([['K1', 'B1', 3]], ['Sku', 'Bodega', 'Existencias']) },
      ],
      doc: null,
    });
    expect(p.sheetFiles).toBe(2);
    expect(p.sheetRows).toBe(18);
    expect(p.notes.join(' ')).toContain('una sola tabla');
    expect(p.fields.some((x) => x.key === 'sku')).toBe(false);
    expect(p.fields.some((x) => x.key === 'carpeta')).toBe(false);
  });

  it('sólo documentos: clave del documento y riesgo de duplicado con la fecha', () => {
    const p = combineFolderProposal({
      folder,
      recursive: false,
      inventory: inv([f('d1', 'f-001.pdf', 'application/pdf')]),
      sheets: [],
      doc: {
        ...doc,
        fields: [
          ...doc.fields.slice(0, 3),
          { key: 'fecha', label: 'Fecha', type: 'date', required: false },
          REVIEW_FIELD,
        ],
        extract: [...doc.extract, { key: 'fecha', hint: '' }],
      },
    });
    expect(p.keyFields).toEqual(['numero', 'fecha']);
    expect(p.duplicates).toMatchObject({ key: 'numero', distinctBy: 'fecha', flagField: 'estado' });
    expect(p.fields.find((x) => x.key === 'estado')?.options).toContain('Duplicado');
  });

  it('una carpeta sin nada legible no propone una tabla vacía', () => {
    expect(() =>
      combineFolderProposal({
        folder,
        recursive: false,
        inventory: inv([f('x', 'viejo.xls', 'application/vnd.ms-excel')]),
        sheets: [],
        doc: null,
      }),
    ).toThrow(/nada que pueda leer/);
  });
});
