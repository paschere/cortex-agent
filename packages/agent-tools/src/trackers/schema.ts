import { z } from 'zod';
import {
  FIELD_FORMATS,
  PATTERN_MAX,
  compilePattern,
  isSafePattern,
  normalizeFormatted,
} from './formats';

/**
 * El esquema de una tabla inventada, y por qué se valida aquí y no en Postgres.
 *
 * El CHECK de la 0115 sólo exige que `fields` sea un array. La forma de cada
 * campo —clave, tipo, opciones de un select— vive aquí porque añadir un tipo
 * mañana es una constante más, no una migración más un despliegue más. El
 * agente escribe este JSON; si se deja pasar un campo sin clave, las filas
 * posteriores no se pueden consultar por nombre.
 */

export const TRACKER_SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * `longtext` es texto con varias líneas (observaciones); `checkbox` es sí/no y
 * se guarda como 1/0 —un número— para que los valores de fila sigan siendo
 * `string | number` en todo el repo (compute, grilla, feed); `time` es una hora
 * del día «HH:MM» (24 h), sin fecha ni zona.
 *
 * Tres tipos guardan estructura en una cadena (los valores de fila son siempre
 * `string | number`):
 *   - `file`: JSON de `{url, name, mime, size}`, o un arreglo de ellos si el
 *     campo es `multiple` (máx. 5). `url` es `https://…` o una ruta que empieza
 *     por `/`. Se acepta también el objeto/arreglo ya armado y se guarda como cadena.
 *   - `location`: «lat,lng» con 6 decimales, p. ej. «4.710989,-74.072092».
 *   - `relation`: JSON de `{id, label}`: el id de la fila de la tabla
 *     relacionada y su nombre al momento de guardar, para mostrarlo sin otra consulta.
 * `displayTrackerValue` los vuelve texto legible.
 */
export const FIELD_TYPES = [
  'text',
  'longtext',
  'number',
  'date',
  'time',
  'money',
  'select',
  'checkbox',
  'file',
  'location',
  'relation',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Largo máximo de un texto corto y de uno largo. */
export const TEXT_MAX = 400;
export const LONGTEXT_MAX = 4000;

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const YES = new Set(['1', 'true', 'si', 'sí', 'yes', 'x', 'on']);
const NO = new Set(['0', 'false', 'no', 'off']);

/** «sí»/«no» y sus variantes → 1/0; null si no se entiende. */
export function parseCheckbox(raw: unknown): 0 | 1 | null {
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number') return raw === 1 ? 1 : raw === 0 ? 0 : null;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (YES.has(t)) return 1;
    if (NO.has(t)) return 0;
  }
  return null;
}

/** Un límite de número, o de fecha/hora (que además admite «today»/«now» relativos). */
const boundSchema = z.union([z.number().finite(), z.string().trim().min(1).max(30)]);

/**
 * Condición para que un campo se muestre: depende de OTRO campo de la tabla.
 * Oculto = no se pide en el formulario y el servidor ni lo exige ni lo guarda.
 */
export const showIfSchema = z
  .object({
    field: z.string().regex(FIELD_KEY_RE),
    equals: z.union([z.string().max(80), z.array(z.string().max(80)).min(1).max(30)]).optional(),
    notEmpty: z.boolean().optional(),
  })
  .refine((c) => c.equals !== undefined || c.notEmpty !== undefined, {
    message: 'showIf necesita `equals` o `notEmpty`.',
  });
export type ShowIf = z.infer<typeof showIfSchema>;

/** Los valores fijos que `default` entiende además de un texto o número. */
export const DEFAULT_KEYWORDS = ['today', 'now', 'viewer'] as const;

