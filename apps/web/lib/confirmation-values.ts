/**
 * VALORES Y ETIQUETAS DE LA TARJETA DE APROBACIÓN, EN ESPAÑOL.
 *
 * `String(objeto)` daba «[object Object]» en «Qué va a cambiar» para cualquier
 * arreglo u objeto (los `fields` de una tabla, las pantallas de una app), y las
 * llaves del input salían tal cual en inglés (Slug, Name, Fields). Aquí viven
 * las dos cosas, puras: `renderValue` convierte CUALQUIER valor en texto, lista
 * o líneas «llave: valor», y `labelFor` traduce la llave.
 */

export type RenderedValue =
  | { kind: 'text'; text: string; full?: string }
  | { kind: 'list'; items: string[]; total: number }
  | { kind: 'lines'; items: string[]; total: number };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Las etiquetas de las llaves que más aparecen en las herramientas de Cortex. */
const LABELS: Record<string, string> = {
  slug: 'Identificador',
  id: 'Identificador',
  name: 'Nombre',
  title: 'Título',
  description: 'Descripción',
  fields: 'Campos',
  options: 'Opciones',
  tracker: 'Tabla',
  tables: 'Tablas',
  screens: 'Pantallas',
  roles: 'Roles',
  states: 'Estados',
  values: 'Valores',
  duplicates: 'Regla de duplicados',
  dashboards: 'Paneles',
  portal: 'Portal',
  permissions: 'Permisos',
  automations: 'Automatizaciones',
  subject: 'Asunto',
  body: 'Mensaje',
  to: 'Para',
  cc: 'Cc',
  bcc: 'Cco',
  type: 'Tipo',
  key: 'Clave',
  label: 'Etiqueta',
  required: 'Obligatorio',
  flow: 'Flujo por estados',
  note: 'Nota',
  notes: 'Notas',
  content: 'Contenido',
  text: 'Texto',
  message: 'Mensaje',
  status: 'Estado',
  amount: 'Monto',
  date: 'Fecha',
  due: 'Vence',
  dueDate: 'Vence',
  start: 'Inicio',
  end: 'Fin',
  email: 'Correo',
  phone: 'Teléfono',
  client: 'Cliente',
  user: 'Usuario',
  users: 'Usuarios',
  query: 'Búsqueda',
  limit: 'Límite',
  remove: 'Quitar',
  kind: 'Tipo',
  channel: 'Canal',
  cadence: 'Frecuencia',
  schedule: 'Programación',
  blocks: 'Bloques',
  layout: 'Distribución',
  icon: 'Ícono',
  color: 'Color',
  url: 'Enlace',
  version: 'Versión',
  published: 'Publicada',
  draft: 'Borrador',
};

/** Palabras sueltas, para llaves compuestas que no están arriba (due_date → «Fecha límite»…). */
const WORDS: Record<string, string> = {
  name: 'nombre',
  title: 'título',
  description: 'descripción',
  date: 'fecha',
  amount: 'monto',
  status: 'estado',
  type: 'tipo',
  id: 'id',
  user: 'usuario',
  client: 'cliente',
  customer: 'cliente',
  email: 'correo',
  phone: 'teléfono',
  address: 'dirección',
  due: 'vencimiento',
  created: 'creado',
  updated: 'actualizado',
  start: 'inicio',
  end: 'fin',
  total: 'total',
  price: 'precio',
  count: 'cantidad',
  note: 'nota',
  notes: 'notas',
  list: 'lista',
  max: 'máximo',
  min: 'mínimo',
  by: 'por',
  at: 'en',
  of: 'de',
  from: 'desde',
  to: 'hasta',
  with: 'con',
  tool: 'herramienta',
  row: 'fila',
  rows: 'filas',
  column: 'columna',
  columns: 'columnas',
  enabled: 'activado',
  active: 'activo',
  only: 'solo',
};

/** Sustantivos que encabezan una llave compuesta: customer_email → «Correo de cliente». */
const HEADS = new Set([
  'date',
  'name',
  'email',
  'phone',
  'amount',
  'status',
  'type',
  'count',
  'total',
  'price',
  'note',
  'notes',
  'description',
  'address',
]);

