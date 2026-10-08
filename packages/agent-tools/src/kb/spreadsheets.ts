import { Readable } from 'node:stream';
import { ValidationError } from '@cortex/core';
import type { CellValue, Worksheet } from 'exceljs';
import {
  detectSpreadsheetFormat,
  readXlsxMinimal,
} from '../accounting/providers/spreadsheet-bytes';

export type SheetValue = string | number | boolean | null;
export interface SheetData {
  name: string;
  rows: SheetValue[][];
  /** Con `rowLimit`: la hoja tenía más filas que las leídas. */
  truncated?: boolean;
  /** Con `rowLimit`: filas que tiene la hoja (encabezado incluido) aunque no se hayan leído. */
  totalRows?: number;
}

/**
 * Cómo se lee una hoja GRANDE. Sin opciones, el comportamiento de siempre: más de
 * 50.000 celdas se rechaza (consultas del chat, Brain). Con `rowLimit` no se
 * rechaza nada: se leen el encabezado y las primeras `rowLimit` filas de cada
 * pestaña, con un tope de columnas y de celdas por archivo, y se marca
 * `truncated` con las filas que había.
 */
export interface ParseSpreadsheetOptions {
  /** Filas por pestaña, encabezado incluido. */
  rowLimit?: number;
  /** Columnas que se leen por fila (por defecto 200). */
  maxColumns?: number;
  /** Celdas leídas en todo el archivo (por defecto 2.000.000). */
  maxCells?: number;
}

const BLOCK_MAX_COLUMNS = 200;
const BLOCK_MAX_CELLS = 2_000_000;

/** Una hoja ya leída, recortada a `rowLimit` filas y `maxColumns` columnas. */
function trimSheet(
  sheet: SheetData,
  opts: Required<Pick<ParseSpreadsheetOptions, 'rowLimit' | 'maxColumns'>>,
): SheetData {
  const totalRows = sheet.totalRows ?? sheet.rows.length;
  const rows = sheet.rows.slice(0, opts.rowLimit).map((r) => r.slice(0, opts.maxColumns));
  // El lector mínimo corta al llegar al tope y no sabe cuántas había: ahí se supone que hay más.
  const truncated =
    totalRows > rows.length ||
    (sheet.totalRows === undefined && sheet.rows.length >= opts.rowLimit);
  return { name: sheet.name, rows, truncated, totalRows };
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

function limitSheets(raw: SheetData[]): SheetData[] {
  if (raw.length > 20) throw new ValidationError('Usa un archivo de hasta 20 hojas.');
  let cells = 0;
  for (const sheet of raw) {
    for (const row of sheet.rows) {
      cells += row.length;
      if (cells > 50_000) throw new ValidationError('El archivo supera 50.000 celdas. Divídelo.');
    }
  }
  return raw;
}

export async function parseSpreadsheet(
  buffer: Buffer,
  mime: string,
  options: ParseSpreadsheetOptions = {},
): Promise<SheetData[]> {
  const block = options.rowLimit
    ? {
        rowLimit: options.rowLimit,
        maxColumns: options.maxColumns ?? BLOCK_MAX_COLUMNS,
        maxCells: options.maxCells ?? BLOCK_MAX_CELLS,
      }
    : null;
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
    try {
      await workbook.xlsx.load(buffer);
    } catch (err) {
      // Un .xlsx de otra librería que exceljs no entiende: lector mínimo propio.
      if (detectSpreadsheetFormat(buffer) !== 'xlsx') throw err;
      const raw = await readXlsxMinimal(buffer, block ? { maxRows: block.rowLimit } : {}).catch(
        () => {
          throw err;
        },
      );
      if (block) return raw.map((sheet) => trimSheet(sheet, block));
      return limitSheets(raw);
    }
  }
  if (workbook.worksheets.length > 20)
    throw new ValidationError('Usa un archivo de hasta 20 hojas.');
  let cells = 0;
  const sheets = workbook.worksheets.map((sheet: Worksheet) => {
    if (block) {
      // Hoja grande: encabezado + primeras filas, sin rechazar por el tamaño.
      const width = Math.min(sheet.columnCount, block.maxColumns);
      const rows: SheetValue[][] = [];
      let seen = 0;
      sheet.eachRow({ includeEmpty: true }, (row) => {
        seen += 1;
        if (rows.length >= block.rowLimit || cells + width > block.maxCells) return;
        cells += width;
        rows.push(Array.from({ length: width }, (_, i) => cellValue(row.getCell(i + 1).value)));
      });
      return { name: sheet.name, rows, truncated: seen > rows.length, totalRows: seen };
    }
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
