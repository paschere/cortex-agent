import { formatMoment, isDateFormat, parseMoment } from './time';

/**
 * LA URL DE UNA CONSULTA, CON LOS CAMPOS DE LA FILA.
 *
 *   https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}?aeropuerto={origen:upper}
 *
 * `{campo}` toma el valor de la fila; `{campo:formato}` lo da en otro formato:
 *   - fechas y horas (en hora de Bogotá): YYYY-MM-DD, YYYYMMDD, DD/MM/YYYY,
 *     YYYY-MM-DDTHH:mm, HH:mm…, y `iso` / `unix` / `unixms`;
 *   - texto: `upper`, `lower`, `digits` (sólo números) y `compact` (mayúsculas
 *     sin espacios, guiones ni puntos: «av 009» → «AV009»).
 * Además de los campos de la fila hay dos nombres fijos: `{hoy}` (el día de
 * Bogotá) y `{ahora}`, que sirven para consultas por lista («vuelos de hoy en
 * BOG») y se resuelven al momento de consultar.
 *
 * CADA VALOR VA CODIFICADO (encodeURIComponent): un vuelo «../admin» sigue
 * siendo un solo tramo del camino y «a&b=c» no abre un parámetro nuevo. El
 * servidor de la URL es literal —no admite campos— para que ninguna fila pueda
 * mandar la consulta (y la llave de la credencial) a otro dominio.
 *
 * Una fila a la que le falta un campo de la URL NO se consulta (no se
 * adivina un valor ni se gasta una consulta): devuelve cuáles faltan.
 */

const TOKEN = /\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::([^{}]*?))?\s*\}/g;
const BUILTIN = new Set(['hoy', 'ahora']);
const TEXT_FORMATS = ['upper', 'lower', 'digits', 'compact'];

export interface TemplateField {
  name: string;
  format: string | null;
}

/** Los campos que la URL pide, en orden de aparición y sin repetir. */
export function templateFields(template: string): TemplateField[] {
  const seen = new Set<string>();
  const out: TemplateField[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const name = m[1] ?? '';
    const format = m[2]?.trim() || null;
    const key = `${name}:${format ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, format });
  }
  return out;
}

const CREDENTIAL_PARAM =
  /(^|[_-])(token|secret|password|passwd|api_?key|apikey|authorization|key)($|[_-])/i;

/**
 * Lo que se puede revisar de una URL sin ver ninguna fila: https, servidor
 * literal, sin usuario:clave, sin llaves en la dirección y sin llaves sueltas.
 * Devuelve el motivo en español, o null si está bien.
 */
export function describeTemplateProblem(template: string): string | null {
  const text = template.trim();
  if (!/^https:\/\//i.test(text))
    return 'La dirección tiene que empezar con https:// (una consulta con llave no viaja sin cifrar).';
  if (/\{\{|\}\}/.test(text)) return 'Usa un solo par de llaves por campo: {vuelo}, no {{vuelo}}.';
  const rest = text.slice('https://'.length);
  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
  if (!host) return 'Falta el servidor en la dirección.';
  if (/[{}]/.test(host))
    return 'El servidor (lo que va antes de la primera «/») no puede llevar campos de la fila.';
  if (host.includes('@'))
    return 'La dirección no puede llevar usuario ni clave. La llave va en la credencial.';
  const stripped = text.replace(TOKEN, '');
  if (/[{}]/.test(stripped))
    return 'Hay una llave «{» o «}» sin cerrar. Cada campo se escribe {nombre} o {nombre:formato}.';
  for (const token of templateFields(text))
    if (
      token.format &&
      !isDateFormat(token.format) &&
      !TEXT_FORMATS.includes(token.format.toLowerCase())
    )
      return `No conozco el formato «${token.format}» de {${token.name}}. Fechas: YYYY-MM-DD, DD/MM/YYYY, HH:mm, iso, unix. Texto: upper, lower, digits, compact.`;
  const query = text.split('?')[1]?.split('#')[0] ?? '';
  for (const pair of query.split('&')) {
    const name = pair.split('=')[0] ?? '';
    if (name && CREDENTIAL_PARAM.test(decodeURIComponent(name.replace(/\{[^}]*\}/g, ''))))
      return `El parámetro «${name}» parece una llave. La llave va en la credencial, no en la dirección.`;
  }
  return null;
}

/** El servidor (con puerto) de una URL con campos, o null si no se puede leer. */
export function hostOfTemplate(template: string): string | null {
  const m = /^https?:\/\/([^/?#]+)/i.exec(template.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

function textFormat(value: string, format: string): string | null {
  switch (format.toLowerCase()) {
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'digits':
      return value.replace(/\D+/g, '') || null;
    case 'compact':
      return value.toUpperCase().replace(/[\s\-_.]+/g, '');
    default:
      return value;
  }
}

/** El valor de un campo con su formato, sin codificar; null si no se puede. */
export function valueForToken(
  field: TemplateField,
  values: Record<string, unknown>,
  nowMs: number,
): string | null {
  const own = values[field.name];
  const has = own !== undefined && own !== null && String(own).trim() !== '';
  const builtin = !has && BUILTIN.has(field.name);
  if (!has && !builtin) return null;
  if (field.format && isDateFormat(field.format)) {
    const ms = parseMoment(has ? own : nowMs);
    return ms === null ? null : formatMoment(ms, field.format);
  }
  if (builtin) return formatMoment(nowMs, field.name === 'hoy' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm');
  const text = String(own).trim();
  return field.format ? textFormat(text, field.format) : text;
}

export type RenderedUrl = { ok: true; url: string } | { ok: false; missing: string[] };

/**
 * La URL de una fila, o los campos que le faltan (o que no se pudieron leer con
 * el formato pedido: «fecha» que no es una fecha).
 */
export function renderLookupUrl(
  template: string,
  values: Record<string, unknown>,
  nowMs: number,
): RenderedUrl {
  const missing: string[] = [];
  const url = template.trim().replace(TOKEN, (_match, name: string, format?: string) => {
    const field = { name, format: format?.trim() || null };
    const value = valueForToken(field, values, nowMs);
    if (value === null || value === '') {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return encodeURIComponent(value);
  });
  return missing.length ? { ok: false, missing } : { ok: true, url };
}

/**
 * Los valores de texto de un objeto con `{hoy}` / `{ahora}` resueltos: para los
 * parámetros fijos de una fuente de lista («fecha = {hoy:YYYY-MM-DD}»), que se
 * leen una vez por corrida. Lo demás pasa igual.
 */
export function renderInputTokens(
  input: Record<string, unknown>,
  nowMs: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !/\{\s*(hoy|ahora)\b/.test(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value.replace(TOKEN, (match, name: string, format?: string) => {
      if (!BUILTIN.has(name)) return match;
      return valueForToken({ name, format: format?.trim() || null }, {}, nowMs) ?? match;
    });
  }
  return out;
}
