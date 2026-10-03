import type {
  GridColumn,
  GridColumnType,
  GridFilter,
  GridFilterOp,
  GridLayout,
  GridRow,
  GridSort,
  GridView,
} from '@/components/datagrid/types';
import {
  COLLATOR,
  addDays,
  asBoolean,
  asList,
  bogotaDay,
  dayKey,
  foldText,
  formatMonth,
  formatValue,
  isEmptyValue,
  isNumericType,
  optionLabel,
  parseNumber,
  searchText,
  timeValue,
} from './format';

/**
 * EL MOTOR DE UNA VISTA: buscar, filtrar, ordenar y agrupar, sin pantalla.
 *
 * Puro a propósito: la grilla lo corre en el navegador para listas que caben
 * enteras, y el servidor lo corre igual (`onQuery`) para las que no, así que
 * una vista guardada da las mismas filas en los dos lados.
 *
 * Reglas que una persona espera sin decirlas:
 *   - Buscar ignora tildes y mayúsculas («bogota» encuentra «Bogotá»).
 *   - Ordenar texto usa el orden del español (la ñ después de la n, números
 *     dentro del texto en orden numérico: «Guía 2» antes de «Guía 10»).
 *   - Lo vacío va al final, se ordene como se ordene.
 *   - Un filtro a medio llenar (sin valor) no filtra todavía.
 */

// ---------------------------------------------------------------------------
// Operadores por tipo
// ---------------------------------------------------------------------------

export type OperatorSpec = { op: GridFilterOp; label: string };

const TEXT_OPS: OperatorSpec[] = [
  { op: 'contains', label: 'contiene' },
  { op: 'not_contains', label: 'no contiene' },
  { op: 'eq', label: 'es' },
  { op: 'neq', label: 'no es' },
  { op: 'empty', label: 'está vacío' },
  { op: 'not_empty', label: 'tiene valor' },
];
const NUMBER_OPS: OperatorSpec[] = [
  { op: 'eq', label: '=' },
  { op: 'neq', label: '≠' },
  { op: 'gt', label: 'mayor que' },
  { op: 'gte', label: 'mayor o igual a' },
  { op: 'lt', label: 'menor que' },
  { op: 'lte', label: 'menor o igual a' },
  { op: 'between', label: 'entre' },
  { op: 'empty', label: 'está vacío' },
  { op: 'not_empty', label: 'tiene valor' },
];
const DATE_OPS: OperatorSpec[] = [
  { op: 'eq', label: 'es el día' },
  { op: 'before', label: 'antes de' },
  { op: 'after', label: 'después de' },
  { op: 'between', label: 'entre' },
  { op: 'last_days', label: 'en los últimos … días' },
  { op: 'next_days', label: 'en los próximos … días' },
  { op: 'empty', label: 'está vacío' },
  { op: 'not_empty', label: 'tiene valor' },
];
const OPTION_OPS: OperatorSpec[] = [
  { op: 'in', label: 'es alguno de' },
  { op: 'not_in', label: 'no es ninguno de' },
  { op: 'empty', label: 'está vacío' },
  { op: 'not_empty', label: 'tiene valor' },
];
const MULTI_OPS: OperatorSpec[] = [
  { op: 'in', label: 'tiene alguno de' },
  { op: 'not_in', label: 'no tiene ninguno de' },
  { op: 'empty', label: 'está vacío' },
  { op: 'not_empty', label: 'tiene valor' },
];
const BOOLEAN_OPS: OperatorSpec[] = [{ op: 'eq', label: 'es' }];

export function operatorsFor(type: GridColumnType): OperatorSpec[] {
  if (isNumericType(type)) return NUMBER_OPS;
  if (type === 'date' || type === 'datetime') return DATE_OPS;
  if (type === 'select' || type === 'status') return OPTION_OPS;
  if (type === 'multi_select') return MULTI_OPS;
  if (type === 'boolean') return BOOLEAN_OPS;
  return TEXT_OPS;
}

export function operatorLabel(type: GridColumnType, op: GridFilterOp): string {
  return operatorsFor(type).find((o) => o.op === op)?.label ?? op;
}

