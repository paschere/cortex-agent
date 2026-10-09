/**
 * EL DETALLE QUE VIAJA EN LA FILA DE AUDITORÍA (`metadata.detail`).
 *
 * `audit_events` sólo guardaba el hash de la entrada: sirve para probar que una
 * llamada ocurrió, no para contarla. «Envié un correo a Ana» necesita saber a
 * quién, y deshacer una fila creada necesita saber cuál. Este módulo arma, para
 * las llamadas CON EFECTOS, una versión recortada y sin secretos de la entrada
 * y del resultado, más (si la herramienta lo declara) el estado de antes.
 *
 * Reglas, todas para que el rastro no se convierta en un segundo almacén de
 * datos sensibles:
 *   · claves que parecen secretos se tapan, sea cual sea su valor;
 *   · las cadenas largas se recortan (un correo no se guarda entero);
 *   · profundidad, ancho y tamaño total tienen tope;
 *   · `markdown` (el texto para el modelo) no se guarda.
 * El estado de ANTES es la excepción: se guarda entero o no se guarda, porque
 * restaurar un valor recortado sería corromper el dato.
 */

const SECRET_KEY =
  /pass(word|wd)?|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key|cvv|signature|bearer/i;

const MAX_STRING = 160;
const MAX_ITEMS = 5;
const MAX_DEPTH = 3;
const MAX_DETAIL_CHARS = 4_000;
const MAX_BEFORE_CHARS = 3_000;
const MAX_BEFORE_STRING = 500;
const OMIT_KEYS = new Set(['markdown', 'repeatConfirmedByUser']);

export const REDACTED = '[oculto]';

export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) return `${value.slice(0, MAX_STRING)}…`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => sanitizeForAudit(v, depth + 1));
    return value.length > MAX_ITEMS ? { items, total: value.length } : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (OMIT_KEYS.has(k)) continue;
      out[k] = SECRET_KEY.test(k) ? REDACTED : sanitizeForAudit(v, depth + 1);
    }
    return out;
  }
  return null;
}

/** El estado de antes, entero o nada: sólo escalares cortos, sin claves de secreto. */
export function captureBefore(
  values: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!values) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (SECRET_KEY.test(k)) return null;
    if (typeof v === 'string') {
      if (v.length > MAX_BEFORE_STRING) return null;
    } else if (typeof v !== 'number' && typeof v !== 'boolean') return null;
    out[k] = v;
  }
  return JSON.stringify(out).length <= MAX_BEFORE_CHARS ? out : null;
}

export interface AuditDetail {
  input: unknown;
  result: unknown;
  before?: Record<string, unknown>;
}

export function buildAuditDetail(opts: {
  input: unknown;
  output: unknown;
  before?: Record<string, unknown> | null;
}): AuditDetail | null {
  try {
    const detail: AuditDetail = {
      input: sanitizeForAudit(opts.input),
      result: sanitizeForAudit(opts.output),
      ...(opts.before ? { before: opts.before } : {}),
    };
    if (JSON.stringify(detail).length <= MAX_DETAIL_CHARS) return detail;
    // Demasiado grande: sólo lo escalar de primer nivel, y el estado de antes intacto.
    const flat = (v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).filter(
              ([, x]) => x === null || typeof x !== 'object',
            ),
          )
        : null;
    const slim: AuditDetail = {
      input: flat(detail.input),
      result: flat(detail.result),
      ...(opts.before ? { before: opts.before } : {}),
    };
    return JSON.stringify(slim).length <= MAX_DETAIL_CHARS ? slim : null;
  } catch {
    return null;
  }
}
