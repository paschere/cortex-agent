import { MAX_SELECT_OPTIONS, MAX_TRACKER_FIELDS, fieldKeyFrom } from '@/lib/datagrid/trackers';
import {
  FIELD_FORMATS,
  type FieldFormat,
  PATTERN_INPUT_MAX,
  compilePattern,
  isSafePattern,
  testPattern,
} from '@cortex/agent-tools/src/trackers/formats';
import {
  FIELD_TYPES,
  type FieldType,
  type TrackerField,
  trackerFieldsSchema,
} from '@cortex/agent-tools/src/trackers/schema';
import { validateRowValues } from '@cortex/agent-tools/src/trackers/validation';

/**
 * LA LÓGICA DEL EDITOR DE CAMPOS, SIN PANTALLA.
 *
 * Todo lo que el editor decide —qué opciones tiene cada tipo, qué atajos hay
 * para «no puede ser futura», qué campos pueden ser el «padre» de un «mostrar
 * sólo si…» sin armar un ciclo, si un patrón pasa con un ejemplo— son funciones
 * puras sobre `TrackerField[]`. El componente sólo las llama. Se prueban sin
 * navegador (`schema-editor.test.ts`) y, sobre todo, la validación de verdad es
 * `trackerFieldsSchema`, la MISMA que usa el servidor al guardar: el editor no
 * inventa una segunda definición de «campo válido».
 *
 * Importa hojas sueltas de `@cortex/agent-tools/src/trackers/*` y no el
 * barril: el barril arrastra `node:dns` y rompe el build del navegador (ver
 * lib/views/editor-shape.ts).
 */

export { FIELD_TYPES, FIELD_FORMATS, MAX_SELECT_OPTIONS, MAX_TRACKER_FIELDS };
export type { FieldFormat, FieldType, TrackerField };

// ---------------------------------------------------------------------------
// Qué aplica a cada tipo
// ---------------------------------------------------------------------------

const TEXTUAL: ReadonlySet<FieldType> = new Set(['text', 'longtext']);
const NUMERIC: ReadonlySet<FieldType> = new Set(['number', 'money']);
const TEMPORAL: ReadonlySet<FieldType> = new Set(['date', 'time']);

export const typeHas = {
  options: (t: FieldType) => t === 'select',
  bounds: (t: FieldType) => NUMERIC.has(t) || TEMPORAL.has(t),
  length: (t: FieldType) => TEXTUAL.has(t),
  format: (t: FieldType) => t === 'text',
  pattern: (t: FieldType) => TEXTUAL.has(t),
  scan: (t: FieldType) => t === 'text',
  file: (t: FieldType) => t === 'file',
  relation: (t: FieldType) => t === 'relation',
  unique: (t: FieldType) => t !== 'file',
  placeholder: (t: FieldType) => TEXTUAL.has(t) || NUMERIC.has(t),
  defaultValue: (t: FieldType) => t !== 'file' && t !== 'relation' && t !== 'location',
};

/** Los campos de `TrackerField` que sólo valen para ciertos tipos, para podarlos al cambiar de tipo. */
function prune(field: TrackerField, type: FieldType): TrackerField {
  const next: TrackerField = { ...field, type };
  if (!typeHas.options(type)) next.options = undefined;
  if (!typeHas.bounds(type)) {
    next.min = undefined;
    next.max = undefined;
  } else if (
    // Un límite de número no vale como límite de fecha, y viceversa.
    (NUMERIC.has(type) && (typeof next.min === 'string' || typeof next.max === 'string')) ||
    (TEMPORAL.has(type) && (typeof next.min === 'number' || typeof next.max === 'number')) ||
    // De fecha a hora (o al revés) los literales cambian de forma.
    (TEMPORAL.has(type) && TEMPORAL.has(field.type) && type !== field.type)
  ) {
    next.min = undefined;
    next.max = undefined;
  }
  if (!typeHas.length(type)) {
    next.minLength = undefined;
    next.maxLength = undefined;
  }
  if (!typeHas.format(type)) next.format = undefined;
  if (!typeHas.pattern(type)) next.pattern = undefined;
  if (!typeHas.scan(type)) next.scan = undefined;
  if (!typeHas.file(type)) {
    next.accept = undefined;
    next.multiple = undefined;
  }
  if (!typeHas.relation(type)) next.tracker = undefined;
  if (!typeHas.unique(type)) next.unique = undefined;
  if (!typeHas.placeholder(type)) next.placeholder = undefined;
  if (!typeHas.defaultValue(type)) next.default = undefined;
  // Un valor por defecto de otro tipo se descarta: «today» no es una opción ni un número.
  if (next.default !== undefined) {
    const d = next.default;
    if (type === 'date' && !(d === 'today' || /^\d{4}-\d{2}-\d{2}$/.test(String(d))))
      next.default = undefined;
    if (type === 'time' && !(d === 'now' || /^\d{1,2}:\d{2}$/.test(String(d))))
      next.default = undefined;
    if (NUMERIC.has(type) && !Number.isFinite(Number(d))) next.default = undefined;
    if (type === 'select' && !(next.options ?? []).includes(String(d))) next.default = undefined;
    if (type === 'checkbox' && !['0', '1', 'true', 'false', 'si', 'sí', 'no'].includes(String(d)))
      next.default = undefined;
  }
  if (type === 'select' && !next.options?.length) next.options = ['Opción 1'];
  return next;
}