export function defaultOperator(type: GridColumnType): GridFilterOp {
  return operatorsFor(type)[0]?.op ?? 'contains';
}

export function operatorNeedsValue(op: GridFilterOp): boolean {
  return op !== 'empty' && op !== 'not_empty';
}

/** Si el filtro ya dice algo (tiene el valor que su operador pide). */
export function isActiveFilter(filter: GridFilter): boolean {
  if (!operatorNeedsValue(filter.op)) return true;
  const v = filter.value;
  if (filter.op === 'between') {
    if (!Array.isArray(v)) return false;
    return !isEmptyValue(v[0]) || !isEmptyValue(v[1]);
  }
  if (filter.op === 'in' || filter.op === 'not_in') return asList(v).length > 0;
  if (typeof v === 'boolean') return true;
  return !isEmptyValue(v);
}

// ---------------------------------------------------------------------------
// Filtrar
// ---------------------------------------------------------------------------

function compareText(column: GridColumn, value: unknown): string {
  return foldText(formatValue(column, value));
}

export function matchesFilter(
  column: GridColumn,
  value: unknown,
  filter: GridFilter,
  today: string,
): boolean {
  const { op } = filter;
  const empty = isEmptyValue(value);
  if (op === 'empty') return empty;
  if (op === 'not_empty') return !empty;
  const type = column.type;

  if (isNumericType(type)) {
    const n = parseNumber(value);
    if (op === 'between') {
      const [lo, hi] = Array.isArray(filter.value) ? filter.value : [];
      const a = parseNumber(lo);
      const b = parseNumber(hi);
      if (n === null) return false;
      return (a === null || n >= a) && (b === null || n <= b);
    }
    const target = parseNumber(filter.value);
    if (target === null) return true;
    if (op === 'neq') return n === null || n !== target;
    if (n === null) return false;
    if (op === 'eq') return n === target;
    if (op === 'gt') return n > target;
    if (op === 'gte') return n >= target;
    if (op === 'lt') return n < target;
    if (op === 'lte') return n <= target;
    return true;
  }

  if (type === 'date' || type === 'datetime') {
    const day = dayKey(value);
    if (op === 'last_days' || op === 'next_days') {
      const n = parseNumber(filter.value);
      if (n === null || !day) return false;
      const days = Math.max(0, Math.round(n));
      return op === 'last_days'
        ? day >= addDays(today, -days) && day <= today
        : day >= today && day <= addDays(today, days);
    }
    if (op === 'between') {
      const [lo, hi] = Array.isArray(filter.value) ? filter.value : [];
      const a = dayKey(lo);
      const b = dayKey(hi);
      if (!day) return false;
      return (!a || day >= a) && (!b || day <= b);
    }
    const target = dayKey(filter.value);
    if (!target) return true;
    if (op === 'neq') return day !== target;
    if (!day) return false;
    if (op === 'eq') return day === target;
    if (op === 'before' || op === 'lt') return day < target;
    if (op === 'after' || op === 'gt') return day > target;
    if (op === 'lte') return day <= target;
    if (op === 'gte') return day >= target;
    return true;
  }

  if (type === 'select' || type === 'status' || type === 'multi_select') {
    const have = type === 'multi_select' ? asList(value) : empty ? [] : [String(value)];
    const want = asList(filter.value);
    if (op === 'in' || op === 'eq' || op === 'contains')
      return want.length === 0 || have.some((v) => want.includes(v));
    if (op === 'not_in' || op === 'neq' || op === 'not_contains')
      return !have.some((v) => want.includes(v));
    return true;
  }

  if (type === 'boolean') {
    const want = asBoolean(filter.value);
    if (want === null) return true;
    const have = asBoolean(value) ?? false;
    return op === 'neq' ? have !== want : have === want;
  }

  // Texto, enlaces, correos, teléfonos, personas.
  const needle = foldText(String(filter.value ?? ''));
  const hay = compareText(column, value);
  if (op === 'contains') return hay.includes(needle);
  if (op === 'not_contains') return !hay.includes(needle);
  if (op === 'eq') return hay === needle;
  if (op === 'neq') return hay !== needle;
  if (op === 'in') return asList(filter.value).some((v) => foldText(v) === hay);
  if (op === 'not_in') return !asList(filter.value).some((v) => foldText(v) === hay);
  return true;
}

