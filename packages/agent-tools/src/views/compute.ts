import type { TrackerField } from '../trackers/schema';
import {
  type Aggregate,
  type CatalogTracker,
  type Tone,
  type ViewBlock,
  type ViewFilter,
  type ViewSpec,
  fieldType,
} from './spec';

/**
 * DE SPEC A PANTALLA, SIN RED Y SIN REACT.
 *
 * `computeView` recibe el spec, las tablas y sus filas ya leídas, y devuelve
 * cada bloque con sus números resueltos y sus textos ya formateados. Es una
 * función pura a propósito:
 *
 *   - la misma salida sirve a la vista dentro de la app, al enlace público y a
 *     la vista previa del editor, que pinta un spec que todavía no se guardó;
 *   - el componente que pinta es tonto y puede vivir en el cliente sin
 *     importar el barril de `@cortex/agent-tools` (que arrastra `node:dns`);
 *   - se prueba con filas de mentira, sin base.
 *
 * Lo que sale de aquí es JSON plano. Ningún bloque devuelve filas que su spec
 * no pidió: una tabla con tres columnas entrega tres columnas, no la fila
 * entera, porque este objeto viaja hasta el navegador de alguien sin cuenta.
 */

export const VIEW_TIMEZONE = 'America/Bogota';

export interface ViewRow {
  id: string;
  label: string;
  values: Record<string, string | number>;
  created_at: string;
  updated_at: string;
}

export interface ViewSource {
  tracker: CatalogTracker;
  rows: ViewRow[];
  /** True cuando la lectura se cortó en el tope y hay más filas. */
  truncated: boolean;
}

export type ValueFormat = 'number' | 'money' | 'percent';

interface BlockBase {
  id: string;
  width: 'full' | 'half' | 'third';
}

export type ComputedBlock =
  | (BlockBase & { type: 'text'; markdown: string })
  | (BlockBase & {
      type: 'metric';
      title: string;
      value: number | null;
      display: string;
      rows: number;
      goal: { value: number; display: string; ratio: number } | null;
      tone: Tone;
      caption: string | null;
      source: string;
    })
  | (BlockBase & {
      type: 'table';
      title: string;
      columns: Array<{ key: string; label: string; kind: 'text' | 'number' | 'date' }>;
      rows: Array<{ id: string; cells: string[]; sort: Array<string | number | null> }>;
      total: number;
      searchable: boolean;
      source: string;
    })
  | (BlockBase & {
      type: 'chart';
      title: string;
      chart: 'bar' | 'line' | 'donut';
      points: Array<{ label: string; value: number; display: string }>;
      total: string;
      tone: Tone;
      source: string;
    })
  | (BlockBase & {
      type: 'board';
      title: string;
      columns: Array<{
        key: string;
        label: string;
        count: number;
        cards: Array<{
          id: string;
          label: string;
          details: Array<{ label: string; value: string }>;
        }>;
      }>;
      source: string;
    })
  | (BlockBase & {
      type: 'form';
      title: string;
      intro: string | null;
      tracker: string;
      submitLabel: string;
      successMessage: string;
      fields: Array<{
        key: string;
        label: string;
        type: TrackerField['type'];
        required: boolean;
        options: string[];
      }>;
    })
  | (BlockBase & { type: 'problem'; title: string; message: string });

export interface ComputedView {
  blocks: ComputedBlock[];
  computedAt: string;
  /** Tablas cuya lectura se cortó en el tope: las cifras son parciales. */
  partial: string[];
}

// ---------------------------------------------------------------------------
// Fechas en Bogotá
// ---------------------------------------------------------------------------

