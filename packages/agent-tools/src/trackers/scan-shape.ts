import {
  type AutofillFieldLike,
  type MergeResult,
  type Suggestion,
  mergeSuggestions,
  sanitizeSuggestion,
} from './autofill-shape';

/**
 * ESCANEAR UN DOCUMENTO PARA LLENAR UN FORMULARIO: lo que no necesita servidor.
 *
 * La persona fotografía una guía aérea, un manifiesto o una factura; el servidor
 * le pide a un modelo con visión que lea el papel y proponga valores para los
 * campos del formulario. Lo que vuelve son SUGERENCIAS, y se mezclan con el
 * MISMO `mergeSuggestions` del autofill: nunca pisan lo que la persona ya
 * escribió, y lo que viene del escaneo queda marcado hasta que lo toca.
 *
 * Este módulo es puro (lo usan el servidor, el navegador y las pruebas).
 */

/** Los tipos que se pueden leer de un papel: lo demás (fotos, ubicación, relación) se elige a mano. */
const READABLE = new Set(['text', 'longtext', 'number', 'money', 'date', 'time', 'select', 'checkbox']);

/** Campos del formulario que el escaneo puede llenar: nada calculado ni traído de otra tabla. */
export function scannableFields<T extends AutofillFieldLike>(fields: readonly T[]): T[] {
  return fields.filter(
    (f) => READABLE.has(f.type) && !f.formula && !(f.lookup && !f.lookup.editable),
  );
}

/** Lo que entrega el modelo: un valor (o null) por campo, con la clave del campo. */
export type ScanDelivered = Record<string, string | number | boolean | null | undefined>;

/** Limpia lo que entregó el modelo: sólo claves conocidas, cada valor en la forma que acepta el campo. */
export function shapeScan<T extends AutofillFieldLike>(
  fields: readonly T[],
  delivered: ScanDelivered | null | undefined,
  source = 'documento',
): Record<string, Suggestion> {
  const out: Record<string, Suggestion> = {};
  if (!delivered) return out;
  for (const f of scannableFields(fields)) {
    const raw = delivered[f.key];
    if (raw === null || raw === undefined) continue;
    const text = typeof raw === 'boolean' ? (raw ? 'sí' : 'no') : String(raw);
    const clean = sanitizeSuggestion(f, text);
    if (clean) out[f.key] = { value: clean, source };
  }
  return out;
}

/**
 * Mezcla un escaneo con lo que hay en el formulario. `previous` es lo que un
 * escaneo anterior puso y la persona no tocó: se puede reemplazar por el del
 * escaneo nuevo; lo escrito a mano, jamás.
 */
export function mergeScan<T extends AutofillFieldLike>(
  fields: readonly T[],
  current: Record<string, string>,
  suggestions: Record<string, Suggestion>,
  previous: Record<string, string> = {},
): MergeResult {
  const fills = scannableFields(fields)
    .map((f) => f.key)
    .filter((k) => suggestions[k]);
  return mergeSuggestions(fields, { fills }, current, suggestions, previous);
}

/** Resumen en español de lo que pasó, para decírselo a la persona. */
export function scanMessage(merge: MergeResult, readable: number): string {
  const put = Object.keys(merge.applied).length;
  const kept = merge.skipped.filter((s) => s.reason === 'escrito').length;
  if (put === 0 && readable === 0)
    return 'No pude leer datos en esa foto. Prueba con más luz y el documento completo, o llena a mano.';
  if (put === 0)
    return kept
      ? 'Ya habías escrito esos campos: no los cambié.'
      : 'Lo que leí no encaja en este formulario. Llena a mano.';
  const base = put === 1 ? 'Cortex llenó 1 campo' : `Cortex llenó ${put} campos`;
  return kept
    ? `${base} y dejó los ${kept} que ya escribiste. Revisa lo sugerido.`
    : `${base} con lo que leyó. Revisa lo sugerido antes de enviar.`;
}
