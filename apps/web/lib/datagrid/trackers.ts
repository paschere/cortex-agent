import type { GridColumn, GridOption, GridRow } from '@/components/datagrid/types';
import { displayTrackerValue, mapsUrl } from '@cortex/agent-tools/src/trackers/schema';
import { foldText, isEmptyValue, parseDay, parseNumber } from './format';

/**
 * LAS TABLAS DE LA EMPRESA EN LA GRILLA, Y DE VUELTA.
 *
 * Una tabla inventada (`trackers`, 0115) tiene once tipos de campo: texto,
 * texto largo, número, fecha, hora, plata, opciones, casilla sí/no, archivo,
 * ubicación y relación. Aquí se traducen a columnas de la grilla, y
 * lo que la grilla edita se traduce al valor que `upsertRow` acepta — que es la
 * validación de verdad: esto solo prepara, no decide.
 *
 * Sin dependencias de servidor: lo usan la pantalla (cliente), las acciones
 * (servidor) y las pruebas.
 */

export type TrackerFieldType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'date'
  | 'time'
  | 'money'
  | 'select'
  | 'checkbox'
  | 'file'
  | 'location'
  | 'relation';
export const TRACKER_FIELD_TYPES: TrackerFieldType[] = [
  'text',
  'longtext',
  'number',
  'money',
  'date',
  'time',
  'select',
  'checkbox',
  'file',
  'location',
  'relation',
];

export const TRACKER_TYPE_LABEL: Record<TrackerFieldType, string> = {
  text: 'Texto',
  longtext: 'Texto largo',
  time: 'Hora',
  checkbox: 'Sí/No',
  number: 'Número',
  money: 'Plata',
  date: 'Fecha',
  select: 'Opciones',
  file: 'Archivo',
  location: 'Ubicación',
  relation: 'Relación',
};

export interface TrackerFieldLike {
  key: string;
  label: string;
  type: TrackerFieldType;
  required?: boolean;
  options?: string[];
  /** Otras opciones del campo (validaciones, ayudas…): la grilla no las usa, pasan de largo. */
  [extra: string]: unknown;
}

export interface TrackerEntryLike {
  id: string;
  label: string;
  values: Record<string, string | number>;
  created_at?: string;
  updated_at: string;
  external_key?: string | null;
  duplicate_flagged?: boolean;
}

export const TRACKER_SLUG_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_TRACKER_FIELDS = 20;
export const MAX_SELECT_OPTIONS = 30;

/** La columna de solo lectura con la última actualización de cada fila. */
export const UPDATED_KEY = '_updated_at';

// ---------------------------------------------------------------------------
// Tonos de las opciones: el color dice algo, nunca decora.
// ---------------------------------------------------------------------------

const TONES: Array<[GridOption['tone'], RegExp]> = [
  ['rose', /cancel|vencid|rechaz|novedad|devuelt|bloque|perdid|mora|fall|error|anulad|urgent/],
  [
    'emerald',
    /entregad|hech|pagad|complet|cerrad|aprobad|activ|al dia|resuelt|list|ganad|vigente|ok\b|si\b/,
  ],
  [
    'amber',
    /pendient|en curso|transit|proceso|revision|espera|programad|abiert|por |parcial|atencion/,
  ],
  ['primary', /nuev|recibid|asignad/],
];

