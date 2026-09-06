import { Readable } from 'node:stream';
import { ValidationError } from '@cortex/core';
import type { CellValue, Worksheet } from 'exceljs';

export type SheetValue = string | number | boolean | null;
export interface SheetData {
  name: string;
  rows: SheetValue[][];
}
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function cellValue(value: CellValue): SheetValue {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if ('formula' in value || 'sharedFormula' in value) {
    // Never execute formulas or guess missing cached results.
    return value.result === undefined
      ? '[Fórmula sin resultado guardado]'
      : cellValue(value.result);
  }
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('text' in value) return value.text;
  if ('error' in value) return value.error;
  return null;
}

export async function parseSpreadsheet(buffer: Buffer, mime: string): Promise<SheetData[]> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  if (mime === 'text/csv') {
    // Preserve strings (including leading-zero IDs). Only unambiguous decimal
    // literals become numbers; dates and locale-specific amounts stay as written.
    const firstLine = buffer.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    await workbook.csv.read(Readable.from([buffer]), {
      parserOptions: { delimiter: firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',' },
      map: (value: string) => {
        if (!value) return null;
        return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
          Number.isFinite(Number(value)) &&
          Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER
          ? Number(value)
          : value;
      },
    });
  } else {
    await workbook.xlsx.load(buffer);
  }
  if (workbook.worksheets.length > 20)
    throw new ValidationError('Usa un archivo de hasta 20 hojas.');
  let cells = 0;
  const sheets = workbook.worksheets.map((sheet: Worksheet) => {
    if (sheet.rowCount * sheet.columnCount > 50_000) {
      throw new ValidationError(
        'La hoja supera 50.000 celdas. Divide el archivo para consultarlo.',
      );
    }
    const rows: SheetValue[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      cells += sheet.columnCount;
      if (cells > 50_000) throw new ValidationError('El archivo supera 50.000 celdas. Divídelo.');
      rows.push(
        Array.from({ length: sheet.columnCount }, (_, i) => cellValue(row.getCell(i + 1).value)),
      );
    });
    return { name: sheet.name, rows };
  });
  return sheets;
}

export function spreadsheetText(sheets: SheetData[]): string {
  return sheets
    .map((sheet) => {
      const [headers = [], ...body] = sheet.rows;
      const totals = headers.flatMap((header, col) => {
        const values = body
          .map((row) => row[col])
          .filter((v): v is number => typeof v === 'number');
        return values.length
          ? [
              `${String(header ?? col + 1)}: ${values.length} valores numéricos; suma ${values.reduce((a, b) => a + b, 0)}`,
            ]
          : [];
      });
      return `Hoja: ${sheet.name}\n${body.length} filas después de la primera fila.\nResumen calculado sobre todas las filas (primera fila tratada como encabezados; sumas sin interpretar unidades):\n${totals.join('\n')}\nCeldas por fila (JSON; conserva posiciones y tipos):\n${sheet.rows.map((row, i) => `${i + 1}: ${JSON.stringify(row)}`).join('\n')}`;
    })
    .join('\n\n');
}
