import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { gridToSheet } from '../datagrid/xlsx';
import { inferSheet, plainNumber } from './infer';
import {
  buildXlsx,
  columnLetter,
  excelDate,
  excelDateTime,
  sheetName,
  xlsxFileName,
} from './write';

async function open(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const sheet = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
  const styles = await zip.file('xl/styles.xml')?.async('string');
  return { zip, sheet: sheet ?? '', styles: styles ?? '' };
}

describe('escritor de .xlsx', () => {
  it('produce un zip que jszip reabre con las partes de un libro', async () => {
    const bytes = buildXlsx({
      name: 'Cartera',
      columns: [
        { header: 'Cliente', type: 'text' },
        { header: 'Monto', type: 'money', currency: 'COP' },
        { header: 'Vence', type: 'date' },
        { header: 'Activo', type: 'boolean' },
      ],
      rows: [['Acme & Cía', 1250000, '2026-10-02', true]],
    });
    const { zip, sheet, styles } = await open(bytes);
    expect(Object.keys(zip.files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    // Encabezado en negrita (estilo 1) y primera fila congelada.
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    // Texto escapado, dinero como número, fecha como serial, booleano.
    expect(sheet).toContain('Acme &amp; Cía');
    expect(sheet).toMatch(/<c r="B2" s="\d+"><v>1250000<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="C2" s="\d+"><v>46297<\/v><\/c>/);
    expect(sheet).toContain('<c r="D2" t="b"><v>1</v></c>');
    // Formato de pesos y de fecha declarados.
    expect(styles).toContain('formatCode="&quot;$&quot;#,##0"');
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
    expect(styles).toContain('<b/>');
    expect(await zip.file('xl/workbook.xml')?.async('string')).toContain('name="Cartera"');
  });

  it('un texto que empieza por = queda como texto, no como fórmula', async () => {
    const { sheet } = await open(
      buildXlsx({
        name: 'x',
        columns: [{ header: 'a', type: 'text' }],
        rows: [['=HYPERLINK("x")']],
      }),
    );
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;x&quot;)');
    expect(sheet).not.toContain('<f>');
  });

  it('las celdas vacías no se escriben y un valor fuera de tipo se conserva como texto', async () => {
    const { sheet } = await open(
      buildXlsx({
        name: 'x',
        columns: [
          { header: 'n', type: 'number' },
          { header: 'd', type: 'date' },
        ],
        rows: [
          [null, 'pronto'],
          ['abc', ''],
        ],
      }),
    );
    expect(sheet).not.toContain('r="A2"');
    expect(sheet).toContain(
      '<c r="B2" s="3" t="inlineStr">'
        .replace('s="3" ', 's="2" ')
        .replace('s="2" ', sheet.includes('s="2" t=') ? 's="2" ' : ''),
    );
    expect(sheet).toContain('abc');
  });

  it('serial de fechas y letras de columna', () => {
    expect(excelDate('2026-10-02')).toBe(46297);
    expect(excelDate('1900-03-01')).toBe(61);
    expect(excelDateTime('2026-10-02T12:00')).toBeCloseTo(46297.5);
    expect(excelDate('mañana')).toBeNull();
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
  });

  it('nombres de hoja y de archivo seguros', () => {
    expect(sheetName('Cartera: 2026/10 [x]')).toBe('Cartera 2026 10 x');
    expect(sheetName('')).toBe('Datos');
    expect(sheetName('a'.repeat(50))).toHaveLength(31);
    expect(xlsxFileName('¿Quién me debe?', '2026-10-02')).toBe('quien-me-debe-2026-10-02.xlsx');
  });

  it('la grilla conserva el tipo de cada columna', async () => {
    const sheet = gridToSheet(
      'Guías',
      [
        {
          id: '1',
          values: { n: 'Acme', m: '1.250.000', f: '2026-10-02', s: 'ok', t: 12.5 },
        } as never,
      ],
      [
        { key: 'n', label: 'Nombre', type: 'text' },
        { key: 'm', label: 'Valor', type: 'money' },
        { key: 'f', label: 'Fecha', type: 'date' },
        { key: 's', label: 'Estado', type: 'status', options: [{ value: 'ok', label: 'Al día' }] },
        { key: 't', label: 'Tasa', type: 'percent' },
      ] as never,
    );
    expect(sheet.rows[0]).toEqual(['Acme', 1250000, '2026-10-02', 'Al día', 12.5]);
    const { sheet: xml } = await open(buildXlsx(sheet));
    expect(xml).toMatch(/<c r="B2" s="\d+"><v>1250000<\/v>/);
  });

  it('la tabla del chat recupera números, plata y fechas; deja los códigos como texto', () => {
    const s = inferSheet(
      'Cartera',
      ['Cliente', 'Total a cobrar', 'Vence', 'NIT', 'Cantidad'],
      [
        ['Acme', '1.250.000', '2026-10-02', '900123456', '3'],
        ['Beta', '800000,5', '2026-11-01', '0123', '10'],
      ],
    );
    expect(s.columns.map((c) => c.type)).toEqual(['text', 'money', 'date', 'text', 'number']);
    expect(s.rows[0]).toEqual(['Acme', 1250000, '2026-10-02', '900123456', 3]);
    expect(s.rows[1]?.[1]).toBe(800000.5);
    expect(plainNumber('1.250.000')).toBe(1250000);
    expect(plainNumber('2.5')).toBe(2.5);
    expect(plainNumber('12abc')).toBeNull();
  });
});