// ---------------------------------------------------------------------------
// Ordenar
// ---------------------------------------------------------------------------

/** Compara dos valores no vacíos de una columna. */
export function compareValues(column: GridColumn, a: unknown, b: unknown): number {
  const type = column.type;
  if (isNumericType(type)) return (parseNumber(a) ?? 0) - (parseNumber(b) ?? 0);
  if (type === 'date' || type === 'datetime') return (timeValue(a) ?? 0) - (timeValue(b) ?? 0);
  if ((type === 'select' || type === 'status') && column.options?.length) {
    const ia = column.options.findIndex((o) => o.value === String(a));
    const ib = column.options.findIndex((o) => o.value === String(b));
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  }
  if (type === 'boolean') return Number(asBoolean(a) ?? false) - Number(asBoolean(b) ?? false);
  return COLLATOR.compare(formatValue(column, a), formatValue(column, b));
}

export function sortRows(rows: GridRow[], columns: GridColumn[], sort: GridSort[]): GridRow[] {
  const keys = sort
    .map((s) => ({ s, col: columns.find((c) => c.key === s.key) }))
    .filter((k): k is { s: GridSort; col: GridColumn } => Boolean(k.col));
  if (!keys.length) return rows;
  const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((x, y) => {
    for (const { s, col } of keys) {
      const a = x.row.values[col.key];
      const b = y.row.values[col.key];
      const ea = isEmptyValue(a);
      const eb = isEmptyValue(b);
      if (ea && eb) continue;
      if (ea) return 1;
      if (eb) return -1;
      const c = compareValues(col, a, b);
      if (c !== 0) return s.dir === 'desc' ? -c : c;
    }
    return x.i - y.i;
  });
  return indexed.map((x) => x.row);
}

// ---------------------------------------------------------------------------
// Agrupar
// ---------------------------------------------------------------------------

export interface GridGroup {
  /** Clave estable del grupo ('' = sin valor). */
  key: string;
  label: string;
  /** Un valor crudo representativo: lo que se escribe al mover algo a este grupo. */
  value: unknown;
  rows: GridRow[];
}

export const EMPTY_GROUP_LABEL = 'Sin valor';

export function groupKeyOf(
  column: GridColumn,
  value: unknown,
): { key: string; label: string; value: unknown } {
  if (isEmptyValue(value)) return { key: '', label: EMPTY_GROUP_LABEL, value: null };
  const type = column.type;
  if (type === 'date' || type === 'datetime') {
    const day = dayKey(value);
    if (!day) return { key: '', label: EMPTY_GROUP_LABEL, value: null };
    const month = day.slice(0, 7);
    const label = formatMonth(month);
    return { key: month, label: label.charAt(0).toUpperCase() + label.slice(1), value: day };
  }
  if (type === 'select' || type === 'status')
    return { key: String(value), label: optionLabel(column, value), value: String(value) };
  if (type === 'multi_select') {
    const list = asList(value);
    return {
      key: list.join('\u0001'),
      label: list.map((v) => optionLabel(column, v)).join(', '),
      value: list,
    };
  }
  if (type === 'boolean') {
    const b = asBoolean(value) ?? false;
    return { key: b ? '1' : '0', label: b ? 'Sí' : 'No', value: b };
  }
  if (isNumericType(type)) {
    const n = parseNumber(value);
    return { key: String(n), label: formatValue(column, value), value: n };
  }
  const shown = formatValue(column, value);
  return { key: foldText(shown), label: shown, value };
}