export function todayIn(now: Date, tz = VIEW_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOf(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : todayIn(new Date(t));
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function viewShortDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const MONEY = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function formatValue(value: number | null, format: ValueFormat): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (format === 'money') return MONEY.format(value);
  if (format === 'percent') return `${NUMBER.format(value)} %`;
  return NUMBER.format(value);
}

function rawValue(row: ViewRow, key: string): string | number | undefined {
  if (key === 'label') return row.label;
  if (key === 'created_at') return dayOf(row.created_at) ?? undefined;
  if (key === 'updated_at') return dayOf(row.updated_at) ?? undefined;
  const v = row.values[key];
  return v === '' ? undefined : v;
}

function displayValue(tracker: CatalogTracker, row: ViewRow, key: string): string {
  const v = rawValue(row, key);
  if (v === undefined) return '—';
  const type = fieldType(tracker, key);
  if (type === 'money') return formatValue(Number(v), 'money');
  if (type === 'number') return formatValue(Number(v), 'number');
  if (
    (type === 'date' || type === 'builtin_date') &&
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v)
  )
    return viewShortDate(v);
  return String(v);
}

function fieldLabel(tracker: CatalogTracker, key: string): string {
  if (key === 'label') return 'Nombre';
  if (key === 'created_at') return 'Creado';
  if (key === 'updated_at') return 'Actualizado';
  return tracker.fields.find((f) => f.key === key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Filtros y agregados
// ---------------------------------------------------------------------------

export function matches(
  tracker: CatalogTracker,
  row: ViewRow,
  filter: ViewFilter,
  today: string,
): boolean {
  const v = rawValue(row, filter.field);
  const type = fieldType(tracker, filter.field);
  const isNumeric = type === 'number' || type === 'money';
  const isDate = type === 'date' || type === 'builtin_date';

  switch (filter.op) {
    case 'empty':
      return v === undefined;
    case 'not_empty':
      return v !== undefined;
    case 'eq':
    case 'neq': {
      const equal =
        v !== undefined &&
        (isNumeric
          ? Number(v) === Number(filter.value)
          : String(v).trim().toLowerCase() === String(filter.value).trim().toLowerCase());
      return filter.op === 'eq' ? equal : !equal;
    }
    case 'contains':
      return (
        v !== undefined &&
        String(v).toLowerCase().includes(String(filter.value).trim().toLowerCase())
      );
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (v === undefined) return false;
      const cmp = isNumeric
        ? Number(v) - Number(filter.value)
        : String(v).localeCompare(String(filter.value));
      if (Number.isNaN(cmp)) return false;
      if (filter.op === 'gt') return cmp > 0;
      if (filter.op === 'gte') return cmp >= 0;
      if (filter.op === 'lt') return cmp < 0;
      return cmp <= 0;
    }
    case 'before_today':
    case 'after_today':
    case 'next_days':
    case 'last_days': {
      if (!isDate || typeof v !== 'string') return false;
      const day = dayOf(v);
      if (!day) return false;
      if (filter.op === 'before_today') return day < today;
      if (filter.op === 'after_today') return day > today;
      const n = Math.max(0, Math.floor(Number(filter.value)));
      if (filter.op === 'next_days') return day >= today && day <= addDays(today, n);
      return day <= today && day >= addDays(today, -n);
    }
  }
}

export function aggregate(rows: ViewRow[], agg: Aggregate, field?: string): number | null {
  if (agg === 'count') return rows.length;
  if (!field) return null;
  const nums = rows
    .map((r) => r.values[field])
    .filter((v) => v !== undefined && v !== '')
    .map(Number)
    .filter(Number.isFinite);
  if (nums.length === 0) return agg === 'sum' ? 0 : null;
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === 'min') return Math.min(...nums);
  return Math.max(...nums);
}

function formatOf(tracker: CatalogTracker, field: string | undefined, fallback: ValueFormat) {
  if (fallback !== 'number' || !field) return fallback;
  return fieldType(tracker, field) === 'money' ? 'money' : 'number';
}

