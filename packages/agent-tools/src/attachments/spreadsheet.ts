import { ValidationError } from '@cortex/core';
import { detectSpreadsheetFormat } from '../accounting/providers/spreadsheet-bytes';
import { XLSX_MIME, parseSpreadsheet } from '../kb/spreadsheets';
import type { SheetData, SheetValue } from '../kb/spreadsheets';

/**
 * UN EXCEL (O CSV) ADJUNTO EN EL CHAT.
 *
 * Lee los bytes con el mismo lector que usa Drive (`parseSpreadsheet`, exceljs:
 * todas las pestañas, celdas combinadas propagadas) pero SIN rechazar el
 * archivo por grande: lee hasta CHAT_SHEET_MAX_ROWS filas por pestaña y lo dice.
 * Después normaliza lo que en Colombia viene escrito como texto (fechas
 * 31/12/2026, montos «$ 1.234.567,89») para que sumar y filtrar funcione.
 *
 * Sin I/O ni base de datos: de bytes a tablas + un resumen compacto para el
 * modelo. Las filas completas viajan aparte (feed_tables) y se consultan con la
 * herramienta feed_table_query; el prompt solo lleva el resumen.
 */

export const CHAT_SHEET_MAX_BYTES = 10 * 1024 * 1024;
/** Filas que se leen por pestaña (encabezado incluido). */
export const CHAT_SHEET_MAX_ROWS = 20_000;
const MAX_COLUMNS = 60;
const MAX_CELLS = 600_000;
/** Tope del JSON guardado (mismo orden que el Feed, que rechaza más de 2 MB por captura). */
export const CHAT_SHEET_STORE_CHARS = 2_500_000;
const SUMMARY_CHARS = 7_000;
const PREVIEW_ROWS = 5;

export const XLS_MIME = 'application/vnd.ms-excel';
export const CSV_MIME = 'text/csv';

/** Tipo del archivo a partir del nombre (manda la extensión: los navegadores informan mal el CSV). */
export function chatSpreadsheetMime(name: string, declared: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'xlsx' || ext === 'xlsm') return XLSX_MIME;
  if (ext === 'xls') return XLS_MIME;
  if (ext === 'csv') return CSV_MIME;
  const mime = declared.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime === XLSX_MIME || mime === CSV_MIME) return mime;
  return null;
}

export function isChatSpreadsheetMime(mime: string): boolean {
  return mime === XLSX_MIME || mime === CSV_MIME || mime === XLS_MIME;
}

export type ColumnType = 'número' | 'fecha' | 'sí/no' | 'texto' | 'vacía';

export interface ColumnInfo {
  index: number;
  name: string;
  type: ColumnType;
  filled: number;
}

export interface SheetInfo {
  name: string;
  columns: ColumnInfo[];
  /** Filas leídas, encabezado incluido. */
  rowsRead: number;
  /** Filas que tiene la pestaña (encabezado incluido), aunque no se hayan leído. */
  totalRows: number;
  truncated: boolean;
}

export interface ChatSpreadsheet {
  tables: SheetData[];
  sheets: SheetInfo[];
  truncated: boolean;
  /** Resumen compacto para el prompt del modelo. */
  summary: string;
  /** Avisos honestos para la persona (recortes). */
  notes: string[];
}

const fmt = (n: number) => n.toLocaleString('es-CO');

// ---------------------------------------------------------------------------
// Errores claros
// ---------------------------------------------------------------------------

function assertReadable(buffer: Buffer, mime: string): string {
  if (buffer.length > CHAT_SHEET_MAX_BYTES)
    throw new ValidationError(
      'El Excel pasa de 10 MB. Guarda solo las pestañas que necesitas o divídelo en archivos más chicos.',
    );
  if (buffer.length === 0) throw new ValidationError('El archivo está vacío.');
  const format = detectSpreadsheetFormat(buffer);
  // Un contenedor antiguo de Office (.xls) y un .xlsx con contraseña comparten firma.
  if (format === 'xls') {
    throw new ValidationError(
      mime === XLS_MIME
        ? 'Es un Excel antiguo (.xls) y no lo puedo leer directo. Ábrelo en Excel, usa «Guardar como» .xlsx (o CSV) y adjúntalo de nuevo. Si tiene contraseña, quítala antes.'
        : 'Este Excel está protegido con contraseña, así que no lo puedo abrir. Quítale la contraseña (Archivo > Información > Proteger libro), guárdalo y adjúntalo de nuevo.',
    );
  }
  if (mime === CSV_MIME) return format === 'xlsx' ? XLSX_MIME : CSV_MIME;
  if (format !== 'xlsx')
    throw new ValidationError(
      'Ese archivo no parece un Excel .xlsx válido (puede estar dañado o ser de otro formato). Ábrelo en Excel y guárdalo como .xlsx o CSV.',
    );
  return XLSX_MIME;
}

// ---------------------------------------------------------------------------
// Normalización a la colombiana
// ---------------------------------------------------------------------------