export const trackerFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_RE),
    label: z.string().trim().min(1).max(60),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    // --- Validaciones (todas opcionales: una tabla vieja no las trae) ---
    /** Número/dinero: valor mínimo. Fecha/hora: «YYYY-MM-DD»/«HH:MM», «today», «today-30», «now». */
    min: boundSchema.optional(),
    /** Igual que `min`, como tope. Fecha con max «today» = no futura. */
    max: boundSchema.optional(),
    minLength: z.number().int().min(0).max(LONGTEXT_MAX).optional(),
    maxLength: z.number().int().min(1).max(LONGTEXT_MAX).optional(),
    /** Preset de formato para texto: email, phone, nit, plate, awb, digits. */
    format: z.enum(FIELD_FORMATS).optional(),
    /** Regex propio (≤200, sin cuantificadores anidados ni referencias hacia atrás). */
    pattern: z.string().max(PATTERN_MAX).optional(),
    /** Bloquea el envío si ya hay una fila con este valor (normalizado). */
    unique: z.boolean().optional(),
    /** Texto de error propio que reemplaza al de la regla que falle. */
    message: z.string().trim().min(1).max(200).optional(),
    // --- Ayuda para quien llena ---
    /** «today», «now», «viewer» (nombre de quien llena) o un valor fijo. */
    default: z.union([z.string().max(400), z.number().finite()]).optional(),
    help: z.string().trim().min(1).max(200).optional(),
    placeholder: z.string().trim().min(1).max(80).optional(),
    example: z.string().trim().min(1).max(80).optional(),
    showIf: showIfSchema.optional(),
    // --- Opciones de los tipos nuevos ---
    /** file: qué se acepta. */
    accept: z.enum(['image', 'any']).optional(),
    /** file: varios archivos (máx. 5). */
    multiple: z.boolean().optional(),
    /** relation: slug de la tabla relacionada. */
    tracker: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,47}$/)
      .optional(),
    /** text: se llena con el escáner de código de barras/QR. */
    scan: z.boolean().optional(),
  })
  .superRefine((field, ctx) => {
    const bad = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    if (field.type === 'select' && (!field.options || field.options.length < 1)) {
      bad('Un campo de opciones necesita al menos una.', 'options');
    }
    if (field.type === 'relation' && !field.tracker) {
      bad('Un campo de relación necesita `tracker` (el slug de la otra tabla).', 'tracker');
    }
    const numeric = field.type === 'number' || field.type === 'money';
    const temporal = field.type === 'date' || field.type === 'time';
    for (const k of ['min', 'max'] as const) {
      const b = field[k];
      if (b === undefined) continue;
      if (numeric && typeof b !== 'number') bad(`«${k}» de un número tiene que ser un número.`, k);
      else if (temporal && typeof b !== 'string') bad(`«${k}» de una fecha u hora es texto.`, k);
      else if (!numeric && !temporal) bad(`«${k}» sólo aplica a número, dinero, fecha y hora.`, k);
      else if (temporal && typeof b === 'string' && !isBound(field.type as 'date' | 'time', b))
        bad(
          field.type === 'date'
            ? `«${k}» de una fecha es YYYY-MM-DD, «today» o «today+N»/«today-N».`
            : `«${k}» de una hora es HH:MM o «now».`,
          k,
        );
    }
    if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max)
      bad('«min» no puede ser mayor que «max».', 'min');
    if (
      field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength
    )
      bad('«minLength» no puede ser mayor que «maxLength».', 'minLength');
    const textual = field.type === 'text' || field.type === 'longtext';
    if ((field.minLength !== undefined || field.maxLength !== undefined) && !textual)
      bad('«minLength»/«maxLength» sólo aplican a texto.', 'minLength');
    if (field.format !== undefined && field.type !== 'text')
      bad('«format» sólo aplica a un campo de texto corto.', 'format');
    if (field.pattern !== undefined) {
      if (!textual) bad('«pattern» sólo aplica a texto.', 'pattern');
      else if (!isSafePattern(field.pattern) || !compilePattern(field.pattern))
        bad(
          'Ese patrón no es válido o es peligroso (largo máx. 200, sin cuantificadores anidados como (a+)+ ni referencias hacia atrás).',
          'pattern',
        );
    }
    if (field.scan && field.type !== 'text') bad('«scan» sólo aplica a un campo de texto.', 'scan');
    if ((field.accept !== undefined || field.multiple !== undefined) && field.type !== 'file')
      bad('«accept» y «multiple» sólo aplican a un campo de archivo.', 'accept');
    if (field.tracker !== undefined && field.type !== 'relation')
      bad('«tracker» sólo aplica a un campo de relación.', 'tracker');
    if (field.showIf && field.showIf.field === field.key)
      bad('Un campo no puede depender de sí mismo.', 'showIf');
  });

/** Un límite relativo o literal de fecha/hora bien escrito. */
export function isBound(type: 'date' | 'time', b: string): boolean {
  if (type === 'date') return /^(\d{4}-\d{2}-\d{2}|today([+-]\d{1,4})?)$/.test(b);
  return b === 'now' || TIME_RE.test(b);
}

