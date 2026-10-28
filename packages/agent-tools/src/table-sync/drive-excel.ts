import { ValidationError } from '@cortex/core';
import { detectSpreadsheetFormat } from '../accounting/providers/spreadsheet-bytes';
import { driveGet, driveGetBytes } from '../gdrive/client';
import { GoogleApiError } from '../gsheets/errors';
import { XLSX_MIME, parseSpreadsheet } from '../kb/spreadsheets';
import type { SheetData } from '../kb/spreadsheets';
import type { ToolContext } from '../types';

/**
 * Excel (y CSV) guardados en Drive. Cuando alguien abre un .xlsx de Drive en la
 * interfaz de Hojas de cálculo, el enlace es docs.google.com/spreadsheets/d/…
 * igual que el de una hoja nativa, pero la API de Sheets lo rechaza (400 «This
 * operation is not supported for this document»). Esos archivos se descargan
 * por Drive con la misma conexión de Google y se leen con el lector de Excel
 * del repo, y devuelven las mismas pestañas y filas que la ruta de Sheets.
 */

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const XLS_MIME = 'application/vnd.ms-excel';
export const CSV_MIME = 'text/csv';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** Archivos que se leen por Drive en lugar de la API de Sheets. */
export function isDriveSpreadsheetMime(mime: string | null | undefined): boolean {
  return mime === XLSX_MIME || mime === XLS_MIME || mime === CSV_MIME;
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  /** Cambia cuando el archivo cambia: sirve para no descargarlo si sigue igual. */
  modifiedTime: string | null;
  md5Checksum: string | null;
  size: number | null;
}

/** Tope de descarga: un Excel mayor se rechaza antes de bajarlo. */
export const DRIVE_EXCEL_MAX_BYTES = 25 * 1024 * 1024;
/** Mismos topes que la ruta de Sheets (filas por pestaña y columnas A..AZ). */
const EXCEL_MAX_ROWS = 20_000;
const EXCEL_MAX_COLUMNS = 52;

export async function getDriveFileInfo(ctx: ToolContext, id: string): Promise<DriveFileInfo> {
  const f = await driveGet<{
    id: string;
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    md5Checksum?: string;
    size?: string;
  }>(ctx, `/files/${encodeURIComponent(id)}`, {
    fields: 'id,name,mimeType,modifiedTime,md5Checksum,size',
    supportsAllDrives: 'true',
  });
  return {
    id: f.id,
    name: f.name ?? 'Hoja de cálculo',
    mimeType: f.mimeType ?? '',
    modifiedTime: f.modifiedTime ?? null,
    md5Checksum: f.md5Checksum ?? null,
    size: f.size ? Number(f.size) : null,
  };
}

/** «Versión» del archivo para detectar cambios sin descargarlo. */
export function driveVersion(info: Pick<DriveFileInfo, 'md5Checksum' | 'modifiedTime'>): string {
  return info.md5Checksum ?? info.modifiedTime ?? '';
}

export interface DriveWorkbook {
  info: DriveFileInfo;
  sheets: SheetData[];
}