const ISO_FULL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/;
const DMY = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
/** Identificadores que parecen montos con puntos (900.123.456): nunca se vuelven número. */
const ID_HEADER =
  /\b(nit|c[eé]dula|cc|documento|identificaci[oó]n|tel[eé]fono|celular|c[oó]digo|placa|gu[ií]a|factura|n[uú]mero|no\.?|id)\b/i;

/** Un Date que exceljs convirtió a ISO: fecha sola si es medianoche, con hora si no. */
function dateFromIso(value: string): string | null {
  const m = ISO_FULL.exec(value);
  if (!m) return null;
  const [, day, hh, mm, ss] = m;
  return hh === '00' && mm === '00' && ss === '00' ? (day as string) : `${day} ${hh}:${mm}`;
}

function dmyToIso(value: string): string | null {
  const m = DMY.exec(value.trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** «$ 1.234.567,89», «1.234», «12,5», «(1.000)» → número. null si no es un monto colombiano. */
export function parseColombianNumber(value: string): number | null {
  const original = value.trim();
  if (!original) return null;
  const negativeParens = /^\(.*\)$/.test(original);
  const hadCurrency = /[$]|COP|USD/i.test(original);
  const t = original
    .replace(/^\((.*)\)$/, '$1')
    .replace(/COP|USD/gi, '')
    .replace(/[$\s ]/g, '');
  let n: number;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));
  else if (/^-?\d+,\d+$/.test(t)) n = Number(t.replace(',', '.'));
  else if (hadCurrency && /^-?\d+$/.test(t)) n = Number(t);
  else return null;
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  return negativeParens ? -Math.abs(n) : n;
}

function isEmpty(v: SheetValue | undefined): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Fechas de exceljs a texto legible y números/fechas escritos como texto a su valor real. */
function normalizeRows(rows: SheetValue[][]): SheetValue[][] {
  const out = rows.map((r) =>
    r.map((v) => {
      if (typeof v !== 'string') return v;
      const t = v.trim();
      if (!t) return null;
      return dateFromIso(t) ?? t;
    }),
  );
  const width = out.reduce((n, r) => Math.max(n, r.length), 0);
  const header = out[0] ?? [];
  for (let c = 0; c < width; c++) {
    const cells = out.slice(1).map((r) => r[c]);
    const filled = cells.filter((v) => !isEmpty(v));
    if (filled.length === 0) continue;
    const strings = filled.filter((v): v is string => typeof v === 'string');
    const numbers = filled.filter((v) => typeof v === 'number').length;
    // Fechas dd/mm/aaaa escritas como texto.
    const dmy = strings.filter((s) => dmyToIso(s) !== null).length;
    if (dmy > 0 && dmy / filled.length >= 0.8) {
      for (const r of out.slice(1)) {
        const v = r[c];
        if (typeof v === 'string') r[c] = dmyToIso(v) ?? v;
      }
      continue;
    }
    // Montos colombianos escritos como texto.
    if (ID_HEADER.test(String(header[c] ?? ''))) continue;
    const co = strings.filter((s) => parseColombianNumber(s) !== null).length;
    if (co > 0 && (co + numbers) / filled.length >= 0.8) {
      for (const r of out.slice(1)) {
        const v = r[c];
        if (typeof v === 'string') {
          const n = parseColombianNumber(v);
          if (n !== null) r[c] = n;
        }
      }
    }
  }
  return out;
}

