import { dateIso, parseDateText, parseLooseNumber, parseTimeText } from './formula';

/**
 * AUTOFILL POR CORTEX: lo que no necesita servidor.
 *
 * Un campo con `autofill` {instruction, from, fills} le pide a Cortex que, al
 * completarse los campos disparadores (`from`), proponga valores para los campos
 * destino (`fills`). El navegador manda los disparadores a un endpoint que corre
 * un turno corto de modelo con herramientas de sólo lectura; lo que vuelve son
 * SUGERENCIAS. Este módulo decide qué se hace con ellas, y es puro (lo corre el
 * navegador y las pruebas) porque la regla importante vive aquí:
 *
 *     una sugerencia NUNCA pisa lo que la persona ya escribió.
 *
 * Lo único que se vuelve a llenar es lo que Cortex mismo había sugerido antes y
 * la persona no tocó (cambió el vuelo → se actualiza la aerolínea que Cortex
 * había puesto, pero no la que ella corrigió a mano).
 */

export interface AutofillConfig {
  instruction: string;
  from: string[];
  fills: string[];
}

export interface AutofillFieldLike {
  key: string;
  label: string;
  type: string;
  options?: string[];
  formula?: string;
  lookup?: { via: string; field: string; editable?: boolean };
  autofill?: AutofillConfig;
}

export interface Suggestion {
  value: string;
  /** De dónde salió (una URL o el nombre de una tabla); puede faltar. */
  source?: string;
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Los campos que tienen autofill. */
export function autofillConfigs<T extends AutofillFieldLike>(
  fields: readonly T[],
): Array<{ field: T; config: AutofillConfig }> {
  return fields.flatMap((field) => (field.autofill ? [{ field, config: field.autofill }] : []));
}

/** ¿Ya están llenos todos los disparadores? Sólo entonces se le pregunta a Cortex. */
export function autofillReady(
  config: Pick<AutofillConfig, 'from'>,
  values: Record<string, unknown>,
): boolean {
  return config.from.length > 0 && config.from.every((k) => !blank(values[k]));
}

/** La huella de los disparadores: el mismo vuelo escrito igual = la misma pregunta (para la caché). */
export function triggerSignature(
  config: Pick<AutofillConfig, 'from'>,
  values: Record<string, unknown>,
): string {
  return config.from
    .map((k) => `${k}=${fold(String(values[k] ?? '')).replace(/\s+/g, ' ')}`)
    .join('|');
}

/** Una sugerencia, en la forma que acepta el campo; null si no sirve. */
export function sanitizeSuggestion(field: AutofillFieldLike, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  switch (field.type) {
    case 'number':
    case 'money': {
      const n = parseLooseNumber(text);
      return n !== null && Number.isFinite(n) ? String(n) : null;
    }
    case 'date': {
      const d = parseDateText(text);
      return d ? dateIso(d) : null;
    }
    case 'time': {
      const m = /^(\d{1,2}):(\d{2})/.exec(text);
      if (!m) return null;
      const t = parseTimeText(`${m[1]}:${m[2]}`);
      return t
        ? `${String(Math.floor(t.min / 60)).padStart(2, '0')}:${String(t.min % 60).padStart(2, '0')}`
        : null;
    }
    case 'checkbox': {
      const t = fold(text);
      if (['si', 'true', 'verdadero', '1'].includes(t)) return '1';
      if (['no', 'false', 'falso', '0'].includes(t)) return '0';
      return null;
    }
    case 'select':
      return field.options?.find((o) => fold(o) === fold(text)) ?? null;
    case 'file':
    case 'relation':
    case 'location':
      return null;
    case 'longtext':
      return text.slice(0, 4000);
    default:
      return text.slice(0, 400);
  }
}

export interface MergeResult {
  /** Lo que se pone en el formulario (clave → valor). */
  applied: Record<string, string>;
  /** De dónde salió cada valor puesto. */
  sources: Record<string, string>;
  /** Lo que no se puso y por qué. */
  skipped: Array<{ key: string; reason: 'escrito' | 'invalido' | 'vacio' | 'no_aplica' }>;
}

/**
 * Mezcla las sugerencias con lo que hay en el formulario.
 *   - Sólo campos de `config.fills`, que existan y no estén calculados.
 *   - Un campo con algo escrito NO se toca… salvo que lo escrito sea exactamente
 *     lo que Cortex sugirió antes (`previous`): la persona no lo cambió.
 *   - Cada valor pasa por `sanitizeSuggestion` (tipo, opciones del select).
 */
export function mergeSuggestions(
  fields: readonly AutofillFieldLike[],
  config: Pick<AutofillConfig, 'fills'>,
  current: Record<string, string>,
  suggestions: Record<string, Suggestion | string | null | undefined>,
  previous: Record<string, string> = {},
): MergeResult {
  const applied: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const skipped: MergeResult['skipped'] = [];
  for (const key of config.fills) {
    const field = fields.find((f) => f.key === key);
    if (!field || field.formula || (field.lookup && !field.lookup.editable)) {
      skipped.push({ key, reason: 'no_aplica' });
      continue;
    }
    const sug = suggestions[key];
    const rawValue = typeof sug === 'string' ? sug : sug?.value;
    if (blank(rawValue)) {
      skipped.push({ key, reason: 'vacio' });
      continue;
    }
    const have = current[key];
    if (!blank(have) && have !== previous[key]) {
      skipped.push({ key, reason: 'escrito' });
      continue;
    }
    const clean = sanitizeSuggestion(field, rawValue);
    if (clean === null) {
      skipped.push({ key, reason: 'invalido' });
      continue;
    }
    applied[key] = clean;
    const source = typeof sug === 'object' && sug ? sug.source : undefined;
    if (source) sources[key] = source;
  }
  return { applied, sources, skipped };
}
