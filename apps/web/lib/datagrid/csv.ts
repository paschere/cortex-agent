import type { GridColumn, GridRow } from '@/components/datagrid/types';
import {
  asBoolean,
  asList,
  dayKey,
  foldText,
  isEmptyValue,
  isNumericType,
  optionLabel,
  parseNumber,
  personName,
  toLocalInput,
} from './format';

/**
 * CSV QUE EXCEL EN ESPAÑOL ABRE BIEN A LA PRIMERA.
 *
 * Tres detalles que deciden si alguien ve columnas o un solo chorro de texto:
 *   - BOM UTF-8 al principio: sin él Excel lee «Bogotá» como «BogotÃ¡».
 *   - Punto y coma como separador: en Colombia la coma es el decimal, y Excel
 *     configurado en español separa listas con «;».
 *   - Números sin separador de miles y con coma decimal (`1250000,5`), para que
 *     la celda quede como número y se pueda sumar.
 *
 * Y uno de seguridad: un texto que empieza con `=`, `+`, `-` o `@` se antepone
 * con un apóstrofo, para que nadie meta una fórmula en una celda ajena.
 */

export const CSV_BOM = '﻿';
export const CSV_SEPARATOR = ';';

function csvNumber(n: number): string {
  // Sin notación científica ni separadores de miles.
  const fixed = Number.isInteger(n) ? n.toFixed(0) : String(Number(n.toFixed(6)));
  return fixed.replace('.', ',');
}

/** Lo que va en la celda del CSV para este valor. */
export function csvValue(column: GridColumn, value: unknown): string {
  if (isEmptyValue(value)) return '';
  if (isNumericType(column.type)) {
    const n = parseNumber(value);
    return n === null ? String(value) : csvNumber(n);
  }
  switch (column.type) {
    case 'date':
      return dayKey(value) ?? String(value);
    case 'datetime':
      return toLocalInput(value).replace('T', ' ') || String(value);
    case 'select':
    case 'status':
      return optionLabel(column, value);
    case 'multi_select':
      return asList(value)
        .map((v) => optionLabel(column, v))
        .join(', ');
    case 'boolean':
      return asBoolean(value) ? 'Sí' : 'No';
    case 'person':
      return personName(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

function escapeCell(text: string, guardFormula: boolean): string {
  let s = text;
  if (guardFormula && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: GridRow[], columns: GridColumn[]): string {
  const lines = [columns.map((c) => escapeCell(c.label, true)).join(CSV_SEPARATOR)];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => escapeCell(csvValue(c, row.values[c.key]), !isNumericType(c.type)))
        .join(CSV_SEPARATOR),
    );
  }
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

/** «guias-de-carga-2026-10-02.csv». */
export function csvFileName(name: string, day: string): string {
  const base =
    foldText(name)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'datos';
  return `${base}-${day}.csv`;
}

// ---------------------------------------------------------------------------
// Leer un CSV (importar)
// ---------------------------------------------------------------------------

/** El separador de la primera línea, mirando solo fuera de comillas. */
export function detectSeparator(text: string): string {
  const counts: Record<string, number> = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/**
 * Un CSV a filas de texto. Comillas dobles, comillas escapadas (`""`), saltos
 * de línea dentro de comillas, CRLF y BOM. Las filas en blanco se descartan.
 */
export function parseCsv(input: string, separator?: string): string[][] {
  const text = input.startsWith(CSV_BOM) ? input.slice(1) : input;
  const sep = separator ?? detectSeparator(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
