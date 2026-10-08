import JSZip from 'jszip';

/**
 * LECTOR DE HOJAS DE CÁLCULO POR FIRMA DE BYTES.
 *
 * exceljs sólo entiende los .xlsx "de Excel": uno armado por otra librería
 * (rutas absolutas en los rels, prefijos de espacio de nombres) lo hace caer
 * con un TypeError interno («reading 'sheets'»). Aquí se detecta el formato
 * real del archivo y, para .xlsx, hay un lector mínimo propio que no depende
 * de esas manías. Sin I/O: de bytes a filas.
 */

export type SpreadsheetFormat = 'xlsx' | 'xls' | 'html' | 'json' | 'xml' | 'text' | 'desconocido';
export type Cell = string | number | boolean | null;
export interface RawSheet {
  name: string;
  rows: Cell[][];
}

/** Tope de celdas por hoja (el mismo que usa xlsxRows). */
export const MAX_SHEET_CELLS = 400_000;

export function detectSpreadsheetFormat(bytes: Uint8Array): SpreadsheetFormat {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
      return 'xlsx';
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
      return 'xls';
  }
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.startsWith('<'))
    return /<\s*(!doctype\s+html|html|table|meta)\b/i.test(head) ? 'html' : 'xml';
  return head ? 'text' : 'desconocido';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    if (hex || dec) {
      const code = hex ? Number.parseInt(hex, 16) : Number(dec);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[String(name).toLowerCase()] ?? m;
  });
}

/** «B3» → índice de columna base 0 (A=0, AA=26). */
export function columnIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0].toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`(?:^|[\\s:])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.[2] ??
  new RegExp(`(?:^|[\\s:])${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1];

/** Texto de todos los <t> de un fragmento (rich text incluido, sin fonética). */
function textOf(xml: string): string {
  const clean = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g))
    out += decodeEntities(m[1] ?? '');
  return out;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function sheetCells(xml: string, shared: string[], maxRows?: number): Cell[][] | null {
  const rows: Cell[][] = [];
  let cells = 0;
  let rowSeq = 0;
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rAttr = attr(rm[1] ?? '', 'r');
    const rowIdx = rAttr ? Number(rAttr) - 1 : rowSeq;
    rowSeq = rowIdx + 1;
    if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx > 1_048_576) continue;
    // Con tope de filas (hojas grandes): se lee el comienzo y se deja el resto.
    if (maxRows !== undefined && rowIdx >= maxRows) break;
    const row: Cell[] = [];
    let colSeq = 0;
    for (const cm of (rm[2] ?? '').matchAll(
      /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g,
    )) {
      const ref = attr(cm[1] ?? '', 'r');
      const col = ref ? columnIndex(ref) : colSeq;
      colSeq = col + 1;
      if (col < 0 || col > 16_384) continue;
      const type = attr(cm[1] ?? '', 't') ?? 'n';
      const inner = cm[2] ?? '';
      const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let value: Cell = null;
      if (type === 'inlineStr') value = textOf(inner);
      else if (v !== undefined) {
        const raw = decodeEntities(v);
        if (type === 's') value = shared[Number(raw)] ?? null;
        else if (type === 'b') value = raw.trim() === '1';
        else if (type === 'str' || type === 'e' || type === 'd') value = raw;
        else {
          const n = Number(raw);
          value = raw.trim() !== '' && Number.isFinite(n) ? n : raw;
        }
      }
      if (value === null) continue;
      if (++cells > MAX_SHEET_CELLS && maxRows === undefined) return null;
      while (row.length < col) row.push(null);
      row[col] = value;
    }
    while (rows.length < rowIdx) rows.push([]);
    rows[rowIdx] = row;
  }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  if (rows.length * Math.max(width, 1) > MAX_SHEET_CELLS && maxRows === undefined) return null;
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
}

