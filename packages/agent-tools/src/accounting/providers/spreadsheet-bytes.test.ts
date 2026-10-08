import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readSpreadsheetBytes, trialBalanceFromRows } from './reports';
import { detectSpreadsheetFormat, readXlsxMinimal } from './spreadsheet-bytes';

const HEADER = ['Código', 'Nombre', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final'];

/** Un .xlsx "de otra librería": prefijos de espacio de nombres y rutas absolutas. */
async function foreignXlsx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Portada" sheetId="1" r:id="rId1"/><x:sheet name="Balance" sheetId="2" r:id="rId2"/></x:sheets></x:workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="x/sharedStrings" Target="/xl/sharedStrings.xml"/></Relationships>',
  );
  const strings = ['Empresa S.A.S.', ...HEADER, 'Caja & Bancos', 'Ventas'];
  zip.file(
    'xl/sharedStrings.xml',
    `<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings
      .map((s, i) =>
        i === 9
          ? '<x:si><x:r><x:t>Caja </x:t></x:r><x:r><x:t>&amp; Bancos</x:t></x:r></x:si>'
          : `<x:si><x:t>${s}</x:t></x:si>`,
      )
      .join('')}</x:sst>`,
  );
  const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<x:worksheet ${ns}><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
  );
  zip.file(
    'xl/worksheets/sheet2.xml',
    `<x:worksheet ${ns}><x:sheetData>
      <x:row r="2">${HEADER.map((_, i) => `<x:c r="${'ABCDEF'[i]}2" t="s"><x:v>${i + 1}</x:v></x:c>`).join('')}</x:row>
      <x:row r="3"><x:c r="A3" t="inlineStr"><x:is><x:t>110505</x:t></x:is></x:c><x:c r="B3" t="s"><x:v>7</x:v></x:c><x:c r="C3"><x:v>0</x:v></x:c><x:c r="D3"><x:v>100</x:v></x:c><x:c r="E3"><x:v>0</x:v></x:c><x:c r="F3"><x:v>100</x:v></x:c></x:row>
      <x:row r="4"><x:c r="A4" t="str"><x:v>413505</x:v></x:c><x:c r="B4" t="s"><x:v>8</x:v></x:c><x:c r="C4"><x:v>0</x:v></x:c><x:c r="D4"><x:v>0</x:v></x:c><x:c r="E4"><x:v>100</x:v></x:c><x:c r="F4"><x:v>-100</x:v></x:c></x:row>
    </x:sheetData></x:worksheet>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

describe('lector de hojas por firma', () => {
  it('exceljs no lee el xlsx ajeno pero el lector mínimo sí', async () => {
    const bytes = await foreignXlsx();
    expect(detectSpreadsheetFormat(bytes)).toBe('xlsx');
    const { default: ExcelJS } = await import('exceljs');
    await expect(
      new ExcelJS.Workbook().xlsx.load(Buffer.from(bytes) as never),
    ).rejects.toBeDefined();
    const sheets = await readXlsxMinimal(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['Portada', 'Balance']);
    const parsed = trialBalanceFromRows(await readSpreadsheetBytes(bytes));
    expect(parsed.map((r) => [r.code, r.name, r.final])).toEqual([
      ['110505', 'Caja & Bancos', 100],
      ['413505', 'Ventas', -100],
    ]);
  });

  it('lee un HTML con tabla guardado como .xls', async () => {
    const html = `<html><body><table><tr><th>${HEADER.join('</th><th>')}</th></tr>
      <tr><td>110505</td><td>Caja&nbsp;general</td><td>0</td><td>100</td><td>0</td><td>100</td></tr></table></body></html>`;
    const bytes = new TextEncoder().encode(html);
    expect(detectSpreadsheetFormat(bytes)).toBe('html');
    const parsed = trialBalanceFromRows(await readSpreadsheetBytes(bytes));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ code: '110505', final: 100 });
  });

  it('un .xls antiguo (CFB) da un error claro', async () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(readSpreadsheetBytes(bytes)).rejects.toThrow(
      /formato que todavía no leo \(xls, 10 bytes\)/,
    );
  });

  it('un JSON de error incluye el mensaje de Siigo', async () => {
    const bytes = new TextEncoder().encode('{"Errors":[{"Message":"Reporte no disponible"}]}');
    await expect(readSpreadsheetBytes(bytes)).rejects.toThrow(
      /\(json, \d+ bytes\).*Reporte no disponible/,
    );
  });

  it('un xlsx normal sigue por exceljs', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Balance');
    ws.addRow(HEADER);
    ws.addRow(['110505', 'Caja', 0, 100, 0, 100]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const parsed = trialBalanceFromRows(await readSpreadsheetBytes(bytes));
    expect(parsed.map((r) => r.code)).toEqual(['110505']);
  });
});