/** Cambia el tipo de un campo y descarta lo que ya no le aplica. */
export function changeFieldType(field: TrackerField, type: FieldType): TrackerField {
  return type === field.type ? field : prune(field, type);
}

/**
 * ¿Es seguro cambiarle el tipo a un campo que YA tiene datos? Los valores se
 * guardan como están: pasar de texto a número deja «abc» donde ahora se espera
 * un número. Sólo se permiten las migraciones que no pueden dejar basura.
 */
const SAFE_TYPE_CHANGES: ReadonlyArray<readonly [FieldType, FieldType]> = [
  ['text', 'longtext'],
  ['longtext', 'text'],
  ['number', 'money'],
  ['money', 'number'],
  ['select', 'text'],
  ['select', 'longtext'],
  ['number', 'text'],
  ['money', 'text'],
  ['date', 'text'],
  ['time', 'text'],
];

export function typeChangeIsSafe(from: FieldType, to: FieldType): boolean {
  return from === to || SAFE_TYPE_CHANGES.some(([a, b]) => a === from && b === to);
}

// ---------------------------------------------------------------------------
// Lista de campos: agregar, mover, quitar
// ---------------------------------------------------------------------------

/** Un campo nuevo con una clave que no choca con las que hay. */
export function newField(
  fields: TrackerField[],
  label: string,
  type: FieldType = 'text',
): TrackerField {
  const clean = label.trim().slice(0, 60) || 'Campo nuevo';
  const key = fieldKeyFrom(
    clean,
    fields.map((f) => f.key),
  );
  return prune({ key, label: clean, type: 'text', required: false }, type);
}

export function moveField(fields: TrackerField[], from: number, to: number): TrackerField[] {
  if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length)
    return fields;
  const next = [...fields];
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  return next;
}

/** Los campos que dependen de éste por un «mostrar sólo si…». */
export function dependentsOf(fields: TrackerField[], key: string): TrackerField[] {
  return fields.filter((f) => f.showIf?.field === key);
}

/**
 * Quita un campo del borrador. Los que se mostraban según él pierden la
 * condición (quedan siempre visibles) en vez de quedar apuntando al vacío, que
 * el esquema rechazaría; se devuelven para avisarlo.
 */
export function removeField(
  fields: TrackerField[],
  key: string,
): { fields: TrackerField[]; clearedShowIf: string[] } {
  const cleared = dependentsOf(fields, key).map((f) => f.label);
  return {
    fields: fields
      .filter((f) => f.key !== key)
      .map((f) => (f.showIf?.field === key ? { ...f, showIf: undefined } : f)),
    clearedShowIf: cleared,
  };
}

/** Quita lo vacío (`undefined`, «», listas sin nada) para que lo guardado sea sólo lo que importa. */
export function cleanField(field: TrackerField): TrackerField {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '' && k !== 'label' && k !== 'key') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    // Casillas apagadas = igual que ausentes, para no ensuciar el JSON.
    if ((k === 'unique' || k === 'multiple' || k === 'scan') && v === false) continue;
    out[k] = typeof v === 'string' && k !== 'default' ? v.trim() : v;
  }
  if (Array.isArray(field.options)) {
    const options = [...new Set(field.options.map((o) => o.trim()).filter(Boolean))];
    if (options.length) out.options = options;
    else out.options = undefined;
  }
  return out as unknown as TrackerField;
}

export const cleanFields = (fields: TrackerField[]) => fields.map(cleanField);