/** Lector mínimo de .xlsx: tolera rutas absolutas y prefijos de espacio de nombres. */
export async function readXlsxMinimal(
  bytes: Uint8Array,
  opts: { maxRows?: number } = {},
): Promise<RawSheet[]> {
  const zip = await JSZip.loadAsync(bytes);
  const index = new Map<string, JSZip.JSZipObject>();
  for (const [name, file] of Object.entries(zip.files))
    if (!file.dir) index.set(name.replace(/^\/+/, '').toLowerCase(), file);
  const read = async (path: string) =>
    index.get(path.replace(/^\/+/, '').toLowerCase())?.async('string');

  // Libro: por [Content_Types].xml / _rels/.rels, o el nombre habitual.
  let workbookPath = 'xl/workbook.xml';
  const rootRels = await read('_rels/.rels');
  if (rootRels) {
    for (const m of rootRels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
      if (/officeDocument/i.test(attr(m[0], 'Type') ?? '')) {
        const t = attr(m[0], 'Target');
        if (t) workbookPath = resolvePath('x', t);
        break;
      }
    }
  }
  if (!index.has(workbookPath.toLowerCase())) {
    const ct = await read('[Content_Types].xml');
    const hit = ct && /PartName="([^"]+)"[^>]*spreadsheetml\.(?:sheet|template)\.main/i.exec(ct);
    if (hit?.[1]) workbookPath = hit[1].replace(/^\/+/, '');
  }
  const workbook = await read(workbookPath);
  const relsPath = `${workbookPath.split('/').slice(0, -1).join('/')}/_rels/${workbookPath.split('/').pop()}.rels`;
  const rels = (await read(relsPath.replace(/^\//, ''))) ?? '';
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTarget.set(id, resolvePath(workbookPath, target));
  }

  // Cadenas compartidas.
  const sharedPath =
    [...relTarget.values()].find((p) => /sharedstrings/i.test(p)) ?? 'xl/sharedStrings.xml';
  const sharedXml = await read(sharedPath);
  const shared: string[] = [];
  if (sharedXml)
    for (const m of sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g))
      shared.push(textOf(m[1] ?? ''));

  // Hojas en el orden del libro; si no se resuelven, todas las xl/worksheets/*.xml.
  const targets: { name: string; path: string }[] = [];
  for (const m of (workbook ?? '').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const rid = attr(m[0], 'id');
    const path = rid ? relTarget.get(rid) : undefined;
    if (path && index.has(path.toLowerCase()))
      targets.push({
        name: decodeEntities(attr(m[0], 'name') ?? `Hoja${targets.length + 1}`),
        path,
      });
  }
  if (!targets.length) {
    const paths = [...index.keys()]
      .filter((p) => /(^|\/)worksheets\/[^/]+\.xml$/.test(p))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    paths.forEach((path, i) => targets.push({ name: `Hoja${i + 1}`, path }));
  }

  const sheets: RawSheet[] = [];
  for (const t of targets) {
    const xml = await read(t.path);
    const rows = xml ? sheetCells(xml, shared, opts.maxRows) : null;
    if (rows) sheets.push({ name: t.name, rows });
  }
  return sheets;
}

/** Filas de la primera <table> de un HTML guardado como .xls. */
export function readHtmlTable(html: string): RawSheet[] {
  const table = /<table\b[\s\S]*?(?:<\/table>|$)/i.exec(html)?.[0] ?? '';
  const rows: Cell[][] = [];
  for (const tr of table.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tr>|<\/table>|$)/gi)) {
    const row: Cell[] = [];
    for (const td of (tr[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<\/t[dh]>|<t[dh]\b|$)/gi)) {
      const text = decodeEntities((td[1] ?? '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
      row.push(text === '' ? null : text);
    }
    if (row.length) rows.push(row);
  }
  return rows.length ? [{ name: 'Tabla', rows }] : [];
}

function jsonMessage(text: string): string | null {
  try {
    const body = JSON.parse(text) as unknown;
    const pick = (o: unknown): string | null => {
      if (!o || typeof o !== 'object') return typeof o === 'string' ? o : null;
      const r = o as Record<string, unknown>;
      for (const k of ['Message', 'message', 'detail', 'error', 'title']) {
        const m = pick(r[k]);
        if (m) return m;
      }
      if (Array.isArray(r.Errors)) return pick(r.Errors[0]);
      if (Array.isArray(r.errors)) return pick(r.errors[0]);
      return null;
    };
    return pick(Array.isArray(body) ? body[0] : body);
  } catch {
    return null;
  }
}

export function unreadableFormatMessage(bytes: Uint8Array, format: SpreadsheetFormat): string {
  let msg = `Siigo entregó el balance de prueba en un formato que todavía no leo (${format}, ${bytes.length} bytes).`;
  if (format === 'json') {
    const m = jsonMessage(new TextDecoder().decode(bytes.subarray(0, 4096)));
    if (m) msg += ` Siigo respondió: ${m.slice(0, 300)}`;
  } else if (format === 'xls')
    msg += ' Es un Excel antiguo (.xls); pídele a Siigo el reporte en .xlsx.';
  return msg;
}

/**
 * Hojas de un archivo de cualquier formato soportado. `tryPrimary` es el lector
 * principal (exceljs) para .xlsx; si lanza, se cae al lector mínimo y se avisa
 * por `onPrimaryFailure` para dejar rastro en producción.
 */
export async function readSheetsByFormat(
  bytes: Uint8Array,
  opts: {
    tryPrimary?: (bytes: Uint8Array) => Promise<RawSheet[]>;
    onPrimaryFailure?: (err: unknown, format: SpreadsheetFormat) => void;
    unreadable?: (bytes: Uint8Array, format: SpreadsheetFormat) => Error;
  } = {},
): Promise<RawSheet[]> {
  const format = detectSpreadsheetFormat(bytes);
  if (format === 'xlsx') {
    if (opts.tryPrimary) {
      try {
        return await opts.tryPrimary(bytes);
      } catch (err) {
        opts.onPrimaryFailure?.(err, format);
      }
    }
    return readXlsxMinimal(bytes);
  }
  if (format === 'html') {
    const sheets = readHtmlTable(new TextDecoder().decode(bytes));
    if (sheets.length) return sheets;
  }
  throw (opts.unreadable ?? ((b, f) => new Error(unreadableFormatMessage(b, f))))(bytes, format);
}