export function groupRows(
  rows: GridRow[],
  column: GridColumn,
  dir: 'asc' | 'desc' = 'asc',
): GridGroup[] {
  const map = new Map<string, GridGroup>();
  for (const row of rows) {
    const g = groupKeyOf(column, row.values[column.key]);
    let group = map.get(g.key);
    if (!group) {
      group = { key: g.key, label: g.label, value: g.value, rows: [] };
      map.set(g.key, group);
    }
    group.rows.push(row);
  }
  const groups = [...map.values()];
  const type = column.type;
  groups.sort((a, b) => {
    if (a.key === '' && b.key !== '') return 1;
    if (b.key === '' && a.key !== '') return -1;
    let c: number;
    if ((type === 'select' || type === 'status') && column.options?.length) {
      c = compareValues(column, a.value, b.value);
    } else if (isNumericType(type)) {
      c = (parseNumber(a.value) ?? 0) - (parseNumber(b.value) ?? 0);
    } else if (type === 'date' || type === 'datetime' || type === 'boolean') {
      c = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    } else {
      c = COLLATOR.compare(a.label, b.label);
    }
    return dir === 'desc' ? -c : c;
  });
  return groups;
}

/** Para el tablero: una columna por opción, aunque esté vacía, y «Sin valor» al final. */
export function boardGroups(rows: GridRow[], column: GridColumn): GridGroup[] {
  const groups = groupRows(rows, column);
  if (!column.options?.length) return groups;
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const out: GridGroup[] = column.options.map(
    (o) =>
      byKey.get(o.value) ?? { key: o.value, label: o.label ?? o.value, value: o.value, rows: [] },
  );
  for (const g of groups) if (!out.some((o) => o.key === g.key)) out.push(g);
  return out;
}

// ---------------------------------------------------------------------------
// La vista completa
// ---------------------------------------------------------------------------

export const EMPTY_VIEW: GridView = {
  filters: [],
  match: 'all',
  sort: [],
  groupBy: null,
  hidden: [],
  layout: 'table',
  search: '',
};

const LAYOUTS: GridLayout[] = ['table', 'board', 'cards', 'calendar'];

/** Una vista completa a partir de una parcial, sin claves que no existen. */
export function normalizeView(columns: GridColumn[], partial?: Partial<GridView> | null): GridView {
  const keys = new Set(columns.map((c) => c.key));
  const p = partial ?? {};
  const pinned = new Set(columns.filter((c) => c.pinned).map((c) => c.key));
  const view: GridView = {
    ...(p.id ? { id: p.id } : {}),
    ...(p.name ? { name: p.name } : {}),
    search: typeof p.search === 'string' ? p.search : '',
    filters: (Array.isArray(p.filters) ? p.filters : []).filter(
      (f) => f && typeof f === 'object' && keys.has(f.key) && typeof f.op === 'string',
    ),
    match: p.match === 'any' ? 'any' : 'all',
    sort: (Array.isArray(p.sort) ? p.sort : [])
      .filter((s) => s && keys.has(s.key))
      .map((s) => ({ key: s.key, dir: s.dir === 'desc' ? 'desc' : 'asc' }) as GridSort),
    groupBy: p.groupBy && keys.has(p.groupBy) ? p.groupBy : null,
    hidden: (Array.isArray(p.hidden) ? p.hidden : []).filter((k) => keys.has(k) && !pinned.has(k)),
    layout: p.layout && LAYOUTS.includes(p.layout) ? p.layout : 'table',
    layoutKey: p.layoutKey && keys.has(p.layoutKey) ? p.layoutKey : null,
  };
  if (Array.isArray(p.order)) view.order = p.order.filter((k) => keys.has(k));
  if (p.widths && typeof p.widths === 'object') {
    const widths: Record<string, number> = {};
    for (const [k, w] of Object.entries(p.widths))
      if (keys.has(k) && typeof w === 'number' && w >= 48 && w <= 1200) widths[k] = Math.round(w);
    if (Object.keys(widths).length) view.widths = widths;
  }
  if (p.aggregates && typeof p.aggregates === 'object') {
    const ag: NonNullable<GridView['aggregates']> = {};
    for (const [k, a] of Object.entries(p.aggregates))
      if (keys.has(k) && ['sum', 'avg', 'min', 'max', 'count', 'none'].includes(a)) ag[k] = a;
    if (Object.keys(ag).length) view.aggregates = ag;
  }
  if (typeof p.shared === 'boolean') view.shared = p.shared;
  if (typeof p.canManage === 'boolean') view.canManage = p.canManage;
  return view;
}

