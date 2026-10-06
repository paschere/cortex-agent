import type { SheetData } from '../kb/spreadsheets';
import { cellFor } from '../table-sync/sync';
import { type TrackerField, coerceValue } from '../trackers/schema';
import {
  CARPETA_KEY,
  type PlannedFileRow,
  SHEET_ROWS_PER_FILE,
  compact,
  externalKeyFor,
} from './plan';

/**
 * UNA HOJA DENTRO DE LA CARPETA, SIN MODELO.
 *
 * Una hoja de cálculo (Sheets, .xlsx, .csv) ya es una tabla: no hay nada que
 * «entender». La primera fila es el encabezado, cada fila de abajo es un
 * registro, y cada columna va al campo que la persona aprobó al crear la tabla
 * (`mapping`: campo → encabezado). Todo es determinista y gratis: la misma
 * hoja da siempre las mismas filas.
 *
 *   - COERCIÓN. Cada celda pasa por la misma lectura que las hojas conectadas
 *     (`cellFor`) y por `coerceValue` de la tabla; lo que no cabe en el tipo del
 *     campo (un texto en un campo de fecha, una opción que no existe) se
 *     descarta y la fila queda «Por revisar», nunca se inventa.
 *   - CLAVE. Archivo + valores de los campos clave: leer la hoja otra vez
 *     actualiza sus filas, no las duplica. Usa el id del archivo, no su ruta,
 *     así que mover el archivo de subcarpeta tampoco las duplica. Sin los
 *     campos clave en la fila, la clave es el archivo y la posición de la fila.
 *   - ENCABEZADOS DISTINTOS. Una pestaña cuyos encabezados no cuadran con el
 *     mapeo (le falta una columna clave o más de la mitad de las mapeadas) no se
 *     lee: se avisa por qué. Mejor un archivo por revisar que filas en las
 *     columnas equivocadas.
 *   - TOPE. `SHEET_ROWS_PER_FILE` filas por archivo; si hay más se cuenta y se
 *     avisa. Las filas que desaparecen de la hoja NO se borran de la tabla.
 */

export interface SheetReadResult {
  rows: PlannedFileRow[];
  /** Motivos por los que el archivo queda «por revisar» (vacío = limpio). */
  notes: string[];
  tabsRead: number;
  tabsSkipped: number;
  truncated: boolean;
  /** Filas de datos vistas (con algo escrito), antes del tope. */
  dataRows: number;
}

export function readSheetRows(input: {
  sheets: SheetData[];
  /** campo → encabezado de la hoja. */
  mapping: Record<string, string>;
  fields: TrackerField[];
  keyFields: string[];
  fileId: string;
  cap?: number;
}): SheetReadResult {
  const cap = input.cap ?? SHEET_ROWS_PER_FILE;
  const wanted = Object.entries(input.mapping)
    .map(([key, header]) => ({ field: input.fields.find((f) => f.key === key), header }))
    .filter((w): w is { field: TrackerField; header: string } => Boolean(w.field && w.header));
  // La subcarpeta la pone el motor; el archivo (por su id) ya desambigua.
  const keys = input.keyFields.filter((k) => k !== CARPETA_KEY);
  const keyHeaders = wanted.filter((w) => keys.includes(w.field.key));
  const out: SheetReadResult = {
    rows: [],
    notes: [],
    tabsRead: 0,
    tabsSkipped: 0,
    truncated: false,
    dataRows: 0,
  };
  if (!wanted.length) {
    out.notes.push('Esta sincronización no tiene columnas mapeadas para leer hojas.');
    return out;
  }

  input.sheets.forEach((sheet, tab) => {
    const [headerRow, ...body] = sheet.rows;
    if (!headerRow || !body.length) return; // una pestaña vacía no es un problema
    const cols = new Map<string, number>();
    headerRow.forEach((h, i) => {
      const c = compact(String(h ?? ''));
      if (c && !cols.has(c)) cols.set(c, i);
    });
    const found = wanted.filter((w) => cols.has(compact(w.header)));
    const missing = wanted.filter((w) => !cols.has(compact(w.header)));
    const keyMissing = keyHeaders.filter((w) => !cols.has(compact(w.header)));
    if (keyMissing.length || found.length < Math.ceil(wanted.length / 2)) {
      out.tabsSkipped += 1;
      out.notes.push(
        `La pestaña «${sheet.name}» no cuadra con las columnas de la tabla (faltan: ${missing
          .slice(0, 6)
          .map((w) => `«${w.header}»`)
          .join(', ')}). No la leí.`,
      );
      return;
    }
    out.tabsRead += 1;
    if (missing.length)
      out.notes.push(
        `En la pestaña «${sheet.name}» no están las columnas ${missing
          .slice(0, 6)
          .map((w) => `«${w.header}»`)
          .join(', ')}; esos campos quedan vacíos.`,
      );

    const byKey = new Map<string, PlannedFileRow>();
    let repeated = 0;
    body.forEach((cells, i) => {
      const values: Record<string, string | number> = {};
      const review: string[] = [];
      const line = i + 2;
      for (const w of found) {
        const cell = cells[cols.get(compact(w.header)) as number];
        const raw = cellFor(w.field, cell);
        if (raw === undefined || raw === '') continue;
        const coerced = coerceValue(w.field, raw);
        if (!coerced.ok) {
          review.push(`Hoja «${sheet.name}», fila ${line}: ${coerced.message}`);
          continue;
        }
        if (coerced.value !== '') values[w.field.key] = coerced.value;
      }
      if (!Object.keys(values).length && !review.length) return; // fila vacía
      out.dataRows += 1;
      if (out.dataRows > cap) {
        out.truncated = true;
        return;
      }
      const id = externalKeyFor(values, keys, input.fields);
      if (id === null)
        for (const k of keys) {
          const f = input.fields.find((x) => x.key === k);
          if (f && values[k] === undefined)
            review.push(`Hoja «${sheet.name}», fila ${line}: falta «${f.label}».`);
        }
      const key = (
        id !== null
          ? `hoja:${input.fileId}:${tab}:${id}`
          : `hoja:${input.fileId}:${tab}:fila${line}`
      ).slice(0, 400);
      const planned: PlannedFileRow = { key, keyMissing: id === null, values, review };
      const prior = byKey.get(key);
      if (prior) repeated += 1;
      byKey.set(
        key,
        prior
          ? {
              ...planned,
              values: { ...prior.values, ...planned.values },
              review: [...new Set([...prior.review, ...planned.review])],
            }
          : planned,
      );
    });
    if (repeated)
      out.notes.push(
        `En la pestaña «${sheet.name}» hay ${repeated} fila(s) con la misma clave que otra; quedó la última.`,
      );
    out.rows.push(...byKey.values());
  });

  if (out.truncated)
    out.notes.push(
      `La hoja trae más de ${cap.toLocaleString('es-CO')} filas; sólo leí las primeras ${cap.toLocaleString('es-CO')}.`,
    );
  if (!out.tabsRead && !out.notes.length)
    out.notes.push('La hoja no tiene filas de datos debajo del encabezado.');
  return out;
}