export function toneFor(option: string): GridOption['tone'] {
  const f = foldText(option);
  for (const [tone, re] of TONES) if (re.test(f)) return tone;
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Tabla → grilla
// ---------------------------------------------------------------------------

/** El campo que nombra la fila: el mismo criterio que `rowLabel`. */
export function labelFieldKey(fields: TrackerFieldLike[]): string | null {
  const f =
    fields.find((x) => x.type === 'text' && x.required) ?? fields.find((x) => x.type === 'text');
  return f?.key ?? null;
}

const GRID_TYPE: Record<TrackerFieldType, GridColumn['type']> = {
  text: 'text',
  longtext: 'long_text',
  number: 'number',
  date: 'date',
  time: 'text',
  money: 'money',
  select: 'select',
  checkbox: 'boolean',
  // Se muestran como texto legible (`trackerGridRow` los traduce) y no se editan
  // en la celda: un archivo se sube, una relación se elige y una ubicación se toma en el formulario.
  file: 'text',
  location: 'link',
  relation: 'text',
};

export function trackerColumns(
  fields: TrackerFieldLike[],
  opts: { editable?: boolean; withUpdated?: boolean } = {},
): GridColumn[] {
  const editable = opts.editable ?? true;
  const nameKey = labelFieldKey(fields) ?? fields[0]?.key ?? null;
  const columns: GridColumn[] = fields.map((f) => {
    const isName = f.key === nameKey;
    const column: GridColumn = {
      key: f.key,
      label: f.label,
      // La grilla no tiene «hora»: se ve y se edita como texto (HH:MM).
      type: GRID_TYPE[f.type],
      editable: editable && f.type !== 'file' && f.type !== 'relation' && f.type !== 'location',
      required: Boolean(f.required),
      ...(isName ? { pinned: true, primary: true, width: 240 } : {}),
    };
    if (f.type === 'select')
      column.options = (f.options ?? []).map((o) => ({ value: o, tone: toneFor(o) }));
    if (f.type === 'money') column.currency = 'COP';
    if (!isName && (f.type === 'select' || f.type === 'money' || f.type === 'date'))
      column.primary = true;
    return column;
  });
  // Primarias: el nombre y, como mucho, otras tres que digan algo en la tarjeta.
  let primaries = 0;
  for (const c of columns) {
    if (!c.primary || c.pinned) continue;
    primaries += 1;
    if (primaries > 3) c.primary = false;
  }
  if (opts.withUpdated !== false)
    columns.push({
      key: UPDATED_KEY,
      label: 'Actualizada',
      type: 'datetime',
      editable: false,
      width: 170,
    });
  return columns;
}

export function trackerGridRow(entry: TrackerEntryLike, fields?: TrackerFieldLike[]): GridRow {
  // Archivo y relación guardan JSON; la grilla muestra el nombre / la etiqueta.
  // La ubicación va como enlace a Google Maps.
  const shown: Record<string, string | number> = { ...entry.values };
  for (const f of fields ?? []) {
    const v = entry.values[f.key];
    if (v === undefined || v === '') continue;
    if (f.type === 'file' || f.type === 'relation') shown[f.key] = displayTrackerValue(f, v);
    else if (f.type === 'location') shown[f.key] = mapsUrl(v) ?? String(v);
  }
  return {
    id: entry.id,
    values: { ...shown, [UPDATED_KEY]: entry.updated_at },
    ...(entry.duplicate_flagged ? { alert: true } : {}),
  };
}

/**
 * Lo que la grilla manda al editar → el valor crudo que `coerceValue` acepta.
 * Vacío es `''` (así lo entiende la tabla); una fecha va como `YYYY-MM-DD`.
 */
export function toTrackerValue(type: TrackerFieldType, value: unknown): string | number {
  // La casilla de la grilla manda true/false; la tabla la guarda como 1/0.
  if (type === 'checkbox') {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (isEmptyValue(value)) return '';
    return String(value).trim();
  }
  if (isEmptyValue(value)) return '';
  if (type === 'number' || type === 'money') {
    const n = parseNumber(value);
    return n === null ? String(value) : n;
  }
  if (type === 'date') {
    if (typeof value === 'string') return parseDay(value) ?? value;
    return String(value);
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// Nombres: de lo que alguien escribe a una clave válida
// ---------------------------------------------------------------------------

function snake(text: string): string {
  return foldText(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** «Guías de carga» → `guias_de_carga`, sin chocar con las que ya existen. */
export function slugFromName(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let base = snake(name).slice(0, 40);
  if (!/^[a-z]/.test(base)) base = `tabla_${base}`.replace(/_+$/, '');
  if (base.length < 2) base = 'tabla';
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}_${i}`;
  return slug;
}

/** «Fecha de entrega» → `fecha_de_entrega` (≤ 32), única en la tabla. */
export function fieldKeyFrom(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let base = snake(label).slice(0, 28);
  if (!/^[a-z]/.test(base)) base = `campo_${base}`.replace(/_+$/, '').slice(0, 28);
  if (!base) base = 'campo';
  let key = base;
  for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
  return key;
}

// ---------------------------------------------------------------------------
// Importar: de un CSV a campos y filas
// ---------------------------------------------------------------------------

const MONEY_HINT = /valor|precio|total|monto|saldo|costo|flete|pago|cobro|venta|deuda|tarifa|\$/;
const DATE_HINT = /fecha|dia|vence|venc|entrega|corte|inicio|fin\b|cierre/;

/** El tipo que mejor describe una columna de texto crudo. */
export function guessFieldType(
  label: string,
  values: string[],
): { type: TrackerFieldType; options?: string[] } {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return { type: 'text' };
  const hint = foldText(label);
  if (filled.every((v) => parseDay(v))) return { type: 'date' };
  if (filled.every((v) => parseNumber(v) !== null)) {
    const money = MONEY_HINT.test(hint) || filled.some((v) => v.includes('$'));
    return { type: money ? 'money' : 'number' };
  }
  const distinct = [...new Set(filled)];
  if (
    filled.length >= 6 &&
    distinct.length <= Math.min(12, MAX_SELECT_OPTIONS) &&
    distinct.length <= filled.length / 2 &&
    distinct.every((v) => v.length <= 40) &&
    !DATE_HINT.test(hint)
  ) {
    return { type: 'select', options: distinct };
  }
  return { type: 'text' };
}

export interface ImportPlan {
  fields: Array<TrackerFieldLike & { source: number }>;
  rows: Array<Record<string, string | number>>;
  /** Avisos para la vista previa: columnas que no entraron, filas raras. */
  notes: string[];
}

/**
 * Encabezados + filas de texto → campos con tipo y filas listas para la tabla.
 * Si `fields` ya existe (importar a una tabla que ya está), se emparejan por
 * nombre sin tildes y lo que no empareja se avisa y se deja fuera.
 */
export function planImport(
  header: string[],
  body: string[][],
  existing?: TrackerFieldLike[],
): ImportPlan {
  const notes: string[] = [];
  const fields: ImportPlan['fields'] = [];
  if (existing) {
    for (const [i, h] of header.entries()) {
      const f = foldText(h);
      const match = existing.find((x) => foldText(x.label) === f || x.key === snake(h));
      if (match) fields.push({ ...match, source: i });
      else if (h.trim()) notes.push(`La columna «${h.trim()}» no está en la tabla; no se importa.`);
    }
  } else {
    const taken: string[] = [];
    for (const [i, h] of header.entries()) {
      const label = h.trim() || `Columna ${i + 1}`;
      if (fields.length >= MAX_TRACKER_FIELDS) {
        notes.push(`Una tabla tiene hasta ${MAX_TRACKER_FIELDS} campos; «${label}» queda fuera.`);
        continue;
      }
      const guess = guessFieldType(
        label,
        body.map((r) => r[i] ?? ''),
      );
      const key = fieldKeyFrom(label, taken);
      taken.push(key);
      fields.push({
        key,
        label: label.slice(0, 60),
        type: guess.type,
        ...(guess.options ? { options: guess.options } : {}),
        source: i,
      });
    }
  }

  const { rows, skipped } = convertRows(fields, body);
  if (skipped)
    notes.push(`${skipped} ${skipped === 1 ? 'fila vacía no entra' : 'filas vacías no entran'}.`);
  return { fields, rows, notes };
}

/** Filas de texto → valores de la tabla según los campos (y su columna de origen). */
export function convertRows(
  fields: Array<TrackerFieldLike & { source: number }>,
  body: string[][],
): { rows: Array<Record<string, string | number>>; skipped: number; dropped: number } {
  const rows: Array<Record<string, string | number>> = [];
  let skipped = 0;
  let dropped = 0;
  for (const raw of body) {
    const values: Record<string, string | number> = {};
    for (const f of fields) {
      const cell = (raw[f.source] ?? '').trim();
      if (!cell) continue;
      if (f.type === 'number' || f.type === 'money') {
        const n = parseNumber(cell);
        if (n !== null) values[f.key] = n;
        else dropped += 1;
      } else if (f.type === 'date') {
        const d = parseDay(cell);
        if (d) values[f.key] = d;
        else dropped += 1;
      } else if (f.type === 'select') {
        const opt = f.options?.find((o) => foldText(o) === foldText(cell));
        if (opt) values[f.key] = opt;
        else dropped += 1;
      } else {
        values[f.key] = cell.slice(0, 400);
      }
    }
    if (Object.keys(values).length) rows.push(values);
    else skipped += 1;
  }
  return { rows, skipped, dropped };
}

/** Las opciones de un campo a partir de lo que trae la columna (hasta 30). */
export function optionsFrom(body: string[][], source: number): string[] {
  const seen = new Map<string, string>();
  for (const r of body) {
    const v = (r[source] ?? '').trim();
    if (v && !seen.has(foldText(v))) seen.set(foldText(v), v.slice(0, 80));
    if (seen.size >= MAX_SELECT_OPTIONS) break;
  }
  return [...seen.values()];
}
