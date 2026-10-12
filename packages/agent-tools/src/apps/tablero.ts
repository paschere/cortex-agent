import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { type ViewRow, type ViewSource, aggregate, formatValue, matches } from '../views/compute';
import { optionTones, todayIn, viewShortDate } from '../views/compute';
import {
  type CatalogTracker,
  type ViewFilter,
  type ViewSpec,
  fieldType,
  filterSchema,
  isReadOnlySource,
  viewSpecSchema,
} from '../views/spec';
import { loadViewSources } from '../views/store';
import { resolveFilterTokens } from './appearance';
import { type ResolvedRole, canSeeScreen, rowScopeFor } from './permissions';
import type { AppAccess } from './store';

/**
 * LOS TABLEROS DE UNA APP, POR ROL (migración 0225).
 *
 * Un «Tablero» es una pantalla sintética —como el Inicio (0215), no es una
 * vista guardada— hecha de widgets que se calculan al abrirla con el rol de
 * quien mira:
 *
 *   - `kpi`: una cifra grande (tipografía de serie) con su micrográfico y el
 *     cambio contra el período anterior;
 *   - `chart`: una métrica por día con rangos, comparar, zoom y, al tocar un
 *     punto, los registros de ESA tabla (los de la app, ya con el scope del rol);
 *   - `status`: cómo se reparten las filas por estado o por cualquier campo de
 *     opciones (la barra segmentada del flujo);
 *   - `ranking`: las categorías que más pesan (por persona, cliente, ciudad…);
 *   - `pending`: «mis pendientes» o lo atrasado, con enlace a cada registro.
 *
 * EL SCOPE VA PRIMERO. Las filas entran por `loadViewSources` con el scope del
 * rol (`rowScopeFor`): lo que el rol no puede leer nunca llega al mapa, y un
 * widget sobre una tabla sin permiso de lectura NO aparece (ni el título ni la
 * cifra). Nada de lo que sigue —filtros, agregados, series, registros— vuelve a
 * leer la base. `computeTableroFromSources` es una función pura: se prueba con
 * filas en la mano.
 */

export const TABLERO_ROUTE_PREFIX = 'tab_';
export const MAX_TABLEROS = 6;
export const MAX_WIDGETS = 12;
export const TABLERO_TONES = ['primary', 'emerald', 'amber', 'sky', 'rose'] as const;
export type TableroTone = (typeof TABLERO_TONES)[number];
/** Cuántos días de historia lleva un widget `chart` (el rango más largo de MetricChart es 12 meses). */
export const CHART_DAYS = 400;
/** Cuántos registros viajan con un gráfico para abrir un punto. */
export const CHART_RECORDS = 400;

const idSchema = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Usa a-z, 0-9 y _ (empieza en letra).');
const sourceSchema = z.string().trim().min(1).max(100);
const fieldSchema = z.string().trim().min(1).max(40);
const widgetId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const titleSchema = z.string().trim().min(1).max(80);

const widgetBase = {
  id: widgetId,
  title: titleSchema,
  width: z.enum(['full', 'half', 'third']).optional(),
  /** Pantalla de la app que abre el widget (slug), si el rol la ve. */
  screen: z.string().trim().max(48).optional(),
};
const filters = z.array(filterSchema).max(6).default([]);

/** «Lo mío»: sólo las filas que creó quien mira, o las que lo nombran en un campo. */
export const mineSchema = z.union([
  z.object({ by: z.literal('creator') }),
  z.object({ by: z.literal('field'), field: fieldSchema }),
]);
export type Mine = z.infer<typeof mineSchema>;

export const kpiWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('kpi'),
  source: sourceSchema,
  filters,
  mine: mineSchema.optional(),
  aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max']).default('count'),
  field: fieldSchema.optional(),
  format: z.enum(['number', 'money', 'percent']).optional(),
  /** `all` = todo lo que cumple los filtros, sin período ni cambio (un saldo, lo abierto). */
  period: z.enum(['day', 'week', 'month', 'all']).default('month'),
  dateField: fieldSchema.optional(),
  goodWhen: z.enum(['up', 'down']).default('up'),
  goal: z.number().finite().optional(),
  tone: z.enum(TABLERO_TONES).default('primary'),
});

export const chartWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('chart'),
  source: sourceSchema,
  filters,
  mine: mineSchema.optional(),
  aggregate: z.enum(['count', 'sum']).default('count'),
  field: fieldSchema.optional(),
  format: z.enum(['number', 'money']).optional(),
  dateField: fieldSchema.optional(),
  goodWhen: z.enum(['up', 'down']).default('up'),
  tone: z.enum(TABLERO_TONES).default('primary'),
  /** Con qué palabra se llaman los registros al abrir un punto («guías», «facturas»). */
  noun: z.string().trim().max(30).optional(),
});

export const statusWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('status'),
  source: sourceSchema,
  filters,
  mine: mineSchema.optional(),
  /** Campo de opciones (el estado del flujo, la prioridad…). */
  field: fieldSchema,
});

export const rankingWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('ranking'),
  source: sourceSchema,
  filters,
  mine: mineSchema.optional(),
  groupBy: fieldSchema,
  aggregate: z.enum(['count', 'sum']).default('count'),
  field: fieldSchema.optional(),
  format: z.enum(['number', 'money']).optional(),
  limit: z.number().int().min(2).max(10).default(6),
  tone: z.enum(TABLERO_TONES).default('primary'),
});