/** Baja el archivo de Drive y lo lee: mismas pestañas y filas que devuelve la ruta de Sheets. */
export async function loadDriveWorkbook(
  ctx: ToolContext,
  id: string,
  known?: DriveFileInfo,
): Promise<DriveWorkbook> {
  const info = known ?? (await getDriveFileInfo(ctx, id));
  if (!isDriveSpreadsheetMime(info.mimeType))
    throw new ValidationError(
      `«${info.name}» es un archivo de tipo ${info.mimeType || 'desconocido'}, no una hoja de cálculo que sepa leer. Sirve una hoja de Google, un Excel (.xlsx) o un CSV.`,
    );
  if (info.size !== null && info.size > DRIVE_EXCEL_MAX_BYTES)
    throw new ValidationError(
      `«${info.name}» pesa ${Math.round(info.size / 1024 / 1024)} MB y el máximo que leo de Drive es ${DRIVE_EXCEL_MAX_BYTES / 1024 / 1024} MB. Divídelo o conviértelo a una hoja de Google (Archivo > Guardar como hoja de cálculo de Google).`,
    );
  const bytes = await driveGetBytes(ctx, `/files/${encodeURIComponent(id)}`, {
    alt: 'media',
    supportsAllDrives: 'true',
  });
  const format = detectSpreadsheetFormat(bytes);
  let mime: string;
  if (format === 'xlsx') mime = XLSX_MIME;
  else if (format === 'text' && info.mimeType !== XLSX_MIME) mime = CSV_MIME;
  else if (format === 'xls')
    throw new ValidationError(
      `«${info.name}» es un Excel antiguo (.xls) y ese formato no lo leo. Ábrelo en Excel y guárdalo como .xlsx, o conviértelo a hoja de Google (Archivo > Guardar como hoja de cálculo de Google).`,
    );
  else
    throw new ValidationError(
      `El contenido de «${info.name}» no es un Excel ni un CSV legible (formato ${format}). Guárdalo como .xlsx o conviértelo a hoja de Google.`,
    );
  const sheets = await parseSpreadsheet(bytes, mime, {
    rowLimit: EXCEL_MAX_ROWS,
    maxColumns: EXCEL_MAX_COLUMNS,
  });
  if (!sheets.length) throw new ValidationError(`«${info.name}» no tiene pestañas.`);
  return { info, sheets };
}

/** Correo de la cuenta de Google conectada (para decir con quién compartir). Mejor esfuerzo. */
export async function connectedGoogleEmail(ctx: ToolContext): Promise<string | null> {
  try {
    const about = await driveGet<{ user?: { emailAddress?: string } }>(ctx, '/about', {
      fields: 'user(emailAddress)',
    });
    return about.user?.emailAddress ?? null;
  } catch {
    return null;
  }
}

export function isDriveScopeError(err: unknown): boolean {
  return (
    err instanceof GoogleApiError &&
    (err.status === 401 ||
      (err.status === 403 &&
        /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes|insufficient.*scope/i.test(
          err.body,
        )))
  );
}

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Un rango A1 («Hoja1!A1:D100», «Hoja1», «A:C») sobre las pestañas de un Excel leído. */
export function sliceA1(sheets: SheetData[], range: string): string[][] {
  const unquote = (t: string) => t.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  const A1 = /^\$?[A-Za-z]*\$?\d*(:\$?[A-Za-z]*\$?\d*)?$/;
  const bang = range.lastIndexOf('!');
  let rawTab = bang >= 0 ? unquote(range.slice(0, bang)) : '';
  let ref = bang >= 0 ? range.slice(bang + 1) : range;
  // Sin «!»: o es sólo el nombre de la pestaña, o sólo celdas de la primera.
  if (bang < 0 && !A1.test(range)) {
    rawTab = unquote(range);
    ref = '';
  }
  const sheet = rawTab ? sheets.find((s) => s.name === rawTab) : sheets[0];
  if (!sheet)
    throw new ValidationError(
      `No hay una pestaña «${rawTab}» en ese archivo. Pestañas: ${sheets.map((s) => `«${s.name}»`).join(', ')}.`,
    );
  const m = /^\$?([A-Za-z]+)?\$?(\d+)?(?::\$?([A-Za-z]+)?\$?(\d+)?)?$/.exec(ref);
  const [c1, r1, c2, r2] = m ? [m[1], m[2], m[3], m[4]] : [];
  const fromCol = c1 ? colNumber(c1) : 1;
  const toCol = c2 ? colNumber(c2) : c1 && !ref.includes(':') ? fromCol : Number.POSITIVE_INFINITY;
  const fromRow = r1 ? Number(r1) : 1;
  const toRow = r2 ? Number(r2) : r1 && !ref.includes(':') ? fromRow : Number.POSITIVE_INFINITY;
  const out = sheet.rows
    .slice(fromRow - 1, Number.isFinite(toRow) ? toRow : undefined)
    .map((row) => row.slice(fromCol - 1, Number.isFinite(toCol) ? toCol : undefined))
    .map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v))));
  while (out.length && out[out.length - 1]?.every((v) => v === '')) out.pop();
  return out;
}
