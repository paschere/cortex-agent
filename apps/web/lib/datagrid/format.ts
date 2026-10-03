import type { GridColumn, GridColumnType, GridOption } from '@/components/datagrid/types';

/**
 * LEER Y ESCRIBIR UN VALOR, POR TIPO, EN ESPAÑOL DE COLOMBIA.
 *
 * Una sola casa para «cómo se ve» y «cómo se entiende lo que alguien tecleó»,
 * porque la grilla, el CSV, el filtro y la búsqueda tienen que estar de acuerdo:
 * si la celda dice «$ 1.250.000», buscar «1.250.000» la encuentra y exportarla
 * da `1250000` en un número que Excel en español lee como número.
 *
 * Convenciones (también en el contrato de `components/datagrid/types.ts`):
 *   - `date` es un día `YYYY-MM-DD`, sin hora ni zona: un vencimiento no cambia
 *     de día porque lo mire alguien en otra zona.
 *   - `datetime` es un ISO completo; se muestra en hora de Bogotá.
 *   - `percent` va en puntos: 12.5 es «12,5 %».
 *   - `money` es un número en la moneda de la columna (COP por defecto).
 */

export const TIME_ZONE = 'America/Bogota';

export const COLLATOR = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Minúsculas y sin tildes: «Bogotá» y «bogota» son la misma búsqueda. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export const NUMERIC_TYPES: ReadonlySet<GridColumnType> = new Set(['number', 'money', 'percent']);
export const DATE_TYPES: ReadonlySet<GridColumnType> = new Set(['date', 'datetime']);
export const OPTION_TYPES: ReadonlySet<GridColumnType> = new Set([
  'select',
  'status',
  'multi_select',
]);

export function isNumericType(type: GridColumnType): boolean {
  return NUMERIC_TYPES.has(type);
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

/**
 * Un número escrito como lo escribe una persona en Colombia, o como lo manda
 * una máquina. «1.250.000», «1250000», «$ 1.250.000,50», «12,5», «12.5 %».
 *
 * La regla del punto: un punto seguido de exactamente tres cifras, y sin coma
 * en el texto, es separador de miles («1.500» = 1500); cualquier otro punto
 * solo es decimal («2.5»). La coma siempre es decimal.
 */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s $%]|COP|USD|EUR/gi, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;
  const hasComma = s.includes(',');
  const dots = (s.match(/\./g) ?? []).length;
  if (hasComma) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastDot > lastComma) {
      // «1,250,000.50»: estilo inglés.
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
      if (s.includes(',')) return null;
    }
  } else if (dots > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(s)) return null;
    s = s.replace(/\./g, '');
  } else if (dots === 1 && /^\d{1,3}\.\d{3}$/.test(s)) {
    s = s.replace('.', '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = numberFormats.get(key);
  if (!f) {
    f = make();
    numberFormats.set(key, f);
  }
  return f;
}

export function formatNumber(n: number, maxDecimals = 2): string {
  return nf(`n${maxDecimals}`, () =>
    Intl.NumberFormat('es-CO', { maximumFractionDigits: maxDecimals }),
  ).format(n);
}

export function formatMoney(n: number, currency = 'COP'): string {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : 'COP';
  const decimals = code === 'COP' ? 0 : 2;
  return nf(`m${code}`, () =>
    Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }),
  ).format(n);
}

/** Cifras grandes en poco espacio: «$ 12,4 M». Para totales en tarjetas. */
export function formatCompactMoney(n: number, currency = 'COP'): string {
  const abs = Math.abs(n);
  if (abs < 1_000_000) return formatMoney(n, currency);
  const sign = n < 0 ? '-' : '';
  const symbol = currency === 'COP' ? '$' : currency;
  if (abs >= 1_000_000_000) return `${sign}${symbol} ${formatNumber(abs / 1_000_000_000, 1)} mil M`;
  return `${sign}${symbol} ${formatNumber(abs / 1_000_000, 1)} M`;
}

export function formatPercent(n: number): string {
  return `${formatNumber(n, 1)} %`;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDay(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** El día de Bogotá de un instante, como `YYYY-MM-DD`. */
export function bogotaDay(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

/**
 * El día que representa un valor: un `YYYY-MM-DD` tal cual, un ISO con hora
 * en el día de Bogotá, `null` si no es una fecha.
 */
export function dayKey(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : bogotaDay(value);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = DAY_RE.exec(s);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3])) ? s : null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : bogotaDay(d);
  }
  return null;
}

/** Milisegundos para ordenar: un día a mediodía UTC, un ISO tal cual. */
export function timeValue(value: unknown): number | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  if (typeof value === 'string' && DAY_RE.test(value.trim())) {
    const key = dayKey(value);
    return key ? Date.parse(`${key}T12:00:00Z`) : null;
  }
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function df(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = dateFormats.get(key);
  if (!f) {
    f = make();
    dateFormats.set(key, f);
  }
  return f;
}