/** «due_date» → «Fecha de vencimiento»: palabra por palabra al español, con el sustantivo al frente. */
export function humanizeKey(key: string): string {
  const raw = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const tr = (w: string) => WORDS[w] ?? w;
  const last = raw[raw.length - 1];
  const words =
    raw.length >= 2 && last && HEADS.has(last)
      ? [tr(last), 'de', ...raw.slice(0, -1).map(tr)]
      : raw.map(tr);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** La etiqueta en español de una llave del input. */
export function labelFor(key: string): string {
  return LABELS[key] ?? humanizeKey(key);
}

/** Llaves que son fontanería: no se enseñan como renglón propio. */
export const TECHNICAL_KEYS = new Set(['id', 'slug', 'repeatConfirmedByUser', 'draftId', 'rowId']);

const TYPE_ES: Record<string, string> = {
  text: 'Texto',
  longtext: 'Texto largo',
  number: 'Número',
  date: 'Fecha',
  time: 'Hora',
  money: 'Dinero',
  select: 'Opciones',
  checkbox: 'Sí/No',
  file: 'Archivo',
  location: 'Ubicación',
  relation: 'Relación',
  barcode: 'Código de barras',
  signature: 'Firma',
};

export function typeLabel(type: unknown): string {
  return typeof type === 'string' ? (TYPE_ES[type] ?? humanizeKey(type)) : '';
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'number') return new Intl.NumberFormat('es-CO').format(v);
  return String(v);
}

const NAME_KEYS = ['label', 'name', 'title', 'nombre', 'titulo', 'key', 'slug', 'id'];

/** Un elemento de un arreglo de objetos, en una línea: «Nombre del campo · Tipo». */
export function describeItem(item: unknown): string {
  if (!isRecord(item)) return truncate(scalar(item), 120);
  const nameKey = NAME_KEYS.find((k) => typeof item[k] === 'string' && item[k] !== '');
  const name = nameKey ? String(item[nameKey]) : '';
  const bits: string[] = [];
  if (typeof item.type === 'string') bits.push(typeLabel(item.type));
  if (item.required === true) bits.push('obligatorio');
  if (Array.isArray(item.options) && item.options.length > 0)
    bits.push(truncate(item.options.map(String).join(', '), 60));
  if (!name || (!bits.length && !nameKey)) {
    // Sin nombre claro: llaves planas, «llave: valor».
    const flat = Object.entries(item)
      .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
      .slice(0, 3)
      .map(([k, v]) => `${labelFor(k)}: ${truncate(scalar(v), 40)}`);
    return flat.join(' · ') || '—';
  }
  if (!bits.length) {
    const extra = Object.entries(item)
      .filter(
        ([k, v]) =>
          !NAME_KEYS.includes(k) && v !== undefined && v !== null && typeof v !== 'object',
      )
      .slice(0, 2)
      .map(([k, v]) => `${labelFor(k)}: ${truncate(scalar(v), 40)}`);
    return [truncate(name, 80), ...extra].join(' · ');
  }
  return `${truncate(name, 80)} · ${bits.join(' · ')}`;
}

/**
 * Convierte cualquier valor en algo que se pueda dibujar. Nunca `String(objeto)`.
 *  - texto largo → recortado, con el completo en `full` para «ver más».
 *  - arreglo de objetos → una línea por elemento (`list`, con el total).
 *  - arreglo de primitivos → «a, b, c».
 *  - objeto → líneas «Etiqueta: valor».
 */
export function renderValue(v: unknown, opts: { max?: number } = {}): RenderedValue {
  const max = opts.max ?? 160;
  if (v === null || v === undefined || v === '') return { kind: 'text', text: '—' };
  if (typeof v === 'string') {
    return v.length > max
      ? { kind: 'text', text: truncate(v, max), full: v.length > 4000 ? truncate(v, 4000) : v }
      : { kind: 'text', text: v };
  }
  if (typeof v !== 'object') return { kind: 'text', text: scalar(v) };
  if (Array.isArray(v)) {
    if (v.length === 0) return { kind: 'text', text: 'Ninguno' };
    if (v.every((x) => x === null || typeof x !== 'object')) {
      const joined = v.map(scalar).join(', ');
      return joined.length > max
        ? { kind: 'text', text: truncate(joined, max), full: truncate(joined, 4000) }
        : { kind: 'text', text: joined };
    }
    return { kind: 'list', items: v.map(describeItem), total: v.length };
  }
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  if (entries.length === 0) return { kind: 'text', text: '—' };
  const lines = entries.map(([k, x]) => {
    const inner = renderValue(x, { max: 80 });
    const text =
      inner.kind === 'text'
        ? inner.text
        : inner.items.slice(0, 3).join('; ') + (inner.total > 3 ? ` y ${inner.total - 3} más` : '');
    return `${labelFor(k)}: ${text}`;
  });
  return { kind: 'lines', items: lines, total: lines.length };
}

/** Una versión de una sola línea de un valor renderizado (para antes → después y resúmenes). */
export function renderedSummary(r: RenderedValue): string {
  if (r.kind === 'text') return r.text;
  const shown = r.items.slice(0, 3).join('; ');
  return r.total > 3 ? `${shown} y ${r.total - 3} más` : shown;
}
