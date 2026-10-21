import type { GridColumn, GridColumnType, GridOption } from '@/components/datagrid/types';
import {
  DAY_RE,
  dayKey,
  foldText,
  formatDateTime,
  formatDay,
  formatMoney,
  formatNumber,
  formatPercent,
  isEmptyValue,
  parseDateTime,
  parseDay,
  parseNumber,
  toLocalInput,
} from '@cortex/agent-tools/src/format/display';

// Una sola casa para cifras y fechas: la grilla reexporta lo que vive en el paquete.
export * from '@cortex/agent-tools/src/format/display';

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