export type TrackerField = z.infer<typeof trackerFieldSchema>;

export const trackerFieldsSchema = z
  .array(trackerFieldSchema)
  .min(1)
  .max(20)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const [i, field] of fields.entries()) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `La clave «${field.key}» está repetida.`,
          path: [i, 'key'],
        });
      }
      seen.add(field.key);
    }
    // showIf: apunta a un campo que existe y no forma ciclos (a→b→a), porque un
    // ciclo dejaría los dos ocultos para siempre.
    const dep = new Map<string, string>();
    for (const [i, field] of fields.entries()) {
      const target = field.showIf?.field;
      if (!target) continue;
      if (!seen.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `showIf de «${field.key}» depende de «${target}», que no existe.`,
          path: [i, 'showIf'],
        });
        continue;
      }
      dep.set(field.key, target);
    }
    for (const [i, field] of fields.entries()) {
      const chain = new Set<string>([field.key]);
      let next = dep.get(field.key);
      while (next) {
        if (chain.has(next)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `showIf de «${field.key}» forma un ciclo con «${next}».`,
            path: [i, 'showIf'],
          });
          break;
        }
        chain.add(next);
        next = dep.get(next);
      }
    }
  });

export const trackerSlugSchema = z.string().trim().regex(TRACKER_SLUG_RE);

export function fieldByKey(fields: TrackerField[], key: string): TrackerField | undefined {
  return fields.find((f) => f.key === key);
}

// ---------------------------------------------------------------------------
// Valores estructurados: ubicación, archivo, relación
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** «4.7109,-74.0721» (o un objeto {lat,lng}) → punto; null si no es una coordenada. */
export function parseLocation(raw: unknown): GeoPoint | null {
  let lat: number;
  let lng: number;
  if (typeof raw === 'string') {
    const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(raw);
    if (!m) return null;
    lat = Number(m[1]);
    lng = Number(m[2]);
  } else if (raw && typeof raw === 'object') {
    lat = Number((raw as { lat?: unknown }).lat);
    lng = Number((raw as { lng?: unknown }).lng);
  } else return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Siempre «lat,lng» con 6 decimales (≈ 11 cm): mismo punto, misma cadena. */
export function formatLocation(p: GeoPoint): string {
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

/** Enlace a Google Maps de una ubicación guardada; null si el valor no es una. */
export function mapsUrl(value: unknown): string | null {
  const p = parseLocation(value);
  return p ? `https://www.google.com/maps?q=${formatLocation(p)}` : null;
}

export interface FileValueRef {
  url: string;
  name: string;
  mime: string;
  size: number;
}

export const FILE_MAX_COUNT = 5;
export const FILE_VALUE_MAX = 3800;

function asFileRef(x: unknown): FileValueRef | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const { url, name, mime, size } = o;
  if (typeof url !== 'string' || !/^(https:\/\/|\/(?!\/))/.test(url) || url.length > 1000)
    return null;
  if (typeof name !== 'string' || !name.trim() || name.length > 200) return null;
  if (typeof mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) return null;
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return null;
  return { url, name: name.trim(), mime, size: Math.round(n) };
}

/** Lo guardado (cadena JSON) o armado (objeto/arreglo) → archivos; null si algo no cuadra. */
export function parseFileValue(raw: unknown): FileValueRef[] | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const list = Array.isArray(data) ? data : [data];
  const files: FileValueRef[] = [];
  for (const item of list) {
    const f = asFileRef(item);
    if (!f) return null;
    files.push(f);
  }
  return files;
}

