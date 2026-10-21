import { z } from 'zod';
import {
  DAY_RE,
  cleanText,
  formatClock,
  formatDay,
  formatMoney,
  formatNumber,
} from '../format/display';
import { computedProblems } from './computed';
import { flowProblems, flowSchema, normalizeFlow } from './flow';
import {
  FIELD_FORMATS,
  PATTERN_MAX,
  compilePattern,
  isSafePattern,
  normalizeFormatted,
} from './formats';
import { FORMULA_MAX } from './formula';

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

/**
 * Quita las opciones que no aplican al tipo del campo antes de validar/guardar.
 * Visto en producción (2026-10-08): el modelo puso `accept` en un campo de
 * texto y trackers.define rechazó la tabla «Vuelos» entera. Una opción de otro
 * tipo no cambia lo pedido; un error real (lista sin opciones, fecha mal
 * escrita, patrón peligroso) sí se sigue rechazando.
 */
export function normalizeFieldInput<T>(raw: T): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const f = { ...(raw as Record<string, unknown>) };
  const del = (key: string) => {
    delete f[key];
  };
  // Nombres que el modelo usa para los campos de captura: se guardan como un
  // archivo-firma y un texto con lector de códigos (sin tipo nuevo en la base).
  const alias = typeof f.type === 'string' ? f.type.trim().toLowerCase() : '';
  if (alias === 'signature' || alias === 'firma') {
    f.type = 'file';
    f.accept = 'signature';
  } else if (['barcode', 'qr', 'codigo', 'código', 'scan'].includes(alias)) {
    f.type = 'text';
    f.scan = true;
  }
  // «Porcentaje» y «fórmula» no son tipos nuevos: son un número que se muestra
  // como porcentaje y un campo que se calcula. El modelo los pide por su nombre.
  if (alias === 'percent' || alias === 'porcentaje' || alias === 'percentage') {
    f.type = 'number';
    f.percent = true;
  } else if (['formula', 'fórmula', 'calculated', 'calculado', 'computed'].includes(alias)) {
    const asked = typeof f.resultType === 'string' ? f.resultType.trim().toLowerCase() : 'number';
    if (['percent', 'porcentaje', 'percentage'].includes(asked)) {
      f.type = 'number';
      f.percent = true;
    } else
      f.type = asked === 'boolean' || asked === 'bool' || asked === 'sino' ? 'checkbox' : asked;
  }
  del('resultType');
  if (typeof f.formula === 'string') {
    const clean = f.formula.trim().replace(/^=\s*/, '');
    if (clean) f.formula = clean;
    else del('formula');
  } else if (f.formula !== undefined) del('formula');
  // Un campo calculado nunca se pide ni se exige: lo pone la fórmula.
  if (f.formula) {
    f.required = false;
    del('default');
    del('unique');
    del('scan');
    del('scanMode');
    del('autofill');
    del('match');
  }
  const type = f.type;
  if (type !== 'number') del('percent');
  const textual = type === 'text' || type === 'longtext';
  const numeric = type === 'number' || type === 'money';
  const temporal = type === 'date' || type === 'time';
  const drop = (...keys: string[]) => {
    for (const k of keys) delete f[k];
  };
  if (type !== 'file') drop('accept', 'multiple', 'evidence', 'watermark');
  if (type === 'file' && f.accept === 'signature') drop('multiple', 'evidence', 'watermark');
  if (type !== 'select') drop('flow');
  if (type !== 'text' && type !== 'longtext') drop('scan');
  if (type !== 'text') drop('format');
  if (!f.scan || type !== 'longtext') drop('scanMode');
  if (type !== 'relation') drop('tracker');
  if (!textual) drop('pattern', 'minLength', 'maxLength');
  if (!numeric && !temporal) drop('min', 'max');
  if (numeric)
    for (const k of ['min', 'max'] as const) {
      const v = f[k];
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) f[k] = Number(v);
    }
  return f as T;
}

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
    accept: z.enum(['image', 'any', 'signature']).optional(),
    /** file (foto): guarda fecha, hora y GPS (si la persona lo permite) en el archivo. */
    evidence: z.boolean().optional(),
    /** file (foto): además los quema en la imagen (fecha, lugar, quién). */
    watermark: z.boolean().optional(),
    /** file: varios archivos (máx. 5). */
    multiple: z.boolean().optional(),
    /** relation: slug de la tabla relacionada. */
    tracker: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,47}$/)
      .optional(),
    /** text: se llena con el escáner de código de barras/QR. */
    scan: z.boolean().optional(),
    /** scan en un texto largo: «continuous» deja la cámara abierta y suma cada código en su línea. */
    scanMode: z.enum(['single', 'continuous']).optional(),
    /** select: el flujo por estados (ver `flow.ts`). */
    flow: flowSchema.optional(),
    // --- Campos que se llenan solos (ver `computed.ts` y `autofill-shape.ts`) ---
    /**
     * Campo calculado: una fórmula sobre otros campos de la misma fila, p. ej.
     * «[Kilos] × [Tarifa]». El tipo del campo es el del resultado. Se calcula al
     * guardar y no se edita a mano.
     */
    formula: z.string().trim().min(1).max(FORMULA_MAX).optional(),
    /** number: se muestra como porcentaje (0,153 → 15,3 %). Se guarda la razón. */
    percent: z.boolean().optional(),
    /**
     * Traer de otra tabla: `via` es un campo de relación de ESTA tabla y `field`
     * la clave del campo de la tabla relacionada. Se llena al elegir la relación;
     * con `editable` la persona puede cambiarlo después.
     */
    lookup: z
      .object({
        via: z.string().regex(FIELD_KEY_RE),
        field: z.string().regex(FIELD_KEY_RE),
        editable: z.boolean().optional(),
      })
      .optional(),
    /**
     * Cortex propone valores: al completarse los campos `from` (incluido este),
     * un turno corto de modelo, con herramientas de sólo lectura, sugiere los
     * campos `fills` siguiendo la `instruction`. Nunca pisa lo ya escrito.
     */
    autofill: z
      .object({
        instruction: z.string().trim().min(5).max(600),
        from: z.array(z.string().regex(FIELD_KEY_RE)).min(1).max(4),
        fills: z.array(z.string().regex(FIELD_KEY_RE)).min(1).max(8),
        /**
         * Con un `match` en el mismo campo: «no_match» (por omisión) = Cortex sólo
         * si la lista no encontró; «rest» = Cortex llena los destinos que la lista no llenó.
         */
        when: z.enum(['no_match', 'rest']).optional(),
      })
      .optional(),
    /**
     * Buscar en una lista, SIN IA (ver `match-shape.ts`): al llenarse el campo
     * `from`, se normaliza, se extrae la clave y se busca en `source` (una
     * lista de la plataforma `cortex.aerolineas` o una tabla del espacio) por la
     * columna `key`; si está, se llenan los campos de `fills` (destino → columna).
     */
    match: z
      .object({
        from: z.string().regex(FIELD_KEY_RE),
        extract: z
          .discriminatedUnion('mode', [
            z.object({ mode: z.literal('full') }),
            z.object({ mode: z.literal('prefix'), length: z.number().int().min(1).max(8) }),
            z.object({ mode: z.literal('regex'), pattern: z.string().min(1).max(PATTERN_MAX) }),
          ])
          .optional(),
        source: z.string().regex(/^(cortex\.)?[a-z][a-z0-9_]{1,47}$/),
        key: z.string().regex(FIELD_KEY_RE),
        fills: z
          .record(z.string().regex(FIELD_KEY_RE), z.string().regex(FIELD_KEY_RE))
          .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 8, {
            message: 'Entre 1 y 8 campos destino.',
          }),
      })
      .optional(),
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
    // Opciones de OTRO tipo (accept en un texto, format en un número…) no se
    // rechazan: normalizeFieldInput las quita al guardar.
    const textual = field.type === 'text' || field.type === 'longtext';
    if (field.pattern !== undefined) {
      if (textual && (!isSafePattern(field.pattern) || !compilePattern(field.pattern)))
        bad(
          'Ese patrón no es válido o es peligroso (largo máx. 200, sin cuantificadores anidados como (a+)+ ni referencias hacia atrás).',
          'pattern',
        );
    }
    if (field.showIf && field.showIf.field === field.key)
      bad('Un campo no puede depender de sí mismo.', 'showIf');
    if (field.match?.extract?.mode === 'regex') {
      const pattern = field.match.extract.pattern;
      if (!isSafePattern(pattern) || !compilePattern(pattern))
        bad('El patrón de «match» no es válido o es peligroso.', 'match');
    }
    if (field.percent && field.type !== 'number')
      bad('`percent` sólo va en un campo de tipo number.', 'percent');
  });

