/**
 * FILAS LEÍDAS DE UN DOCUMENTO: un manifiesto trae el vuelo y, además, una lista de guías.
 *
 * Un formulario con `documentRows` pide al escaneo también esa lista. La persona la revisa
 * en el formulario y al enviar cada fila se guarda en una tabla hija, relacionada con la
 * fila que el formulario crea. Es el motor general: sirve para cualquier documento con
 * renglones (una factura y sus ítems), no hay nada a la medida de un negocio.
 *
 * A diferencia de las líneas (`form-lines.ts`), que eligen un ítem que ya existe y le ponen
 * cantidad, aquí cada renglón trae sus propios campos. Esta pieza es pura.
 */

export const DOC_ROWS_KEY = '__docrows';
/** Tope de filas por envío: un manifiesto largo, sin dejar que un documento llene una tabla. */
export const MAX_DOC_ROWS = 100;
const MAX_VALUE_CHARS = 500;

export type DocRow = Record<string, string>;

/** El JSON de las filas tal como viaja en `values.__docrows`; null si no se entiende. */
export function parseDocRows(raw: unknown): DocRow[] | null {
  if (raw === undefined || raw === null || raw === '') return [];
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(data)) return null;
  const out: DocRow[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const row: DocRow = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const text = String(v).trim().slice(0, MAX_VALUE_CHARS);
      if (text) row[k] = text;
    }
    out.push(row);
  }
  return out;
}

/**
 * Deja sólo los campos configurados, quita los renglones sin `key` y junta los repetidos
 * (la misma guía en dos páginas del manifiesto): gana lo primero, lo nuevo sólo llena huecos.
 */
export function normalizeDocRows(rows: DocRow[], cfg: { key: string; fields: string[] }): DocRow[] {
  const byKey = new Map<string, DocRow>();
  for (const row of rows) {
    const id = (row[cfg.key] ?? '').trim().toLowerCase();
    if (!id) continue;
    const clean: DocRow = {};
    for (const f of cfg.fields) if (row[f]) clean[f] = row[f];
    const seen = byKey.get(id);
    if (seen) for (const [k, v] of Object.entries(clean)) seen[k] ??= v;
    else byKey.set(id, clean);
  }
  return [...byKey.values()];
}