// ---------------------------------------------------------------------------
// «Mostrar sólo si…»: ciclos
// ---------------------------------------------------------------------------

/**
 * ¿Hacer que `key` dependa de `target` forma un ciclo? Sí si `target` ya
 * depende (directa o indirectamente) de `key`, o es el mismo campo. Un ciclo
 * dejaría los dos ocultos para siempre.
 */
export function showIfWouldCycle(fields: TrackerField[], key: string, target: string): boolean {
  if (key === target) return true;
  const parent = new Map(fields.flatMap((f) => (f.showIf ? [[f.key, f.showIf.field]] : [])));
  const seen = new Set<string>();
  let cur: string | undefined = target;
  while (cur) {
    if (cur === key) return true;
    if (seen.has(cur)) return true; // ya había un ciclo: tampoco se suma a él
    seen.add(cur);
    cur = parent.get(cur);
  }
  return false;
}

export interface ShowIfTarget {
  key: string;
  label: string;
  /** Por qué no se puede elegir (ciclo); vacío si sí. */
  disabled?: string;
}

/** Los campos que pueden ser «padre» de `key`, con el motivo de los que no. */
export function showIfTargets(fields: TrackerField[], key: string): ShowIfTarget[] {
  return fields
    .filter((f) => f.key !== key)
    .map((f) =>
      showIfWouldCycle(fields, key, f.key)
        ? {
            key: f.key,
            label: f.label,
            disabled: 'Ese campo ya depende de éste: sería un círculo.',
          }
        : { key: f.key, label: f.label },
    );
}

/** Los valores que se ofrecen para «es igual a»: las opciones de un select, Sí/No de una casilla. */
export function showIfChoices(parent: TrackerField | undefined): string[] | null {
  if (!parent) return null;
  if (parent.type === 'select') return parent.options ?? [];
  if (parent.type === 'checkbox') return ['1', '0'];
  return null;
}

// ---------------------------------------------------------------------------
// Patrón propio con prueba en vivo
// ---------------------------------------------------------------------------

export type PatternProbe =
  | { state: 'empty' }
  | { state: 'invalid'; message: string }
  | { state: 'pass' }
  | { state: 'fail' };

/** Prueba un patrón contra un ejemplo, con la misma protección y el mismo corte que el servidor. */
export function probePattern(pattern: string, sample: string): PatternProbe {
  if (!pattern.trim()) return { state: 'empty' };
  if (!isSafePattern(pattern))
    return {
      state: 'invalid',
      message:
        'Ese patrón es peligroso o muy largo (máx. 200; sin repeticiones anidadas como (a+)+ ni referencias hacia atrás).',
    };
  const re = compilePattern(pattern);
  if (!re) return { state: 'invalid', message: 'Ese patrón no está bien escrito.' };
  if (!sample) return { state: 'empty' };
  return testPattern(re, sample.slice(0, PATTERN_INPUT_MAX))
    ? { state: 'pass' }
    : { state: 'fail' };
}

/** Presets de formato con un ejemplo que pasa (y que el editor muestra al elegirlos). */
export const FORMAT_PRESETS: ReadonlyArray<{ value: FieldFormat; label: string; example: string }> =
  [
    { value: 'email', label: 'Correo electrónico', example: 'ana@empresa.com' },
    { value: 'phone', label: 'Teléfono', example: '+57 300 123 4567' },
    { value: 'nit', label: 'NIT con dígito de verificación', example: '900123456-7' },
    { value: 'plate', label: 'Placa de vehículo', example: 'ABC123' },
    { value: 'awb', label: 'Guía aérea (AWB)', example: '176-12345675' },
    { value: 'digits', label: 'Sólo números', example: '12345' },
  ];

// ---------------------------------------------------------------------------
// Atajos de mínimo / máximo
// ---------------------------------------------------------------------------

export interface BoundShortcut {
  id: string;
  label: string;
  patch: { min?: string | number; max?: string | number };
}

export function boundShortcuts(type: FieldType): BoundShortcut[] {
  if (type === 'date')
    return [
      { id: 'not-future', label: 'No puede ser futura', patch: { max: 'today' } },
      { id: 'from-today', label: 'Desde hoy', patch: { min: 'today' } },
      { id: 'last-30', label: 'Últimos 30 días', patch: { min: 'today-30', max: 'today' } },
      { id: 'next-30', label: 'Próximos 30 días', patch: { min: 'today', max: 'today+30' } },
    ];
  if (type === 'time')
    return [
      { id: 'not-future', label: 'No puede ser futura', patch: { max: 'now' } },
      { id: 'from-now', label: 'Desde ahora', patch: { min: 'now' } },
    ];
  if (type === 'number' || type === 'money')
    return [
      { id: 'positive', label: 'No negativo', patch: { min: 0 } },
      { id: 'percent', label: 'De 0 a 100', patch: { min: 0, max: 100 } },
    ];
  return [];
}