function bucketOf(day: string, bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'day') return day;
  if (bucket === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T12:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

function bucketLabel(key: string, bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'month') {
    const [y, m] = key.split('-');
    return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  return bucket === 'week' ? `sem. ${viewShortDate(key)}` : viewShortDate(key);
}

// ---------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------

function problem(block: ViewBlock, message: string): ComputedBlock {
  return {
    type: 'problem',
    id: block.id,
    width: block.width,
    title: 'title' in block ? block.title : 'Bloque',
    message,
  };
}

function computeBlock(
  block: ViewBlock,
  sources: Map<string, ViewSource>,
  today: string,
): ComputedBlock {
  if (block.type === 'text') {
    return { type: 'text', id: block.id, width: block.width, markdown: block.markdown };
  }
  const src = sources.get(block.tracker);
  if (!src) return problem(block, `La tabla «${block.tracker}» ya no existe en este espacio.`);
  const { tracker } = src;
  const missing = [
    ...('filters' in block ? block.filters.map((f) => f.field) : []),
    ...(block.type === 'table'
      ? [...block.columns, ...(block.sort ? [block.sort.field] : [])]
      : []),
    ...(block.type === 'chart' || block.type === 'board' ? [block.groupBy] : []),
    ...(block.type === 'board' ? block.cardFields : []),
    ...(block.type === 'form' ? block.fields : []),
    ...((block.type === 'metric' || block.type === 'chart') && block.field ? [block.field] : []),
  ].filter((key) => !fieldType(tracker, key));
  if (missing.length) {
    return problem(
      block,
      `${tracker.name} ya no tiene ${missing.length === 1 ? 'el campo' : 'los campos'} ${missing.map((m) => `«${m}»`).join(', ')}. Pídele a Cortex que ajuste este bloque.`,
    );
  }

  const rows =
    'filters' in block && block.filters.length
      ? src.rows.filter((r) => block.filters.every((f) => matches(tracker, r, f, today)))
      : src.rows;

  switch (block.type) {
    case 'metric': {
      const format = formatOf(tracker, block.field, block.format);
      const value = aggregate(rows, block.aggregate, block.field);
      return {
        type: 'metric',
        id: block.id,
        width: block.width,
        title: block.title,
        value,
        display: formatValue(value, format),
        rows: rows.length,
        goal:
          block.goal !== undefined && block.goal !== 0
            ? {
                value: block.goal,
                display: formatValue(block.goal, format),
                ratio: value === null ? 0 : value / block.goal,
              }
            : null,
        tone: block.tone,
        caption: block.caption ?? null,
        source: tracker.name,
      };
    }

    case 'table': {
      const keys = block.columns.length
        ? block.columns
        : ['label', ...tracker.fields.slice(0, 5).map((f) => f.key)];
      const sortKey = block.sort?.field ?? 'updated_at';
      const dir = block.sort?.dir === 'asc' ? 1 : -1;
      const sortType = fieldType(tracker, sortKey);
      const numericSort = sortType === 'number' || sortType === 'money';
      const sorted = [...rows].sort((a, b) => {
        const va = rawValue(a, sortKey);
        const vb = rawValue(b, sortKey);
        if (va === undefined && vb === undefined) return 0;
        if (va === undefined) return 1;
        if (vb === undefined) return -1;
        const cmp = numericSort
          ? Number(va) - Number(vb)
          : String(va).localeCompare(String(vb), 'es');
        return cmp * dir;
      });
      return {
        type: 'table',
        id: block.id,
        width: block.width,
        title: block.title,
        columns: keys.map((key) => {
          const t = fieldType(tracker, key);
          return {
            key,
            label: fieldLabel(tracker, key),
            kind:
              t === 'number' || t === 'money'
                ? 'number'
                : t === 'date' || t === 'builtin_date'
                  ? 'date'
                  : 'text',
          };
        }),
        rows: sorted.slice(0, block.limit).map((r) => ({
          id: r.id,
          cells: keys.map((key) => displayValue(tracker, r, key)),
          sort: keys.map((key) => {
            const v = rawValue(r, key);
            return v === undefined ? null : v;
          }),
        })),
        total: rows.length,
        searchable: block.searchable,
        source: tracker.name,
      };
    }

    case 'chart': {
      const format = formatOf(tracker, block.field, block.format);
      const type = fieldType(tracker, block.groupBy);
      const isDate = type === 'date' || type === 'builtin_date';
      const groups = new Map<string, ViewRow[]>();
      for (const r of rows) {
        const v = rawValue(r, block.groupBy);
        let key: string;
        if (isDate) {
          const day = typeof v === 'string' ? dayOf(v) : null;
          if (!day) continue;
          key = bucketOf(day, block.bucket);
        } else {
          key = v === undefined ? 'Sin dato' : String(v);
        }
        const list = groups.get(key);
        if (list) list.push(r);
        else groups.set(key, [r]);
      }
      let entries = [...groups.entries()].map(([key, list]) => ({
        key,
        list,
        value: aggregate(list, block.aggregate, block.field) ?? 0,
      }));
      if (isDate) {
        entries.sort((a, b) => a.key.localeCompare(b.key));
        entries = entries.slice(-block.limit);
      } else if (type === 'select') {
        const order = tracker.fields.find((f) => f.key === block.groupBy)?.options ?? [];
        entries.sort((a, b) => {
          const ia = order.indexOf(a.key);
          const ib = order.indexOf(b.key);
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
        entries = entries.slice(0, block.limit);
      } else {
        entries.sort((a, b) => b.value - a.value);
        if (
          entries.length > block.limit &&
          (block.aggregate === 'count' || block.aggregate === 'sum')
        ) {
          const head = entries.slice(0, block.limit - 1);
          const rest = entries.slice(block.limit - 1).flatMap((e) => e.list);
          entries = [
            ...head,
            { key: 'Otros', list: rest, value: aggregate(rest, block.aggregate, block.field) ?? 0 },
          ];
        } else entries = entries.slice(0, block.limit);
      }
      const total = aggregate(rows, block.aggregate, block.field);
      return {
        type: 'chart',
        id: block.id,
        width: block.width,
        title: block.title,
        chart: block.chart,
        points: entries.map((e) => ({
          label: isDate ? bucketLabel(e.key, block.bucket) : e.key,
          value: e.value,
          display: formatValue(e.value, format),
        })),
        total: formatValue(total, format),
        tone: block.tone,
        source: tracker.name,
      };
    }

    case 'board': {
      const options = tracker.fields.find((f) => f.key === block.groupBy)?.options ?? [];
      const details = block.cardFields.length
        ? block.cardFields
        : tracker.fields
            .filter((f) => f.key !== block.groupBy)
            .slice(0, 2)
            .map((f) => f.key);
      const buckets = new Map<string, ViewRow[]>(options.map((o) => [o, []]));
      const loose: ViewRow[] = [];
      for (const r of rows) {
        const v = rawValue(r, block.groupBy);
        const list = v === undefined ? undefined : buckets.get(String(v));
        if (list) list.push(r);
        else loose.push(r);
      }
      const columns = [...buckets.entries()].map(([key, list]) => ({ key, label: key, list }));
      if (loose.length) columns.push({ key: '__none', label: 'Sin estado', list: loose });
      return {
        type: 'board',
        id: block.id,
        width: block.width,
        title: block.title,
        columns: columns.map((c) => ({
          key: c.key,
          label: c.label,
          count: c.list.length,
          cards: c.list.slice(0, block.limit).map((r) => ({
            id: r.id,
            label: r.label,
            details: details
              .map((key) => ({
                label: fieldLabel(tracker, key),
                value: displayValue(tracker, r, key),
              }))
              .filter((d) => d.value !== '—'),
          })),
        })),
        source: tracker.name,
      };
    }

    case 'form': {
      const keys = block.fields.length ? block.fields : tracker.fields.map((f) => f.key);
      return {
        type: 'form',
        id: block.id,
        width: block.width,
        title: block.title,
        intro: block.intro ?? null,
        tracker: tracker.slug,
        submitLabel: block.submitLabel,
        successMessage: block.successMessage,
        fields: keys
          .map((key) => tracker.fields.find((f) => f.key === key))
          .filter((f): f is TrackerField => Boolean(f))
          .map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            options: f.options ?? [],
          })),
      };
    }
  }
}

export function computeView(
  spec: ViewSpec,
  sources: Map<string, ViewSource>,
  now: Date = new Date(),
): ComputedView {
  const today = todayIn(now);
  return {
    blocks: spec.blocks.map((block) => computeBlock(block, sources, today)),
    computedAt: now.toISOString(),
    partial: [...sources.values()].filter((s) => s.truncated).map((s) => s.tracker.name),
  };
}