/** Las columnas en el orden de la vista; las nuevas (que la vista no conoce) al final. */
export function orderedColumns(columns: GridColumn[], view: Pick<GridView, 'order'>): GridColumn[] {
  const order = view.order ?? [];
  if (!order.length) return columns;
  const rank = new Map(order.map((k, i) => [k, i]));
  const pinned = columns.filter((c) => c.pinned);
  const rest = columns
    .filter((c) => !c.pinned)
    .map((c, i) => ({ c, r: rank.get(c.key) ?? order.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
  return [...pinned, ...rest];
}

export function visibleColumns(columns: GridColumn[], view: GridView): GridColumn[] {
  const hidden = new Set(view.hidden);
  return orderedColumns(columns, view).filter((c) => c.pinned || !hidden.has(c.key));
}

export interface ApplyViewResult {
  rows: GridRow[];
  groups: GridGroup[] | null;
  /** Filas antes de filtrar. */
  total: number;
}

/** Un índice de búsqueda por fila: lo que se ve en cada celda, sin tildes. */
export function buildSearchIndex(rows: GridRow[], columns: GridColumn[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    let text = '';
    for (const col of columns) {
      const t = searchText(col, row.values[col.key]);
      if (t) text += `${t}\u0001`;
    }
    index.set(row.id, text);
  }
  return index;
}

export function applyView(
  rows: GridRow[],
  columns: GridColumn[],
  view: Partial<GridView>,
  opts: { now?: Date; searchIndex?: Map<string, string> } = {},
): ApplyViewResult {
  const today = bogotaDay(opts.now ?? new Date());
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const filters = (view.filters ?? []).filter((f) => byKey.has(f.key) && isActiveFilter(f));
  const terms = foldText(view.search ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const any = view.match === 'any';

  let out = rows;
  if (filters.length || terms.length) {
    out = rows.filter((row) => {
      if (terms.length) {
        const hay =
          opts.searchIndex?.get(row.id) ??
          columns.map((c) => searchText(c, row.values[c.key])).join('\u0001');
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      if (!filters.length) return true;
      const test = (f: GridFilter) => {
        const col = byKey.get(f.key);
        return col ? matchesFilter(col, row.values[f.key], f, today) : true;
      };
      return any ? filters.some(test) : filters.every(test);
    });
  }

  const sorted = sortRows(out, columns, view.sort ?? []);
  const groupCol = view.groupBy ? byKey.get(view.groupBy) : undefined;
  if (!groupCol) return { rows: sorted, groups: null, total: rows.length };
  const groupSort = view.sort?.find((s) => s.key === groupCol.key);
  const groups = groupRows(sorted, groupCol, groupSort?.dir ?? 'asc');
  return { rows: groups.flatMap((g) => g.rows), groups, total: rows.length };
}

/** Cuántos filtros dicen algo, para el contador del botón. */
export function activeFilterCount(view: Pick<GridView, 'filters'>): number {
  return view.filters.filter(isActiveFilter).length;
}

/** Una frase corta de un filtro: «Estado es alguno de En tránsito, Novedad». */
export function describeFilter(column: GridColumn, filter: GridFilter): string {
  const op = operatorLabel(column.type, filter.op);
  if (!operatorNeedsValue(filter.op)) return `${column.label} ${op}`;
  const v = filter.value;
  let shown: string;
  if (filter.op === 'between' && Array.isArray(v)) {
    const [a, b] = v;
    shown = `${isEmptyValue(a) ? '…' : formatValue(column, a)} y ${isEmptyValue(b) ? '…' : formatValue(column, b)}`;
  } else if (filter.op === 'in' || filter.op === 'not_in') {
    shown = asList(v)
      .map((x) => optionLabel(column, x))
      .join(', ');
  } else if (filter.op === 'last_days' || filter.op === 'next_days') {
    return `${column.label} en los ${filter.op === 'last_days' ? 'últimos' : 'próximos'} ${String(v)} días`;
  } else if (column.type === 'boolean') {
    shown = asBoolean(v) ? 'Sí' : 'No';
  } else {
    shown = formatValue(column, v) || String(v ?? '');
  }
  return `${column.label} ${op} ${shown}`;
}
