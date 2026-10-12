/**
 * EDITAR ANTES DE APROBAR.
 *
 * La tarjeta deja corregir los valores sencillos de lo que Cortex propone
 * (texto, número, sí/no) y manda el resultado a /api/chat/confirm como
 * `editedInput`. Dos reglas, las dos comprobadas TAMBIÉN en el servidor:
 *
 *   1. La FORMA no cambia: mismas llaves, mismos arreglos, mismos tipos. Sólo
 *      cambian valores de hoja. Editar no puede añadir un destinatario, un
 *      campo nuevo ni convertir un objeto en otra cosa.
 *   2. El resultado pasa el esquema de la herramienta (el servidor lo hace).
 *
 * Pura: la importan el navegador y la ruta.
 */

export type EditKind = 'text' | 'longtext' | 'number' | 'boolean';

export interface EditableField {
  /** Ruta dentro del input: ['subject'] o ['values', 'precio']. */
  path: string[];
  label: string;
  kind: EditKind;
  value: string | number | boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Campos que son fontanería: se ven en «lo que se va a enviar», no se editan. */
const NOT_EDITABLE = new Set([
  'repeatConfirmedByUser',
  'rowId',
  'tracker',
  'draftId',
  'id',
  'conversationId',
]);
const LONG = new Set(['body', 'message', 'text', 'notes', 'description', 'content', 'note']);

function humanKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MAX_FIELDS = 12;

/**
 * Los campos editables: primitivos de primer nivel y, un nivel más abajo, los
 * de un objeto plano (`values` de una fila). Vacío = la tarjeta no ofrece Editar.
 */
export function editableFields(input: unknown): EditableField[] {
  if (!isRecord(input)) return [];
  const out: EditableField[] = [];
  const push = (path: string[], v: unknown) => {
    const key = path[path.length - 1] ?? '';
    if (NOT_EDITABLE.has(key)) return;
    const label = humanKey(key);
    if (typeof v === 'string')
      out.push({
        path,
        label,
        kind: v.length > 80 || LONG.has(key) ? 'longtext' : 'text',
        value: v,
      });
    else if (typeof v === 'number' && Number.isFinite(v))
      out.push({ path, label, kind: 'number', value: v });
    else if (typeof v === 'boolean') out.push({ path, label, kind: 'boolean', value: v });
  };
  for (const [k, v] of Object.entries(input)) {
    if (isRecord(v)) {
      for (const [k2, v2] of Object.entries(v)) push([k, k2], v2);
    } else push([k], v);
  }
  return out.slice(0, MAX_FIELDS);
}

/** Aplica los cambios sobre una copia; el tipo de cada hoja se conserva. */
export function applyEdits(
  input: unknown,
  edits: ReadonlyArray<{ path: string[]; value: string | number | boolean }>,
): unknown {
  const copy = structuredClone(input);
  for (const { path, value } of edits) {
    let node: unknown = copy;
    for (const key of path.slice(0, -1)) node = isRecord(node) ? node[key] : undefined;
    const last = path[path.length - 1];
    if (!isRecord(node) || last === undefined || !(last in node)) continue;
    const original = node[last];
    if (typeof original === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      if (Number.isFinite(n)) node[last] = n;
    } else if (typeof original === 'boolean') node[last] = value === true || value === 'true';
    else node[last] = String(value);
  }
  return copy;
}

/** ¿La forma es idéntica y sólo difieren hojas del mismo tipo? */
export function sameShape(original: unknown, edited: unknown): boolean {
  if (Array.isArray(original)) {
    return (
      Array.isArray(edited) &&
      original.length === edited.length &&
      original.every((v, i) => sameShape(v, edited[i]))
    );
  }
  if (isRecord(original)) {
    if (!isRecord(edited)) return false;
    const a = Object.keys(original);
    const b = Object.keys(edited);
    return (
      a.length === b.length && a.every((k) => k in edited && sameShape(original[k], edited[k]))
    );
  }
  return typeof original === typeof edited;
}

/** Los cambios, para decirlos: «Asunto: A → B». */
export function describeEdits(original: unknown, edited: unknown): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (isRecord(a) && isRecord(b)) {
      for (const k of Object.keys(a)) walk(a[k], b[k], [...path, k]);
    } else if (!Array.isArray(a) && a !== b) {
      out.push(`${humanKey(path[path.length - 1] ?? '')}: ${String(a)} → ${String(b)}`);
    }
  };
  walk(original, edited, []);
  return out;
}