function trimSheet(sheet: SheetData): SheetData {
  let rows = normalizeRows(sheet.rows);
  let last = rows.length;
  while (last > 0 && (rows[last - 1] ?? []).every(isEmpty)) last--;
  rows = rows.slice(0, last);
  let width = 0;
  for (const r of rows) {
    for (let i = r.length - 1; i >= width; i--) {
      if (!isEmpty(r[i])) {
        width = i + 1;
        break;
      }
    }
  }
  rows = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
  const truncated = sheet.truncated === true;
  return {
    name: sheet.name,
    rows,
    truncated,
    totalRows: truncated ? (sheet.totalRows ?? rows.length) : rows.length,
  };
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

function columnType(values: SheetValue[]): ColumnType {
  const filled = values.filter((v) => !isEmpty(v));
  if (filled.length === 0) return 'vacía';
  const share = (pred: (v: SheetValue) => boolean) => filled.filter(pred).length / filled.length;
  if (share((v) => typeof v === 'number') >= 0.8) return 'número';
  if (share((v) => typeof v === 'boolean') >= 0.8) return 'sí/no';
  if (share((v) => typeof v === 'string' && ISO_DATE.test(v)) >= 0.8) return 'fecha';
  return 'texto';
}

function describeSheet(sheet: SheetData): SheetInfo {
  const header = sheet.rows[0] ?? [];
  const body = sheet.rows.slice(1);
  const columns = header.map((h, i) => {
    const values = body.map((r) => r[i] ?? null);
    return {
      index: i + 1,
      name: String(h ?? '').trim() || `Columna ${i + 1}`,
      type: columnType(values),
      filled: values.filter((v) => !isEmpty(v)).length,
    };
  });
  return {
    name: sheet.name,
    columns,
    rowsRead: sheet.rows.length,
    totalRows: sheet.totalRows ?? sheet.rows.length,
    truncated: sheet.truncated === true,
  };
}

function cellText(v: SheetValue | undefined): string {
  const t = v === null || v === undefined ? '' : String(v);
  return t.length > 40 ? `${t.slice(0, 37)}…` : t;
}

function sheetSummary(sheet: SheetData, info: SheetInfo, position: number, budget: number): string {
  const dataRows = Math.max(0, info.rowsRead - 1);
  const totalData = Math.max(0, info.totalRows - 1);
  const lines: string[] = [];
  lines.push(
    info.truncated
      ? `Pestaña ${position} «${info.name}»: tiene ${fmt(totalData)} filas de datos; leí solo las primeras ${fmt(dataRows)}.`
      : `Pestaña ${position} «${info.name}»: leí las ${fmt(dataRows)} filas de datos (fila 1 = encabezado).`,
  );
  if (info.rowsRead <= 1) {
    lines.push(info.rowsRead === 0 ? 'Está vacía.' : 'Solo tiene encabezado, sin filas de datos.');
    return lines.join('\n');
  }
  lines.push(
    `Columnas (número, nombre, tipo, celdas con dato): ${info.columns
      .slice(0, 40)
      .map((c) => `${c.index} ${c.name} (${c.type}, ${fmt(c.filled)})`)
      .join(
        ' | ',
      )}${info.columns.length > 40 ? ` | … y ${info.columns.length - 40} columnas más` : ''}`,
  );
  const preview = sheet.rows.slice(1, 1 + PREVIEW_ROWS).map(
    (r, i) =>
      `fila ${i + 2}: ${r
        .slice(0, 12)
        .map((v) => cellText(v))
        .join(' | ')}`,
  );
  lines.push(`Primeras ${preview.length} filas:\n${preview.join('\n')}`);
  const text = lines.join('\n');
  return text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
}

function buildSummary(name: string, tables: SheetData[], sheets: SheetInfo[], notes: string[]) {
  const budget = Math.max(900, Math.floor(SUMMARY_CHARS / Math.max(1, tables.length)));
  const parts = tables.map((t, i) => sheetSummary(t, sheets[i] as SheetInfo, i + 1, budget));
  return [
    `Hoja de cálculo «${name}»: ${tables.length} ${tables.length === 1 ? 'pestaña' : 'pestañas'}. Los números ya vienen como número y las fechas como AAAA-MM-DD. Solo ves un resumen; el resto de las filas está guardado: pídelo con feed_table_query (sheet = nombre exacto de la pestaña).`,
    ...notes,
    ...parts,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Tope de almacenamiento
// ---------------------------------------------------------------------------

/** Recorta filas de las pestañas más largas hasta que el JSON guardado quepa. */
function fitBudget(tables: SheetData[], notes: string[]): SheetData[] {
  const size = JSON.stringify(tables).length;
  if (size <= CHAT_SHEET_STORE_CHARS) return tables;
  const out = tables.map((t) => ({ ...t }));
  const factor = CHAT_SHEET_STORE_CHARS / size;
  for (const t of out) {
    const keep = Math.max(2, Math.floor(t.rows.length * factor * 0.95));
    if (keep < t.rows.length) {
      t.totalRows = Math.max(t.totalRows ?? 0, t.rows.length);
      t.rows = t.rows.slice(0, keep);
      t.truncated = true;
    }
  }
  notes.push(
    'El archivo es muy ancho o pesado: guardé solo las primeras filas de cada pestaña para poder consultarlas.',
  );
  return out;
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export async function readChatSpreadsheet(
  buffer: Buffer,
  input: { name: string; mime: string },
): Promise<ChatSpreadsheet> {
  const mime = assertReadable(buffer, input.mime);
  let raw: SheetData[];
  try {
    raw = await parseSpreadsheet(buffer, mime, {
      rowLimit: CHAT_SHEET_MAX_ROWS,
      maxColumns: MAX_COLUMNS,
      maxCells: MAX_CELLS,
    });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      'No pude abrir el Excel: parece dañado o con una protección que no reconozco. Ábrelo en Excel, guárdalo como .xlsx nuevo (o CSV) y adjúntalo de nuevo.',
    );
  }
  const notes: string[] = [];
  let tables = raw.map(trimSheet);
  if (tables.every((t) => t.rows.length === 0))
    throw new ValidationError('El Excel no tiene datos en ninguna pestaña.');
  tables = fitBudget(tables, notes);
  const sheets = tables.map(describeSheet);
  for (const s of sheets) {
    if (s.truncated)
      notes.push(
        `Leí ${fmt(Math.max(0, s.rowsRead - 1))} filas de la pestaña «${s.name}», que tiene ${fmt(Math.max(0, s.totalRows - 1))}: el resto no está disponible.`,
      );
  }
  const name = input.name.replace(/\.(xlsx|xlsm|xls|csv)$/i, '');
  return {
    tables,
    sheets,
    truncated: tables.some((t) => t.truncated === true),
    summary: buildSummary(name, tables, sheets, notes),
    notes,
  };
}