export const pendingWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('pending'),
  source: sourceSchema,
  filters,
  mine: mineSchema.optional(),
  /** Fecha que vence: lo anterior a hoy sale marcado «atrasado» y va primero. */
  dateField: fieldSchema.optional(),
  /** Campo que da el segundo renglón de cada fila (cliente, ubicación…). */
  subtitleField: fieldSchema.optional(),
  limit: z.number().int().min(1).max(10).default(5),
  emptyText: z.string().trim().max(120).optional(),
});

export const widgetSchema = z.discriminatedUnion('kind', [
  kpiWidgetSchema,
  chartWidgetSchema,
  statusWidgetSchema,
  rankingWidgetSchema,
  pendingWidgetSchema,
]);
export type Widget = z.infer<typeof widgetSchema>;
export type WidgetKind = Widget['kind'];

export const tableroSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().max(160).default(''),
    /** Claves de los roles que lo ven. Vacío = todos (cada uno con SUS filas). */
    roles: z.array(z.string().trim().max(48)).max(8).default([]),
    widgets: z.array(widgetSchema).max(MAX_WIDGETS).default([]),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    for (const [i, w] of t.widgets.entries()) {
      if (seen.has(w.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `El id de widget «${w.id}» está repetido.`,
          path: ['widgets', i, 'id'],
        });
      seen.add(w.id);
    }
  });
export type Tablero = z.infer<typeof tableroSchema>;

export const tablerosSchema = z
  .array(tableroSchema)
  .max(MAX_TABLEROS)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [i, t] of list.entries()) {
      if (seen.has(t.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `El tablero «${t.id}» está repetido.`,
          path: [i, 'id'],
        });
      seen.add(t.id);
    }
  });

/** Lo guardado: lo que no pasa el contrato se descarta tablero por tablero (nunca tumba la app). */
export function parseTableros(raw: unknown): Tablero[] {
  if (!Array.isArray(raw)) return [];
  const out: Tablero[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = tableroSchema.safeParse(item);
    if (parsed.success && !seen.has(parsed.data.id) && out.length < MAX_TABLEROS) {
      seen.add(parsed.data.id);
      out.push(parsed.data);
    }
  }
  return out;
}

export function tableroSlug(t: Pick<Tablero, 'id'>): string {
  return `${TABLERO_ROUTE_PREFIX}${t.id}`;
}

/** El id de tablero de una ruta `tab_<id>`, o null. */
export function tableroIdOfRoute(ref: string | null | undefined): string | null {
  return ref?.startsWith(TABLERO_ROUTE_PREFIX) ? ref.slice(TABLERO_ROUTE_PREFIX.length) : null;
}

// ---------------------------------------------------------------------------
// Validación contra lo que existe
// ---------------------------------------------------------------------------

export interface TableroCatalog {
  trackers: CatalogTracker[];
  screenSlugs: string[];
  roleKeys: string[];
}

function sourceOf(w: Widget): string {
  return w.source;
}

const NUMERIC_TYPES = new Set(['number', 'money']);
const DATE_TYPES = new Set(['date', 'builtin_date']);

/**
 * Los problemas de un conjunto de tableros frente al catálogo real: una lista
 * de frases para quien edita (vacía = todo existe). zod ya garantizó la FORMA;
 * esto garantiza que la forma habla de cosas que existen.
 */