/** ¿El atajo ya está aplicado tal cual? (para marcarlo). */
export function shortcutActive(field: TrackerField, s: BoundShortcut): boolean {
  return (
    ('min' in s.patch ? field.min === s.patch.min : true) &&
    ('max' in s.patch ? field.max === s.patch.max : true)
  );
}

// ---------------------------------------------------------------------------
// Validación antes de guardar
// ---------------------------------------------------------------------------

export interface DraftValidation {
  ok: boolean;
  /** Errores por clave de campo, en español. */
  byField: Record<string, string[]>;
  /** Errores que no son de un campo (la lista entera). */
  general: string[];
}

/** Los mensajes por defecto de zod que sí pueden llegar a verse, en español. */
function plain(message: string, prop: string | undefined, label: string): string {
  if (prop === 'label') return 'Ponle un nombre al campo (hasta 60 letras).';
  if (prop === 'options')
    return /Array must contain at most/i.test(message)
      ? `Hasta ${MAX_SELECT_OPTIONS} opciones.`
      : /String must contain/i.test(message)
        ? 'Una opción no puede estar vacía ni pasar de 80 letras.'
        : message;
  if (prop === 'min' || prop === 'max')
    return /Expected|Invalid/i.test(message)
      ? `«${label}»: revisa el ${prop === 'min' ? 'mínimo' : 'máximo'}.`
      : message;
  if (prop === 'message') return 'El mensaje de error pasa de 200 letras.';
  if (prop === 'help') return 'La ayuda pasa de 200 letras.';
  if (prop === 'placeholder' || prop === 'example') return 'El texto de ejemplo pasa de 80 letras.';
  if (prop === 'default') return 'El valor por defecto no es válido.';
  if (prop === 'tracker') return 'Elige la tabla a la que apunta la relación.';
  if (/^(Invalid|Expected|Required|String must|Number must|Array must)/i.test(message))
    return `«${label}»: revisa este campo.`;
  return message;
}

/**
 * Valida el borrador con el esquema real. `byField` se indexa por la clave del
 * campo; un campo sin clave todavía (no debería) cae en `general`.
 */
export function validateDraft(fields: TrackerField[]): DraftValidation {
  const byField: Record<string, string[]> = {};
  const general: string[] = [];
  if (fields.length === 0) {
    return { ok: false, byField, general: ['La tabla necesita al menos un campo.'] };
  }
  if (fields.length > MAX_TRACKER_FIELDS) {
    return {
      ok: false,
      byField,
      general: [`Una tabla tiene hasta ${MAX_TRACKER_FIELDS} campos.`],
    };
  }
  const parsed = trackerFieldsSchema.safeParse(cleanFields(fields));
  const labels = new Map<string, number>();
  for (const f of fields) {
    const k = f.label.trim().toLowerCase();
    labels.set(k, (labels.get(k) ?? 0) + 1);
  }
  for (const f of fields)
    if (f.label.trim() && (labels.get(f.label.trim().toLowerCase()) ?? 0) > 1)
      byField[f.key] = [`Hay dos campos llamados «${f.label.trim()}».`];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [index, prop] = issue.path;
      const field = typeof index === 'number' ? fields[index] : undefined;
      const message = plain(
        issue.message,
        typeof prop === 'string' ? prop : undefined,
        field?.label ?? '',
      );
      if (field) {
        const list = byField[field.key] ?? [];
        if (!list.includes(message)) list.push(message);
        byField[field.key] = list;
      } else if (!general.includes(message)) general.push(message);
    }
  }
  return { ok: Object.keys(byField).length === 0 && general.length === 0, byField, general };
}

// ---------------------------------------------------------------------------
// Vista previa del input
// ---------------------------------------------------------------------------

/** Lo que dice un campo con el ejemplo escrito: los errores que daría el formulario real. */
export function previewMessages(field: TrackerField, sample: string): string[] {
  // Sin `showIf` ni `unique`: aquí se prueba el campo solo, sin las demás filas.
  const solo: TrackerField = { ...field, showIf: undefined, unique: undefined };
  return validateRowValues([solo], { [field.key]: sample }).map((v) => v.message);
}