export const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];
export const MONTHS_LONG = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * «2 oct 2026». Armado a mano y no con `Intl`: cada versión de ICU escribe
 * es-CO distinto («2 de oct. de 2026»), y una celda no puede cambiar de forma
 * según el navegador de quien la mira.
 */
export function formatDay(day: string): string {
  const key = dayKey(day);
  if (!key) return day;
  const [y, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[(m ?? 1) - 1]} ${y}`;
}

/** «Octubre de 2026». */
export function formatMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return `${MONTHS_LONG[Number(m[2]) - 1]} de ${m[1]}`;
}

function bogotaParts(d: Date): Record<string, string> {
  return Object.fromEntries(
    df('parts', () =>
      Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    )
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
}

/** «2 oct 2026, 3:04 p. m.» en hora de Bogotá. */
export function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = bogotaParts(d);
  const h = Number(p.hour);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${Number(p.day)} ${MONTHS_SHORT[Number(p.month) - 1]} ${p.year}, ${h12}:${p.minute} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** `YYYY-MM-DDTHH:mm` en hora de Bogotá, para un `<input type="datetime-local">`. */
export function toLocalInput(value: unknown): string {
  if (typeof value !== 'string') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = bogotaParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Un día como lo escribe una persona: `2026-10-02`, `2/10/2026`, `02-10-26`. */
export function parseDay(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = DAY_RE.exec(s);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? s : null;
  const isoTime = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(s);
  if (isoTime?.[1]) return dayKey(s.includes('T') ? s : isoTime[1]);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    let y = Number(dmy[3]);
    if (y < 100) y += 2000;
    return validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  return null;
}

/** Fecha y hora escrita en Bogotá → ISO con su zona. */
export function parseDateTime(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local?.[1]) {
    const day = parseDay(local[1]);
    const h = Number(local[2]);
    const min = Number(local[3]);
    if (!day || h > 23 || min > 59) return null;
    return new Date(`${day}T${pad(h)}:${pad(min)}:${local[4] ?? '00'}-05:00`).toISOString();
  }
  const day = parseDay(s);
  if (day) return new Date(`${day}T00:00:00-05:00`).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Opciones, personas y booleanos
// ---------------------------------------------------------------------------

export function optionFor(column: GridColumn, value: unknown): GridOption | undefined {
  if (value === null || value === undefined) return undefined;
  const v = String(value);
  return column.options?.find((o) => o.value === v);
}

export function optionLabel(column: GridColumn, value: unknown): string {
  const option = optionFor(column, value);
  return option ? (option.label ?? option.value) : String(value ?? '');
}

/** Lo que vale una multi-selección como lista, venga como venga. */
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim() !== '');
  if (typeof value === 'string')
    return value
      .split(/[;,]/)
      .map((v) => v.trim())
      .filter(Boolean);
  if (value === null || value === undefined) return [];
  return [String(value)];
}

/** Una persona puede llegar como texto o como `{ name }`/`{ label }`/`{ email }`. */
export function personName(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const k of ['name', 'label', 'email']) {
      if (typeof v[k] === 'string' && (v[k] as string).trim()) return (v[k] as string).trim();
    }
  }
  return value === null || value === undefined ? '' : String(value);
}

export function initials(name: string): string {
  const parts = name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const f = foldText(value);
    if (['si', 's', 'true', 'verdadero', '1', 'x', 'yes', 'y'].includes(f)) return true;
    if (['no', 'n', 'false', 'falso', '0'].includes(f)) return false;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mostrar
// ---------------------------------------------------------------------------

/** El texto de una celda, tal como se lee en pantalla. Vacío si no hay valor. */
export function formatValue(column: GridColumn, value: unknown): string {
  if (isEmptyValue(value)) return '';
  switch (column.type) {
    case 'number': {
      const n = parseNumber(value);
      return n === null ? String(value) : formatNumber(n);
    }
    case 'money': {
      const n = parseNumber(value);
      return n === null ? String(value) : formatMoney(n, column.currency);
    }
    case 'percent': {
      const n = parseNumber(value);
      return n === null ? String(value) : formatPercent(n);
    }
    case 'date': {
      const key = dayKey(value);
      return key ? formatDay(key) : String(value);
    }
    case 'datetime': {
      if (typeof value === 'string' && DAY_RE.test(value.trim())) return formatDay(value);
      return typeof value === 'string' ? formatDateTime(value) : String(value);
    }
    case 'select':
    case 'status':
      return optionLabel(column, value);
    case 'multi_select':
      return asList(value)
        .map((v) => optionLabel(column, v))
        .join(', ');
    case 'boolean': {
      const b = asBoolean(value);
      return b === null ? String(value) : b ? 'Sí' : 'No';
    }
    case 'person':
      return personName(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** Lo que va dentro del campo al empezar a editar. */
export function editorText(column: GridColumn, value: unknown): string {
  if (isEmptyValue(value)) return '';
  switch (column.type) {
    case 'number':
    case 'money':
    case 'percent': {
      const n = parseNumber(value);
      return n === null ? String(value) : String(n).replace('.', ',');
    }
    case 'date':
      return dayKey(value) ?? '';
    case 'datetime':
      return toLocalInput(value);
    case 'multi_select':
      return asList(value).join(', ');
    case 'person':
      return personName(value);
    case 'boolean':
      return asBoolean(value) ? 'Sí' : 'No';
    default:
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// Entender lo que alguien escribió
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function matchOption(column: GridColumn, raw: string): GridOption | undefined {
  const f = foldText(raw);
  return column.options?.find((o) => foldText(o.value) === f || foldText(o.label ?? '') === f);
}

/**
 * Lo que alguien tecleó (o pegó, o vino en un CSV) → el valor que se guarda.
 * Vacío es `null`, salvo que la columna sea obligatoria.
 */
export function parseInput(column: GridColumn, raw: unknown): ParseResult {
  const label = column.label;
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    if (column.required) return { ok: false, error: `«${label}» no puede quedar vacío.` };
    return { ok: true, value: null };
  }
  if (Array.isArray(raw) && raw.length === 0) {
    if (column.required) return { ok: false, error: `«${label}» no puede quedar vacío.` };
    return { ok: true, value: column.type === 'multi_select' ? [] : null };
  }
  const text = typeof raw === 'string' ? raw.trim() : raw;
  switch (column.type) {
    case 'number':
    case 'money':
    case 'percent': {
      const n = parseNumber(text);
      if (n === null) return { ok: false, error: `«${label}» tiene que ser un número.` };
      return { ok: true, value: n };
    }
    case 'date': {
      const d = typeof text === 'string' ? parseDay(text) : dayKey(text);
      if (!d) return { ok: false, error: `«${label}» tiene que ser una fecha (día/mes/año).` };
      return { ok: true, value: d };
    }
    case 'datetime': {
      const d = typeof text === 'string' ? parseDateTime(text) : null;
      if (!d) return { ok: false, error: `«${label}» tiene que ser una fecha con hora.` };
      return { ok: true, value: d };
    }
    case 'select':
    case 'status': {
      const s = String(text);
      if (!column.options?.length) return { ok: true, value: s };
      const option = matchOption(column, s);
      if (!option)
        return {
          ok: false,
          error: `«${label}» tiene que ser una de: ${column.options.map((o) => o.label ?? o.value).join(', ')}.`,
        };
      return { ok: true, value: option.value };
    }
    case 'multi_select': {
      const list = asList(text);
      if (!column.options?.length) return { ok: true, value: list };
      const out: string[] = [];
      for (const item of list) {
        const option = matchOption(column, item);
        if (!option) return { ok: false, error: `«${item}» no es una opción de «${label}».` };
        if (!out.includes(option.value)) out.push(option.value);
      }
      return { ok: true, value: out };
    }
    case 'boolean': {
      const b = asBoolean(text);
      if (b === null) return { ok: false, error: `«${label}» es sí o no.` };
      return { ok: true, value: b };
    }
    case 'email': {
      const s = String(text).toLowerCase();
      if (!EMAIL_RE.test(s)) return { ok: false, error: `«${s}» no parece un correo.` };
      return { ok: true, value: s };
    }
    case 'link': {
      let s = String(text);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
      try {
        const url = new URL(s);
        if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:')
          return { ok: false, error: 'Solo enlaces http, https o mailto.' };
        return { ok: true, value: url.toString() };
      } catch {
        return { ok: false, error: `«${String(text)}» no parece un enlace.` };
      }
    }
    case 'phone': {
      const s = String(text);
      if (!/^[+\d][\d\s().-]{5,24}$/.test(s))
        return { ok: false, error: `«${s}» no parece un teléfono.` };
      return { ok: true, value: s.replace(/\s+/g, ' ') };
    }
    case 'person':
      return { ok: true, value: personName(text) };
    default: {
      const s = typeof text === 'string' ? text : String(text);
      if (s.length > 4000) return { ok: false, error: `«${label}» es demasiado largo.` };
      return { ok: true, value: s };
    }
  }
}

/** Un enlace que se puede abrir, o `null` si el valor no da para uno. */
export function hrefFor(column: GridColumn, value: unknown): string | null {
  if (isEmptyValue(value)) return null;
  const s = String(value).trim();
  if (column.type === 'email') return EMAIL_RE.test(s) ? `mailto:${s}` : null;
  if (column.type === 'phone') {
    const digits = s.replace(/[^\d+]/g, '');
    return digits.length >= 6 ? `tel:${digits}` : null;
  }
  if (column.type === 'link') {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Texto plano para buscar: lo que se ve más la forma cruda, sin tildes. */
export function searchText(column: GridColumn, value: unknown): string {
  if (isEmptyValue(value)) return '';
  const shown = formatValue(column, value);
  if (isNumericType(column.type)) {
    const n = parseNumber(value);
    return foldText(`${shown} ${n ?? ''}`);
  }
  if (column.type === 'date' || column.type === 'datetime')
    return foldText(`${shown} ${dayKey(value) ?? ''}`);
  return foldText(shown);
}
