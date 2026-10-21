/**
 * El cálculo puro de la escritura de vuelta a una hoja (0237): dada la hoja tal
 * como está AHORA, qué celdas hay que escribir para cambiar una fila. Nada de
 * red ni de base: lo que se prueba y lo que decide si se escribe o no.
 */

export const ENTRY_COLUMNS_FOR_WRITE_BACK = 'id, values';

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const norm = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLowerCase();

export type SheetWritePlan =
  | {
      ok: true;
      rowNumber: number;
      cells: Array<{ a1: string; header: string; value: string | number }>;
    }
  | { ok: false; error: string };

export function planSheetWrite(input: {
  /** Las filas de la hoja en vivo, encabezado incluido (primeras 10 filas buscan el encabezado). */
  sheet: unknown[][];
  /** campo → encabezado de la hoja. */
  mapping: Record<string, string>;
  keyFields: string[];
  /** Los valores que la fila tiene hoy en la tabla. */
  rowValues: Record<string, unknown>;
  /** campo → valor nuevo. */
  changes: Record<string, string | number>;
}): SheetWritePlan {
  const { sheet, mapping, keyFields, rowValues, changes } = input;
  const needed = [...new Set([...keyFields, ...Object.keys(changes)])];
  const headers = needed.map((f) => mapping[f]);
  if (headers.some((h) => !h))
    return { ok: false, error: 'Falta la columna de la hoja de algún campo.' };
  // El encabezado: la primera fila (de las 10 primeras) que trae todos los nombres.
  let headerAt = -1;
  for (let i = 0; i < Math.min(sheet.length, 10); i++) {
    const cells = (sheet[i] ?? []).map(norm);
    if (headers.every((h) => cells.includes(norm(h)))) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0)
    return {
      ok: false,
      error:
        'La hoja cambió: ya no encuentro las columnas de esta tabla. Actualiza la tabla y reintenta.',
    };
  const headerRow = (sheet[headerAt] ?? []).map(norm);
  const colOf = (field: string) => headerRow.indexOf(norm(mapping[field]));
  const matches: number[] = [];
  for (let i = headerAt + 1; i < sheet.length; i++) {
    const row = sheet[i] ?? [];
    if (keyFields.every((k) => norm(row[colOf(k)]) === norm(rowValues[k]))) matches.push(i);
  }
  if (!matches.length)
    return {
      ok: false,
      error: 'No encontré esa fila en la hoja (¿cambió o se borró?). No escribí nada.',
    };
  if (matches.length > 1)
    return {
      ok: false,
      error: `Hay ${matches.length} filas iguales en la hoja para esa clave: no sé cuál cambiar. No escribí nada.`,
    };
  const at = matches[0] as number;
  return {
    ok: true,
    rowNumber: at + 1,
    cells: Object.entries(changes).map(([field, value]) => ({
      a1: `${columnLetter(colOf(field))}${at + 1}`,
      header: mapping[field] as string,
      value,
    })),
  };
}