// ---------------------------------------------------------------------------
// Regla de duplicados
// ---------------------------------------------------------------------------

export interface DuplicateDraft {
  key: string;
  distinctBy?: string;
  flagField: string;
  flagValue: string;
}

/** Lo que le falta a la regla, en español; null si está bien. Calca `validateDuplicateRule`. */
export function duplicateProblem(rule: DuplicateDraft, fields: TrackerField[]): string | null {
  const by = (k: string) => fields.find((f) => f.key === k);
  if (!rule.key) return 'Elige el campo que no debe repetirse.';
  if (!by(rule.key)) return 'El campo que no debe repetirse ya no existe.';
  if (rule.distinctBy && !by(rule.distinctBy)) return 'El campo «con distinto…» ya no existe.';
  if (!rule.flagField) return 'Elige en qué campo se marca la fila repetida.';
  const flag = by(rule.flagField);
  if (!flag) return 'El campo de marca ya no existe.';
  if (flag.key === rule.key || flag.key === rule.distinctBy)
    return 'El campo de marca tiene que ser distinto de los otros dos.';
  if (!rule.flagValue.trim()) return 'Escribe la marca (por ejemplo «Duplicada»).';
  if (flag.type === 'select') {
    if (!flag.options?.includes(rule.flagValue))
      return `«${flag.label}» no tiene la opción «${rule.flagValue}».`;
  } else if (flag.type !== 'text') return 'El campo de marca tiene que ser de opciones o de texto.';
  return null;
}

/** ¿Falta sólo la opción en el select de marca? Entonces se ofrece crearla. */
export function missingFlagOption(rule: DuplicateDraft, fields: TrackerField[]): string | null {
  const flag = fields.find((f) => f.key === rule.flagField);
  return flag?.type === 'select' && rule.flagValue.trim() && !flag.options?.includes(rule.flagValue)
    ? flag.key
    : null;
}

/** Agrega la opción de marca al select (si falta), para que la regla sea válida. */
export function withFlagOption(fields: TrackerField[], rule: DuplicateDraft): TrackerField[] {
  return fields.map((f) =>
    f.key === rule.flagField && f.type === 'select' && !f.options?.includes(rule.flagValue)
      ? { ...f, options: [...(f.options ?? []), rule.flagValue.trim()] }
      : f,
  );
}

// ---------------------------------------------------------------------------
// Límites de fecha, en palabras
// ---------------------------------------------------------------------------

export type DateBoundMode = 'none' | 'today' | 'before' | 'after' | 'fixed';

/** «today-30» → «hace 30 días»; el editor trabaja con modo + número + fecha. */
export function readDateBound(b: string | number | undefined): {
  mode: DateBoundMode;
  n: number;
  date: string;
} {
  if (typeof b !== 'string' || !b) return { mode: 'none', n: 30, date: '' };
  if (b === 'today') return { mode: 'today', n: 30, date: '' };
  const m = /^today([+-])(\d{1,4})$/.exec(b);
  if (m) return { mode: m[1] === '-' ? 'before' : 'after', n: Number(m[2]), date: '' };
  return { mode: 'fixed', n: 30, date: b };
}

export function writeDateBound(mode: DateBoundMode, n: number, date: string): string | undefined {
  const days = Math.max(1, Math.min(9999, Math.round(n) || 1));
  switch (mode) {
    case 'none':
      return undefined;
    case 'today':
      return 'today';
    case 'before':
      return `today-${days}`;
    case 'after':
      return `today+${days}`;
    case 'fixed':
      return date || undefined;
  }
}

/** La opción de interval que se ofrece en las sincronizaciones. */
export const SYNC_INTERVALS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 5, label: 'Cada 5 minutos' },
  { value: 15, label: 'Cada 15 minutos' },
  { value: 30, label: 'Cada 30 minutos' },
  { value: 60, label: 'Cada hora' },
  { value: 180, label: 'Cada 3 horas' },
  { value: 720, label: 'Cada 12 horas' },
  { value: 1440, label: 'Una vez al día' },
];

/** ¿Es un intervalo que el servidor acepta? */
export function intervalProblem(minutes: number): string | null {
  if (!Number.isInteger(minutes)) return 'Escribe un número entero de minutos.';
  if (minutes < 5 || minutes > 1440) return 'Entre 5 y 1440 minutos.';
  return null;
}
