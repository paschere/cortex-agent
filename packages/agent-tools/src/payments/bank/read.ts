import { ValidationError } from '@cortex/core';
import { XLSX_MIME, parseSpreadsheet } from '../../kb/spreadsheets';
import { type Cell, decodeText, parseCsv } from './format';
import { type ParseOptions, type StatementParse, parseStatementRows } from './parse';

/**
 * Del archivo a las filas: CSV (o texto separado por `;`, tabulador o `|`) y
 * Excel .xlsx.
 *
 * Excel se lee con el mismo `parseSpreadsheet` (exceljs) que usa Brain
 * Knowledge, que nunca ejecuta fórmulas y que ya trae los límites de tamaño. El
 * CSV se lee aquí y no con exceljs porque un extracto necesita lo que exceljs
 * no hace: adivinar Windows-1252 (las tildes de casi todo banco colombiano) y
 * dejar cada importe como TEXTO para que «1.234,56» lo lea `parseAmount` con
 * la regla de la columna entera, no con la de cada celda.
 *
 * El .xls antiguo (binario de Excel 97) no se puede leer sin otra dependencia;
 * se dice en claro cómo convertirlo en vez de fallar raro.
 */

export const STATEMENT_MAX_BYTES = 10 * 1024 * 1024;

export type StatementFileKind = 'csv' | 'xlsx';

export function statementFileKind(
  bytes: Uint8Array,
  fileName: string,
  mime?: string | null,
): StatementFileKind {
  const name = fileName.toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (isOle || (name.endsWith('.xls') && !isZip)) {
    throw new ValidationError(
      'Ese archivo es de Excel antiguo (.xls). Ábrelo en Excel y guárdalo como .xlsx o como CSV, y vuelve a subirlo.',
    );
  }
  if (isZip || name.endsWith('.xlsx') || mime === XLSX_MIME) {
    if (!isZip)
      throw new ValidationError('El archivo dice ser Excel pero no lo es. Expórtalo otra vez.');
    return 'xlsx';
  }
  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    throw new ValidationError(
      'Los extractos en PDF todavía no se leen. Descarga los movimientos en Excel o CSV desde la banca en línea.',
    );
  }
  return 'csv';
}

/** Todas las hojas del archivo, como filas de celdas. */
export async function readStatementSheets(
  bytes: Uint8Array,
  fileName: string,
  mime?: string | null,
): Promise<Array<{ name: string; rows: Cell[][] }>> {
  if (bytes.length === 0) throw new ValidationError('El archivo está vacío.');
  if (bytes.length > STATEMENT_MAX_BYTES) {
    throw new ValidationError('El archivo pasa de 10 MB. Divide el periodo en dos.');
  }
  const kind = statementFileKind(bytes, fileName, mime);
  if (kind === 'xlsx') {
    const sheets = await parseSpreadsheet(Buffer.from(bytes), XLSX_MIME);
    return sheets.map((s) => ({ name: s.name, rows: s.rows as Cell[][] }));
  }
  const text = decodeText(bytes);
  return [{ name: fileName, rows: parseCsv(text) }];
}

/**
 * Leer y entender el extracto. Con varias hojas, la primera que se deja leer;
 * si ninguna, se pide escoger columnas sobre la primera que tenga datos.
 */
export async function parseStatementFile(
  bytes: Uint8Array,
  fileName: string,
  mime: string | null | undefined,
  opts: Omit<ParseOptions, 'fileName'> = {},
): Promise<StatementParse> {
  const sheets = (await readStatementSheets(bytes, fileName, mime)).filter((s) =>
    s.rows.some((r) => r.some((c) => c != null && String(c).trim() !== '')),
  );
  if (sheets.length === 0) throw new ValidationError('El archivo no trae ninguna fila con datos.');
  let first: StatementParse | null = null;
  for (const sheet of sheets) {
    const parsed = parseStatementRows(sheet.rows, { ...opts, fileName });
    if (parsed.status === 'ready' && (parsed.credits.length > 0 || parsed.debits > 0))
      return parsed;
    first ??= parsed;
    // Con columnas escogidas a mano, se aplican sólo a la primera hoja.
    if (opts.mapping) break;
  }
  return first as StatementParse;
}