export interface RelationRef {
  id: string;
  label: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un id suelto, un {id,label} o su JSON → referencia; la etiqueta puede venir vacía. */
export function parseRelationValue(raw: unknown): RelationRef | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (UUID_RE.test(t)) return { id: t.toLowerCase(), label: '' };
    try {
      data = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const { id, label } = data as { id?: unknown; label?: unknown };
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return { id: id.toLowerCase(), label: typeof label === 'string' ? label.slice(0, 200) : '' };
}

/** El valor de una celda como texto legible (para lectura, exportación y chat). */
export function displayTrackerValue(field: Pick<TrackerField, 'type'>, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  switch (field.type) {
    case 'file': {
      const files = parseFileValue(value);
      return files ? files.map((f) => f.name).join(', ') : String(value);
    }
    case 'relation': {
      const rel = parseRelationValue(value);
      return rel ? rel.label || rel.id.slice(0, 8) : String(value);
    }
    case 'checkbox':
      return Number(value) === 1 ? 'Sí' : 'No';
    default:
      return String(value);
  }
}

/**
 * Convierte lo que el modelo mandó en un valor que este campo acepta.
 * Devuelve el valor listo para JSON, o un mensaje de error en español.
 */
export function coerceValue(
  field: TrackerField,
  raw: unknown,
): { ok: true; value: string | number } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') {
    if (field.required) return { ok: false, message: `Falta «${field.label}».` };
    return { ok: true, value: '' };
  }

  switch (field.type) {
    case 'text':
    case 'longtext':
    case 'date':
    case 'time': {
      if (typeof raw !== 'string') {
        return { ok: false, message: `«${field.label}» tiene que ser texto.` };
      }
      const value = raw.trim();
      if (value.length > (field.type === 'longtext' ? LONGTEXT_MAX : TEXT_MAX)) {
        return { ok: false, message: `«${field.label}» es demasiado largo.` };
      }
      if (field.type === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, message: `«${field.label}» tiene que ser una fecha YYYY-MM-DD.` };
      }
      if (field.type === 'time' && value) {
        const m = TIME_RE.exec(value);
        if (!m) return { ok: false, message: `«${field.label}» tiene que ser una hora HH:MM.` };
        return { ok: true, value: `${m[1]?.padStart(2, '0')}:${m[2]}` };
      }
      if (field.type === 'text' && field.format) {
        return { ok: true, value: normalizeFormatted(field.format, value) };
      }
      return { ok: true, value };
    }
    case 'location': {
      const loc = parseLocation(raw);
      if (!loc) {
        return {
          ok: false,
          message: `«${field.label}» tiene que ser una ubicación «lat,lng» (ej. 4.710989,-74.072092).`,
        };
      }
      return { ok: true, value: formatLocation(loc) };
    }
    case 'file': {
      const files = parseFileValue(raw);
      if (!files || files.length === 0) {
        return {
          ok: false,
          message: `«${field.label}» tiene que ser un archivo subido (url, nombre, tipo y tamaño).`,
        };
      }
      if (!field.multiple && files.length > 1) {
        return { ok: false, message: `«${field.label}» recibe un solo archivo.` };
      }
      if (files.length > FILE_MAX_COUNT) {
        return { ok: false, message: `«${field.label}» admite hasta ${FILE_MAX_COUNT} archivos.` };
      }
      if (field.accept === 'image' && files.some((f) => !f.mime.startsWith('image/'))) {
        return { ok: false, message: `«${field.label}» solo acepta imágenes.` };
      }
      const json = JSON.stringify(field.multiple ? files : files[0]);
      if (json.length > FILE_VALUE_MAX) {
        return { ok: false, message: `«${field.label}» trae demasiada información de archivos.` };
      }
      return { ok: true, value: json };
    }
    case 'relation': {
      const rel = parseRelationValue(raw);
      if (!rel) {
        return {
          ok: false,
          message: `«${field.label}» tiene que ser el id de una fila de «${field.tracker}».`,
        };
      }
      return { ok: true, value: JSON.stringify(rel) };
    }
    case 'checkbox': {
      const flag = parseCheckbox(raw);
      if (flag === null) {
        return { ok: false, message: `«${field.label}» tiene que ser sí o no.` };
      }
      return { ok: true, value: flag };
    }
    case 'number':
    case 'money': {
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string'
            ? Number(raw.replace(',', '.'))
            : Number.NaN;
      if (!Number.isFinite(n)) {
        return { ok: false, message: `«${field.label}» tiene que ser un número.` };
      }
      return { ok: true, value: n };
    }
    case 'select': {
      const value = String(raw).trim();
      if (!field.options?.includes(value)) {
        return {
          ok: false,
          message: `«${field.label}» tiene que ser una de: ${field.options?.join(', ')}.`,
        };
      }
      return { ok: true, value };
    }
  }
}

/** Cómo se nombra una fila en voz alta: el primer texto, o lo que manden. */
export function rowLabel(
  fields: TrackerField[],
  values: Record<string, string | number>,
  explicit?: string,
): string {
  const named = explicit?.trim();
  if (named) return named.slice(0, 200);
  const preferred =
    fields.find((f) => f.type === 'text' && f.required) ?? fields.find((f) => f.type === 'text');
  if (preferred) {
    const value = values[preferred.key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  return 'Sin nombre';
}