/** Un límite relativo o literal de fecha/hora bien escrito. */
export function isBound(type: 'date' | 'time', b: string): boolean {
  if (type === 'date') return /^(\d{4}-\d{2}-\d{2}|today([+-]\d{1,4})?)$/.test(b);
  return b === 'now' || TIME_RE.test(b);
}

export type TrackerField = z.infer<typeof trackerFieldSchema>;

export const trackerFieldsSchema = z
  .array(z.preprocess(normalizeFieldInput, trackerFieldSchema))
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
    // Flujo por estados: un solo campo con flujo, y coherente con las demás columnas.
    const flowFields = fields.filter((f) => f.flow);
    if (flowFields.length > 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Una tabla admite un solo campo con flujo.',
        path: [fields.indexOf(flowFields[1] as (typeof fields)[number]), 'flow'],
      });
    for (const f of flowFields)
      for (const message of flowProblems(
        f,
        normalizeFlow(f.flow as NonNullable<typeof f.flow>),
        fields,
      ))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message,
          path: [fields.indexOf(f), 'flow'],
        });
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
    // Campos que se llenan solos: fórmulas legibles, que apunten a campos que
    // existen y sin ciclos; lookups sobre una relación; autofill con destinos válidos.
    for (const p of computedProblems(fields)) {
      const at = fields.findIndex((f) => f.key === p.key);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: p.message,
        path: [at < 0 ? 0 : at, p.path],
      });
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

