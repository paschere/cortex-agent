/**
 * LA «COMPUTADORA DE CORTEX»: LO QUE SE VE CUANDO EL PASO NO ES NAVEGAR.
 *
 * Una vista previa chica del resultado de una consulta (cuántas filas, una
 * tablita de las primeras) sacada de lo que la herramienta ya devolvió. Sin
 * dependencias: la importa un componente del navegador.
 */

export interface ResultPreview {
  count: number;
  headers: string[];
  rows: string[][];
}

const MAX_COLS = 4;
const MAX_ROWS = 4;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > 48 ? `${v.slice(0, 47)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function firstRecordArray(result: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(result)) {
    return result.length > 0 && result.every(isRecord)
      ? (result as Record<string, unknown>[])
      : null;
  }
  if (!isRecord(result)) return null;
  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith('__')) continue;
    if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
      return value as Record<string, unknown>[];
    }
  }
  return null;
}

/** `null` si el resultado no trae una lista de registros que valga la pena mostrar. */
export function previewOf(result: unknown): ResultPreview | null {
  if (isRecord(result) && ('__error' in result || result.__requires_confirmation === true))
    return null;
  const list = firstRecordArray(result);
  if (!list) return null;
  const first = list[0] ?? {};
  const headers = Object.keys(first)
    .filter((k) => !k.startsWith('__') && cell(first[k]) !== '')
    .slice(0, MAX_COLS);
  if (headers.length === 0) return null;
  return {
    count: list.length,
    headers,
    rows: list.slice(0, MAX_ROWS).map((r) => headers.map((h) => cell(r[h]))),
  };
}