export function tableroProblems(tableros: Tablero[], catalog: TableroCatalog): string[] {
  const out: string[] = [];
  const bySlug = new Map(catalog.trackers.map((t) => [t.slug, t]));
  const screens = new Set(catalog.screenSlugs);
  const roles = new Set(catalog.roleKeys);
  for (const t of tableros) {
    for (const r of t.roles)
      if (!roles.has(r)) out.push(`El tablero «${t.title}» nombra un rol que no existe: «${r}».`);
    for (const w of t.widgets) {
      const where = `«${t.title}» › «${w.title}»`;
      const tracker = bySlug.get(sourceOf(w));
      if (!tracker) {
        out.push(`${where}: la tabla «${w.source}» no existe.`);
        continue;
      }
      const needField = (key: string | undefined, label: string) => {
        if (key && fieldType(tracker, key) === null)
          out.push(`${where}: ${label} «${key}» no existe en «${tracker.name}».`);
      };
      for (const f of w.filters) needField(f.field, 'el campo del filtro');
      if (w.mine?.by === 'field') needField(w.mine.field, 'el campo de «lo mío»');
      if (w.kind === 'status') {
        needField(w.field, 'el campo');
        const type = fieldType(tracker, w.field);
        if (type && type !== 'select')
          out.push(
            `${where}: «${w.field}» no es un campo de opciones (el estado se reparte por uno).`,
          );
      }
      if (w.kind === 'ranking') needField(w.groupBy, 'el campo');
      if (w.kind === 'kpi' || w.kind === 'chart' || w.kind === 'ranking') {
        needField(w.field, 'el campo');
        const sums = w.aggregate !== 'count';
        if (sums && !w.field) out.push(`${where}: ${w.aggregate} necesita un campo.`);
        if (sums && w.field) {
          const type = fieldType(tracker, w.field);
          if (type && !NUMERIC_TYPES.has(type))
            out.push(`${where}: «${w.field}» no es numérico para ${w.aggregate}.`);
        }
      }
      if ('dateField' in w && w.dateField) {
        needField(w.dateField, 'la fecha');
        const type = fieldType(tracker, w.dateField);
        if (type && !DATE_TYPES.has(type) && type !== 'text')
          out.push(`${where}: «${w.dateField}» no es una fecha.`);
      }
      if ('subtitleField' in w) needField(w.subtitleField, 'el campo');
      if (w.screen && !screens.has(w.screen))
        out.push(`${where}: abre la pantalla «${w.screen}», que no existe en la app.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Qué ve cada rol
// ---------------------------------------------------------------------------

/** Los tableros que ESTE rol ve. El administrador: todos. */
export function tablerosForRole(
  tableros: Tablero[],
  role: Pick<ResolvedRole, 'key' | 'admin'>,
): Tablero[] {
  return tableros.filter((t) => role.admin || t.roles.length === 0 || t.roles.includes(role.key));
}

/** Las tablas que nombra un tablero (sin repetir). */
export function tableroSources(t: Tablero): string[] {
  return [...new Set(t.widgets.map(sourceOf))];
}

/** Un spec sintético que sólo NOMBRA las tablas: lo que `loadViewSources` necesita para leerlas con scope. */
export function tableroSourcesSpec(t: Tablero): ViewSpec | null {
  return namingSpec(tableroSources(t));
}

export function namingSpec(sources: string[]): ViewSpec | null {
  if (!sources.length) return null;
  const parsed = viewSpecSchema.safeParse({
    version: 1,
    accent: 'primary',
    refreshSeconds: 0,
    editing: 'off',
    alerts: [],
    blocks: sources.map((tracker, i) => ({
      id: `s${i}`,
      type: 'table',
      title: 'fuente',
      tracker,
      limit: 1,
    })),
  });
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Resultado calculado (todo serializable: viaja al navegador tal cual)
// ---------------------------------------------------------------------------

export interface DayPointOut {
  date: string;
  value: number;
}

export interface DrillRecordOut {
  id: string;
  date: string;
  title: string;
  subtitle: string | null;
  amount: number;
  tone?: 'emerald' | 'rose' | 'amber' | 'primary' | 'ink';
  href: string | null;
}

export interface ChartMetricOut {
  id: string;
  label: string;
  fmt: 'money' | 'count';
  currency: string;
  unit?: string;
  kind: 'flow';
  tone: TableroTone;
  goodWhenUp: boolean;
  daily: DayPointOut[];
  records: DrillRecordOut[];
  recordsNoun?: string;
  fullHref?: string;
  fullLabel?: string;
}

interface WidgetOut {
  id: string;
  title: string;
  width: 'full' | 'half' | 'third';
  /** Enlace a la pantalla de origen, sólo si el rol la ve. */
  href: string | null;
}

export type ComputedWidget =
  | (WidgetOut & {
      kind: 'kpi';
      tone: TableroTone;
      value: number | null;
      display: string;
      format: 'number' | 'money' | 'percent';
      periodLabel: string | null;
      /** Cambio relativo contra el período anterior; null = sin base o sin período. */
      deltaRatio: number | null;
      hasDelta: boolean;
      goodWhenUp: boolean;
      series: number[];
      labels: string[];
      goal: { value: number; display: string; reached: boolean } | null;
    })
  | (WidgetOut & { kind: 'chart'; metric: ChartMetricOut })
  | (WidgetOut & {
      kind: 'status';
      total: number;
      segments: Array<{ key: string; label: string; value: number; tone: TableroTone }>;
    })
  | (WidgetOut & {
      kind: 'ranking';
      tone: TableroTone;
      format: 'number' | 'money';
      items: Array<{ label: string; value: number; display: string }>;
    })
  | (WidgetOut & {
      kind: 'pending';
      total: number;
      emptyText: string;
      items: Array<{
        id: string;
        title: string;
        subtitle: string | null;
        due: string | null;
        overdue: boolean;
        href: string | null;
      }>;
    });

export interface ComputedTablero {
  id: string;
  title: string;
  description: string;
  today: string;
  computedAt: string;
  widgets: ComputedWidget[];
}

export interface TableroContext {
  now: Date;
  /** Quien mira: para «lo mío». */
  user: { id: string; name: string; external?: boolean };
  /** `/apps/<slug>` o `/a/<id>`: las pantallas se abren bajo esta base. */
  basePath: string;
  /** Pantallas de la app que el rol ve (slug): un enlace a otra no se ofrece. */
  visibleScreens: ReadonlySet<string>;
}

const ROLE_ADMIN = (role: Pick<ResolvedRole, 'admin'>) => role.admin;

// ---------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------

function rowDay(row: ViewRow, field: string | undefined): string | null {
  const key = field ?? 'created_at';
  const raw =
    key === 'created_at'
      ? row.created_at
      : key === 'updated_at'
        ? row.updated_at
        : key === 'label'
          ? row.label
          : row.values[key];
  if (typeof raw !== 'string' || !raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : todayIn(new Date(t));
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type Period = 'day' | 'week' | 'month';

function periodKey(day: string, period: Period): string {
  if (period === 'day') return day;
  if (period === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T12:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

function shiftPeriod(key: string, period: Period, n: number): string {
  if (period === 'day') return addDays(key, n);
  if (period === 'week') return addDays(key, n * 7);
  const [y, m] = key.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function periodLabel(key: string, period: Period): string {
  if (period === 'month') {
    const [y, m] = key.split('-');
    return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  return period === 'week' ? `sem. ${viewShortDate(key)}` : viewShortDate(key);
}

const SERIES_LENGTH: Record<Period, number> = { day: 14, week: 12, month: 12 };
const PERIOD_TEXT: Record<Period, string> = {
  day: 'hoy vs. ayer',
  week: 'esta semana vs. la anterior',
  month: 'este mes vs. el anterior',
};

/** `{hoy}` y compañía en los filtros, y los filtros de «lo mío». */
export function rowsFor(
  source: ViewSource,
  w: { filters: ViewFilter[]; mine?: Mine },
  ctx: Pick<TableroContext, 'now' | 'user'>,
): ViewRow[] {
  const today = todayIn(ctx.now);
  const filters = resolveFilterTokens(w.filters, ctx.now);
  const name = ctx.user.name.trim().toLowerCase();
  return source.rows.filter((row) => {
    if (!filters.every((f) => matches(source.tracker, row, f, today))) return false;
    if (!w.mine) return true;
    if (w.mine.by === 'creator')
      return ctx.user.external
        ? row.created_by_app_user === ctx.user.id
        : row.created_by === ctx.user.id;
    const v = String(row.values[w.mine.field] ?? '')
      .trim()
      .toLowerCase();
    return v !== '' && (v === ctx.user.id.toLowerCase() || v === name);
  });
}

function formatOfWidget(
  tracker: CatalogTracker,
  w: { format?: 'number' | 'money' | 'percent'; aggregate?: string; field?: string },
): 'number' | 'money' | 'percent' {
  if (w.format) return w.format;
  if (w.aggregate && w.aggregate !== 'count' && w.field && fieldType(tracker, w.field) === 'money')
    return 'money';
  return 'number';
}

function hrefOf(ctx: TableroContext, screen: string | undefined, rowId?: string): string | null {
  if (!screen || !ctx.visibleScreens.has(screen)) return null;
  return `${ctx.basePath}/${screen}${rowId ? `?fila=${encodeURIComponent(rowId)}` : ''}`;
}

export function cellText(tracker: CatalogTracker, row: ViewRow, key: string): string {
  if (key === 'label') return row.label;
  const v = row.values[key];
  if (v === undefined || v === '') return '';
  const type = fieldType(tracker, key);
  if (type === 'checkbox') return Number(v) === 1 ? 'Sí' : 'No';
  if (type === 'money') return formatValue(Number(v), 'money');
  return String(v);
}

function computeKpi(
  w: z.infer<typeof kpiWidgetSchema>,
  source: ViewSource,
  ctx: TableroContext,
): ComputedWidget {
  const rows = rowsFor(source, w, ctx);
  const format = formatOfWidget(source.tracker, w);
  const today = todayIn(ctx.now);
  const base: WidgetOut = {
    id: w.id,
    title: w.title,
    width: w.width ?? 'third',
    href: hrefOf(ctx, w.screen),
  };
  const goalOut = (value: number | null) =>
    w.goal === undefined
      ? null
      : {
          value: w.goal,
          display: formatValue(w.goal, format),
          reached: value !== null && (w.goodWhen === 'down' ? value <= w.goal : value >= w.goal),
        };
  if (w.period === 'all') {
    const value = aggregate(rows, w.aggregate, w.field);
    return {
      ...base,
      kind: 'kpi',
      tone: w.tone,
      value,
      display: formatValue(value, format),
      format,
      periodLabel: null,
      deltaRatio: null,
      hasDelta: false,
      goodWhenUp: w.goodWhen === 'up',
      series: [],
      labels: [],
      goal: goalOut(value),
    };
  }
  const period = w.period;
  const buckets = new Map<string, ViewRow[]>();
  for (const row of rows) {
    const day = rowDay(row, w.dateField);
    if (!day) continue;
    const key = periodKey(day, period);
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }
  const current = periodKey(today, period);
  const keys = Array.from({ length: SERIES_LENGTH[period] }, (_, i) =>
    shiftPeriod(current, period, i - (SERIES_LENGTH[period] - 1)),
  );
  const at = (key: string) => aggregate(buckets.get(key) ?? [], w.aggregate, w.field);
  const series = keys.map((k) => Math.round((at(k) ?? 0) * 100) / 100);
  const value = at(current) ?? 0;
  const prev = at(shiftPeriod(current, period, -1)) ?? 0;
  const deltaRatio = prev === 0 ? (value === 0 ? 0 : null) : (value - prev) / Math.abs(prev);
  return {
    ...base,
    kind: 'kpi',
    tone: w.tone,
    value,
    display: formatValue(value, format),
    format,
    periodLabel: PERIOD_TEXT[period],
    deltaRatio,
    hasDelta: true,
    goodWhenUp: w.goodWhen === 'up',
    series: series.some((v) => v !== 0) ? series : [],
    labels: keys.map((k) => periodLabel(k, period)),
    goal: goalOut(value),
  };
}

function computeChart(
  w: z.infer<typeof chartWidgetSchema>,
  source: ViewSource,
  ctx: TableroContext,
): ComputedWidget {
  const rows = rowsFor(source, w, ctx);
  const today = todayIn(ctx.now);
  const from = addDays(today, -(CHART_DAYS - 1));
  const money = formatOfWidget(source.tracker, w) === 'money';
  const byDay = new Map<string, number>();
  const records: DrillRecordOut[] = [];
  const dated = rows
    .map((row) => ({ row, day: rowDay(row, w.dateField) }))
    .filter((x): x is { row: ViewRow; day: string } => x.day !== null && x.day >= from);
  for (const { row, day } of dated) {
    const raw = w.aggregate === 'count' ? 1 : Number(row.values[w.field ?? '']);
    const amount = Number.isFinite(raw) ? raw : 0;
    byDay.set(day, (byDay.get(day) ?? 0) + amount);
  }
  dated.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  for (const { row, day } of dated.slice(0, CHART_RECORDS)) {
    const raw = w.aggregate === 'count' ? 1 : Number(row.values[w.field ?? '']);
    const subtitleKey = source.tracker.fields.find(
      (f) => f.type === 'select' || f.type === 'text',
    )?.key;
    records.push({
      id: row.id,
      date: day,
      title: row.label || '—',
      subtitle: subtitleKey ? cellText(source.tracker, row, subtitleKey) || null : null,
      amount: Number.isFinite(raw) ? raw : 0,
      href: hrefOf(ctx, w.screen, row.id),
    });
  }
  const daily = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, value]) => ({ date, value }));
  const metric: ChartMetricOut = {
    id: w.id,
    label: w.title,
    fmt: money ? 'money' : 'count',
    currency: 'COP',
    ...(money ? {} : { unit: w.noun ?? 'registros' }),
    kind: 'flow',
    tone: w.tone,
    goodWhenUp: w.goodWhen === 'up',
    daily,
    records,
    ...(w.noun ? { recordsNoun: w.noun } : {}),
    ...(hrefOf(ctx, w.screen)
      ? { fullHref: hrefOf(ctx, w.screen) as string, fullLabel: 'Ver la pantalla' }
      : {}),
  };
  return {
    id: w.id,
    title: w.title,
    width: w.width ?? 'full',
    href: hrefOf(ctx, w.screen),
    kind: 'chart',
    metric,
  };
}

function computeStatus(
  w: z.infer<typeof statusWidgetSchema>,
  source: ViewSource,
  ctx: TableroContext,
): ComputedWidget {
  const rows = rowsFor(source, w, ctx);
  const options = source.tracker.fields.find((f) => f.key === w.field)?.options ?? [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const v = String(row.values[w.field] ?? '').trim();
    const key = v || 'Sin estado';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = [...options, ...[...counts.keys()].filter((k) => !options.includes(k))];
  const tones = optionTones(order);
  const segments = order
    .map((label, i) => ({
      key: label,
      label,
      value: counts.get(label) ?? 0,
      tone: (tones[i] ?? 'primary') as TableroTone,
    }))
    .filter((s) => s.value > 0);
  return {
    id: w.id,
    title: w.title,
    width: w.width ?? 'half',
    href: hrefOf(ctx, w.screen),
    kind: 'status',
    total: rows.length,
    segments,
  };
}

function computeRanking(
  w: z.infer<typeof rankingWidgetSchema>,
  source: ViewSource,
  ctx: TableroContext,
): ComputedWidget {
  const rows = rowsFor(source, w, ctx);
  const format = formatOfWidget(source.tracker, w) === 'money' ? 'money' : 'number';
  const groups = new Map<string, number>();
  for (const row of rows) {
    const label = cellText(source.tracker, row, w.groupBy).trim() || 'Sin dato';
    const raw = w.aggregate === 'count' ? 1 : Number(row.values[w.field ?? '']);
    groups.set(label, (groups.get(label) ?? 0) + (Number.isFinite(raw) ? raw : 0));
  }
  const items = [...groups.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
    .slice(0, w.limit)
    .map(([label, value]) => ({ label, value, display: formatValue(value, format) }));
  return {
    id: w.id,
    title: w.title,
    width: w.width ?? 'half',
    href: hrefOf(ctx, w.screen),
    kind: 'ranking',
    tone: w.tone,
    format,
    items,
  };
}

function computePending(
  w: z.infer<typeof pendingWidgetSchema>,
  source: ViewSource,
  ctx: TableroContext,
): ComputedWidget {
  const rows = rowsFor(source, w, ctx);
  const today = todayIn(ctx.now);
  const withDue = rows.map((row) => ({
    row,
    due: w.dateField ? rowDay(row, w.dateField) : null,
  }));
  withDue.sort((a, b) => {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due) return -1;
    if (b.due) return 1;
    return a.row.updated_at < b.row.updated_at ? 1 : -1;
  });
  return {
    id: w.id,
    title: w.title,
    width: w.width ?? 'half',
    href: hrefOf(ctx, w.screen),
    kind: 'pending',
    total: rows.length,
    emptyText: w.emptyText ?? 'Todo al día',
    items: withDue.slice(0, w.limit).map(({ row, due }) => ({
      id: row.id,
      title: row.label || '—',
      subtitle: w.subtitleField ? cellText(source.tracker, row, w.subtitleField) || null : null,
      due: due ? viewShortDate(due) : null,
      overdue: Boolean(due && due < today),
      href: hrefOf(ctx, w.screen, row.id),
    })),
  };
}

/**
 * El Tablero calculado a partir de fuentes YA leídas con el scope del rol.
 * Un widget cuya fuente no se leyó (sin permiso, bloqueada, borrada) se omite
 * entero: ni el título ni una cifra en cero.
 */
export function computeTableroFromSources(
  tablero: Tablero,
  sources: Map<string, ViewSource>,
  ctx: TableroContext,
): ComputedTablero {
  const widgets: ComputedWidget[] = [];
  for (const w of tablero.widgets) {
    const source = sources.get(w.source);
    if (!source || source.blocked) continue;
    switch (w.kind) {
      case 'kpi':
        widgets.push(computeKpi(w, source, ctx));
        break;
      case 'chart':
        widgets.push(computeChart(w, source, ctx));
        break;
      case 'status':
        widgets.push(computeStatus(w, source, ctx));
        break;
      case 'ranking':
        widgets.push(computeRanking(w, source, ctx));
        break;
      case 'pending':
        widgets.push(computePending(w, source, ctx));
        break;
    }
  }
  return {
    id: tablero.id,
    title: tablero.title,
    description: tablero.description,
    today: todayIn(ctx.now),
    computedAt: ctx.now.toISOString(),
    widgets,
  };
}

/** Lee con el scope del rol y calcula. La única función de este archivo que toca la base. */
export async function computeTablero(
  db: SupabaseClient,
  access: AppAccess,
  tablero: Tablero,
  options: { basePath: string; now?: Date } = { basePath: '' },
): Promise<ComputedTablero> {
  const now = options.now ?? new Date();
  const spec = tableroSourcesSpec(tablero);
  const sources = spec
    ? await loadViewSources(db, spec, {
        audience: ROLE_ADMIN(access.role) ? 'team' : 'public',
        viewerId: access.role.admin ? access.user.id : null,
        scope: rowScopeFor(access.role, access.user, spec),
      })
    : new Map<string, ViewSource>();
  return computeTableroFromSources(tablero, sources, {
    now,
    user: access.user,
    basePath: options.basePath,
    visibleScreens: new Set(
      access.screens.filter((s) => canSeeScreen(access.role, s.roles)).map((s) => s.slug),
    ),
  });
}

// ---------------------------------------------------------------------------
// Rutas y menú
// ---------------------------------------------------------------------------

/** Los tableros de este acceso (con el rol ya resuelto). */
export function tablerosOf(access: AppAccess): Tablero[] {
  return tablerosForRole(access.app.dashboards, access.role);
}

export function isTableroRoute(access: AppAccess, ref: string | null | undefined): boolean {
  const id = tableroIdOfRoute(ref);
  return Boolean(id && tablerosOf(access).some((t) => t.id === id));
}

export function tableroForRoute(access: AppAccess, ref: string | null | undefined): Tablero | null {
  const id = tableroIdOfRoute(ref);
  return id ? (tablerosOf(access).find((t) => t.id === id) ?? null) : null;
}

export function tableroNav(
  access: AppAccess,
): Array<{ slug: string; title: string; icon: string }> {
  return tablerosOf(access).map((t) => ({
    slug: tableroSlug(t),
    title: t.title,
    icon: 'BarChart3',
  }));
}

// ---------------------------------------------------------------------------
// Sugerencias: un tablero por rol
// ---------------------------------------------------------------------------

export type RoleProfile = 'operario' | 'supervisor' | 'gerencia' | 'cliente' | 'otro';

/** Qué papel juega un rol, por su clave o nombre. Es una pista para sugerir, nada más. */
export function roleProfileOf(role: { key: string; name: string }): RoleProfile {
  const text = `${role.key} ${role.name}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  if (/client|usuari|portal/.test(text)) return 'cliente';
  if (/super|jefe|coordin|lider|encargad|aprob/.test(text)) return 'supervisor';
  if (/geren|direc|dueno|socio|ejecut|admin|propiet|finanz|contab/.test(text)) return 'gerencia';
  if (/oper|campo|conduct|tecnic|vended|asesor|bodega|auxiliar|mensaj|registr/.test(text))
    return 'operario';
  return 'otro';
}

interface Shape {
  tracker: CatalogTracker;
  state: { key: string; options: string[]; closed: string | null } | null;
  due: string | null;
  money: string | null;
  group: string | null;
}

const CLOSED_RE =
  /entreg|cerrad|complet|termin|pagad|aprobad|resuelt|finaliz|hech|done|closed|paid/i;

function shapeOf(tracker: CatalogTracker): Shape {
  const select = tracker.fields.filter((f) => f.type === 'select' && f.options?.length);
  const stateField =
    select.find((f) => f.flow) ??
    select.find((f) => /estado|status|etapa/i.test(`${f.key} ${f.label}`)) ??
    select[0];
  const options = stateField?.options ?? [];
  const closed =
    options.find((o) => CLOSED_RE.test(o)) ?? (stateField?.flow ? (options.at(-1) ?? null) : null);
  const due = tracker.fields.find(
    (f) =>
      f.type === 'date' && /venc|entrega|limite|límite|prometid|due/i.test(`${f.key} ${f.label}`),
  )?.key;
  const money = tracker.fields.find((f) => f.type === 'money')?.key;
  const group =
    tracker.fields.find((f) => f.type === 'relation')?.key ??
    tracker.fields.find(
      (f) => f.type === 'select' && f.key !== stateField?.key && (f.options?.length ?? 0) > 1,
    )?.key ??
    tracker.fields.find(
      (f) =>
        f.type === 'text' &&
        /client|ciudad|sede|zona|ruta|persona|respons|asign|registrado/i.test(
          `${f.key} ${f.label}`,
        ),
    )?.key;
  return {
    tracker,
    state: stateField ? { key: stateField.key, options, closed } : null,
    due: due ?? null,
    money: money ?? null,
    group: group ?? null,
  };
}

const openFilter = (s: Shape): ViewFilter[] =>
  s.state?.closed ? [{ field: s.state.key, op: 'neq', value: s.state.closed }] : [];

function operarioTablero(s: Shape, roleKey: string, screen?: string): Tablero {
  const src = s.tracker.slug;
  const widgets: Widget[] = [
    {
      id: 'hoy',
      kind: 'kpi',
      title: 'Lo que registré hoy',
      source: src,
      filters: [],
      aggregate: 'count',
      period: 'day',
      goodWhen: 'up',
      tone: 'emerald',
      width: 'third',
      ...(screen ? { screen } : {}),
    },
    {
      id: 'semana',
      kind: 'kpi',
      title: 'Esta semana',
      source: src,
      filters: [],
      aggregate: 'count',
      period: 'week',
      goodWhen: 'up',
      tone: 'primary',
      width: 'third',
    },
    {
      id: 'abiertos',
      kind: 'kpi',
      title: 'Abiertos míos',
      source: src,
      filters: openFilter(s),
      aggregate: 'count',
      period: 'all',
      goodWhen: 'down',
      tone: 'amber',
      width: 'third',
    },
    {
      id: 'mis_pendientes',
      kind: 'pending',
      title: 'Mis pendientes',
      source: src,
      filters: openFilter(s),
      limit: 6,
      emptyText: 'No tienes nada pendiente',
      width: 'half',
      ...(s.due ? { dateField: s.due } : {}),
      ...(screen ? { screen } : {}),
    },
    {
      id: 'mis_dias',
      kind: 'chart',
      title: 'Mis registros por día',
      source: src,
      filters: [],
      aggregate: 'count',
      goodWhen: 'up',
      tone: 'emerald',
      width: 'half',
    },
  ];
  return tableroSchema.parse({
    id: `lo_mio_${roleKey}`.slice(0, 31),
    title: 'Lo mío hoy',
    description: 'Lo que hiciste y lo que te falta.',
    roles: [roleKey],
    widgets,
  });
}

function supervisorTablero(s: Shape, roleKey: string, screen?: string): Tablero {
  const src = s.tracker.slug;
  const widgets: Widget[] = [
    {
      id: 'abiertos',
      kind: 'kpi',
      title: 'Abiertos',
      source: src,
      filters: openFilter(s),
      aggregate: 'count',
      period: 'all',
      goodWhen: 'down',
      tone: 'amber',
      width: 'third',
    },
    ...(s.due
      ? ([
          {
            id: 'atrasados',
            kind: 'kpi',
            title: 'Atrasados',
            source: src,
            filters: [...openFilter(s), { field: s.due, op: 'before_today' }],
            aggregate: 'count',
            period: 'all',
            goodWhen: 'down',
            tone: 'rose',
            goal: 0,
            width: 'third',
          },
        ] as Widget[])
      : []),
    {
      id: 'semana',
      kind: 'kpi',
      title: 'Registros de la semana',
      source: src,
      filters: [],
      aggregate: 'count',
      period: 'week',
      goodWhen: 'up',
      tone: 'primary',
      width: 'third',
    },
    ...(s.state
      ? ([
          {
            id: 'por_estado',
            kind: 'status',
            title: 'Por estado',
            source: src,
            filters: [],
            field: s.state.key,
            width: 'half',
            ...(screen ? { screen } : {}),
          },
        ] as Widget[])
      : []),
    ...(s.group
      ? ([
          {
            id: 'por_grupo',
            kind: 'ranking',
            title: `Por ${s.tracker.fields.find((f) => f.key === s.group)?.label.toLowerCase() ?? 'grupo'}`,
            source: src,
            filters: [],
            groupBy: s.group,
            aggregate: 'count',
            limit: 6,
            tone: 'sky',
            width: 'half',
          },
        ] as Widget[])
      : []),
    {
      id: 'atrasos',
      kind: 'pending',
      title: s.due ? 'Lo atrasado' : 'Lo abierto',
      source: src,
      filters: s.due ? [...openFilter(s), { field: s.due, op: 'before_today' }] : openFilter(s),
      limit: 6,
      emptyText: 'Sin atrasos',
      width: 'half',
      ...(s.due ? { dateField: s.due } : {}),
      ...(screen ? { screen } : {}),
    },
    {
      id: 'ritmo',
      kind: 'chart',
      title: 'Registros del equipo por día',
      source: src,
      filters: [],
      aggregate: 'count',
      goodWhen: 'up',
      tone: 'primary',
      width: 'full',
      ...(screen ? { screen } : {}),
    },
  ];
  return tableroSchema.parse({
    id: `equipo_${roleKey}`.slice(0, 31),
    title: 'Equipo y atrasos',
    description: 'Cómo va el equipo y qué se está atrasando.',
    roles: [roleKey],
    widgets,
  });
}

function gerenciaTablero(s: Shape, roleKey: string, screen?: string): Tablero {
  const src = s.tracker.slug;
  const sumMoney = s.money !== null;
  const widgets: Widget[] = [
    {
      id: 'mes',
      kind: 'kpi',
      title: sumMoney ? 'Valor del mes' : 'Registros del mes',
      source: src,
      filters: [],
      aggregate: sumMoney ? 'sum' : 'count',
      ...(sumMoney ? { field: s.money as string, format: 'money' as const } : {}),
      period: 'month',
      goodWhen: 'up',
      tone: 'primary',
      width: 'third',
    },
    {
      id: 'mes_n',
      kind: 'kpi',
      title: 'Registros del mes',
      source: src,
      filters: [],
      aggregate: 'count',
      period: 'month',
      goodWhen: 'up',
      tone: 'sky',
      width: 'third',
    },
    ...(s.due
      ? ([
          {
            id: 'atrasados',
            kind: 'kpi',
            title: 'Atrasados',
            source: src,
            filters: [...openFilter(s), { field: s.due, op: 'before_today' }],
            aggregate: 'count',
            period: 'all',
            goodWhen: 'down',
            tone: 'rose',
            width: 'third',
          },
        ] as Widget[])
      : [
          {
            id: 'abiertos',
            kind: 'kpi',
            title: 'Abiertos',
            source: src,
            filters: openFilter(s),
            aggregate: 'count',
            period: 'all',
            goodWhen: 'down',
            tone: 'amber',
            width: 'third',
          } as Widget,
        ]),
    {
      id: 'evolucion',
      kind: 'chart',
      title: sumMoney ? 'Valor por día' : 'Registros por día',
      source: src,
      filters: [],
      aggregate: sumMoney ? 'sum' : 'count',
      ...(sumMoney ? { field: s.money as string, format: 'money' as const } : {}),
      goodWhen: 'up',
      tone: 'primary',
      width: 'full',
      ...(screen ? { screen } : {}),
    },
    ...(s.state
      ? ([
          {
            id: 'por_estado',
            kind: 'status',
            title: 'Cómo está lo que se mueve',
            source: src,
            filters: [],
            field: s.state.key,
            width: 'half',
          },
        ] as Widget[])
      : []),
    ...(s.group
      ? ([
          {
            id: 'ranking',
            kind: 'ranking',
            title: `Quién pesa más (${s.tracker.fields.find((f) => f.key === s.group)?.label.toLowerCase() ?? 'grupo'})`,
            source: src,
            filters: [],
            groupBy: s.group,
            aggregate: sumMoney ? 'sum' : 'count',
            ...(sumMoney ? { field: s.money as string, format: 'money' as const } : {}),
            limit: 6,
            tone: 'emerald',
            width: 'half',
          },
        ] as Widget[])
      : []),
  ];
  return tableroSchema.parse({
    id: `indicadores_${roleKey}`.slice(0, 31),
    title: 'Indicadores',
    description: 'Cómo va el negocio, mes contra mes.',
    roles: [roleKey],
    widgets,
  });
}

/**
 * Un tablero SUGERIDO por rol (operario: lo mío hoy; supervisor: equipo y
 * atrasos; gerencia: indicadores), armado sobre la tabla que más usan las
 * pantallas. Es una propuesta: se edita en la pestaña «Tableros». Los roles de
 * clientes (portal) no reciben tablero. Un rol sin papel claro recibe el de
 * operario si es el primero, o el de gerencia si es el último.
 */
export function suggestTableros(input: {
  /** La tabla principal primero (la que más pantallas leen). */
  trackers: CatalogTracker[];
  roles: Array<{ key: string; name: string }>;
  /** Slug de la pantalla donde se ven los registros, para que los widgets la abran. */
  screen?: string;
}): Tablero[] {
  const main = input.trackers.find((t) => !isReadOnlySource(t.slug));
  if (!main) return [];
  const shape = shapeOf(main);
  const out: Tablero[] = [];
  const roles = input.roles.filter((r) => roleProfileOf(r) !== 'cliente');
  const used = new Set<RoleProfile>();
  for (const [i, role] of roles.entries()) {
    let profile = roleProfileOf(role);
    if (profile === 'otro')
      profile = i === 0 ? 'operario' : i === roles.length - 1 ? 'gerencia' : 'supervisor';
    // Dos roles del mismo papel comparten el tablero: el segundo se suma a los roles del primero.
    const existing = out.find((t) =>
      t.id.startsWith(
        profile === 'operario' ? 'lo_mio_' : profile === 'supervisor' ? 'equipo_' : 'indicadores_',
      ),
    );
    if (existing && used.has(profile)) {
      existing.roles.push(role.key);
      continue;
    }
    used.add(profile);
    out.push(
      profile === 'operario'
        ? operarioTablero(shape, role.key, input.screen)
        : profile === 'supervisor'
          ? supervisorTablero(shape, role.key, input.screen)
          : gerenciaTablero(shape, role.key, input.screen),
    );
  }
  return out.slice(0, MAX_TABLEROS);
}

/** Una línea por tablero, para el chat y el resumen de la app. */
export function describeTableros(tableros: Tablero[]): string[] {
  return tableros.map(
    (t) =>
      `«${t.title}» (${t.roles.length ? t.roles.join(', ') : 'todos los roles'}): ${t.widgets.length} widgets`,
  );
}