/**
 * Los campos que llegan en una redefinición: cada uno válido por sí solo, sin
 * mirar a los demás (los que no vienen se conservan; la coherencia de la
 * definición completa se valida sobre la fusión).
 */
export const trackerFieldsPartialSchema = z
  .array(z.preprocess(normalizeFieldInput, trackerFieldSchema))
  .min(1)
  .max(20);

export const trackerSlugSchema = z
  .string()
  .trim()
  .regex(
    TRACKER_SLUG_RE,
    'no es el slug de una tabla (minúsculas, números y guion bajo, p. ej. "tarifas_proveedores"). Un nombre con punto como «cortex.ventas» es una FUENTE de la plataforma, no una tabla: se lee como fuente de una vista, no con las herramientas de tablas. Mira trackers_list para ver las tablas.',
  );

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
  /** Evidencia de una foto (campo con `evidence`): cuándo y dónde se tomó. */
  takenAt?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
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
  const ref: FileValueRef = { url, name: name.trim(), mime, size: Math.round(n) };
  const takenAt = typeof o.takenAt === 'string' ? Date.parse(o.takenAt) : Number.NaN;
  if (Number.isFinite(takenAt)) ref.takenAt = new Date(takenAt).toISOString();
  const lat = Number(o.lat);
  const lng = Number(o.lng);
  if (o.lat != null && o.lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    ref.lat = Math.round(lat * 1e6) / 1e6;
    ref.lng = Math.round(lng * 1e6) / 1e6;
    const acc = Number(o.accuracy);
    if (o.accuracy != null && Number.isFinite(acc) && acc >= 0 && acc <= 100000)
      ref.accuracy = Math.round(acc);
  }
  return ref;
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
export function displayTrackerValue(
  field: Pick<TrackerField, 'type'> & { percent?: boolean },
  value: unknown,
): string {
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
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return cleanText(value);
      if (field.percent) return `${formatNumber(Math.round(n * 1e6) / 1e4, 2)} %`;
      return formatNumber(n, 6);
    }
    case 'money': {
      const n = Number(value);
      return Number.isFinite(n) ? formatMoney(n) : cleanText(value);
    }
    case 'date': {
      const s = String(value);
      return DAY_RE.test(s) ? formatDay(s) : cleanText(value);
    }
    case 'time':
      return formatClock(String(value));
    default:
      return cleanText(value);
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
      if (
        (field.accept === 'image' || field.accept === 'signature') &&
        files.some((f) => !f.mime.startsWith('image/'))
      ) {
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
  // Un texto que se llena solo con quien escribe («Responsable») no distingue
  // una fila de otra: se prefiere uno que la persona escriba; si no hay, el
  // nombre de la fila relacionada (el vuelo de la atención) y su primer dato de
  // opciones; y sólo al final ese texto automático.
  const textual = (f: TrackerField) => f.type === 'text' && !f.formula;
  const writtenByHand = (f: TrackerField) => textual(f) && f.default !== 'viewer';
  const preferred =
    fields.find((f) => writtenByHand(f) && f.required) ?? fields.find(writtenByHand);
  const textOf = (f: TrackerField | undefined) => {
    const value = f ? values[f.key] : undefined;
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
  };
  const byHand = textOf(preferred);
  if (byHand) return byHand;
  const parts: string[] = [];
  for (const f of fields) {
    if (f.type !== 'relation') continue;
    const raw = values[f.key];
    if (typeof raw !== 'string' || !raw.trim().startsWith('{')) continue;
    try {
      const label = (JSON.parse(raw) as { label?: unknown }).label;
      if (typeof label === 'string' && label.trim()) parts.push(label.trim());
    } catch {
      /* una relación mal guardada no tumba el nombre de la fila */
    }
    if (parts.length >= 1) break;
  }
  const choice = fields.find((f) => f.type === 'select' && !f.flow && textOf(f));
  if (parts.length && choice) parts.push(textOf(choice) as string);
  if (parts.length) return parts.join(' · ').slice(0, 200);
  const auto = textOf(fields.find((f) => textual(f)));
  if (auto) return auto;
  return 'Sin nombre';
}
