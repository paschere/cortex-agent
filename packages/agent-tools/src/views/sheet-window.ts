/**
 * LA VENTANA DE LA HOJA: «sólo las más recientes, y hacia el pasado con botones».
 *
 * Una hoja con `window` no trae toda la tabla: trae los últimos N días o meses
 * (o los últimos N grupos, p. ej. manifiestos) y el resto se pide a pedido,
 * bloque a bloque. Este archivo es PURO (sin base, sin barril): lo importan el
 * servidor (la carga y el cálculo), el navegador (los textos y el parámetro) y
 * las pruebas.
 *
 * Reglas que no se negocian:
 *  - Un grupo se muestra COMPLETO: si un manifiesto tiene guías dentro y fuera
 *    de la ventana, entran todas, para que los subtotales digan la verdad.
 *  - La fecha de una fila es la del campo de la ventana; si la fila no la tiene,
 *    la de creación (nunca queda una fila fuera de toda ventana).
 *  - «Hasta dónde llegué» (`reach`) es lo único que el navegador recuerda: una
 *    fecha de inicio (`2026-08-01`), un atajo (`7d`, `30d`, `90d`, `year`,
 *    `all`) o, en las ventanas por grupos, `g<N>` (cuántos grupos).
 */

export const WINDOW_MAX_GROUPS = 500;
/** Tope duro de filas que una hoja con ventana trae (ventana + grupos completos). */
export const WINDOW_ROW_CAP = 10_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SheetWindowSpec {
  /** Campo de fecha que ordena; vacío = `created_at`. */
  field?: string;
  /** `30d` (días) o `3m` (meses). */
  size?: string;
  /** Alternativa a `size`: cuántos grupos por bloque. */
  groups?: number;
}

export type WindowSize =
  | { kind: 'days'; n: number }
  | { kind: 'months'; n: number }
  | { kind: 'groups'; n: number };

/** El tamaño que dice el spec (`size` o `groups`); por omisión, 30 días. */
export function parseWindowSize(w: Pick<SheetWindowSpec, 'size' | 'groups'>): WindowSize {
  if (w.groups && w.groups > 0) return { kind: 'groups', n: Math.min(w.groups, WINDOW_MAX_GROUPS) };
  const m = /^(\d{1,3})([dm])$/.exec(w.size ?? '');
  if (m) {
    const n = Math.max(1, Number(m[1]));
    return m[2] === 'm' ? { kind: 'months', n: Math.min(n, 36) } : { kind: 'days', n: Math.min(n, 365) };
  }
  return { kind: 'days', n: 30 };
}

// ---------------------------------------------------------------------------
// Fechas (días ISO, sin zona: la que importa es la de Bogotá, ya resuelta arriba)
// ---------------------------------------------------------------------------

export function windowAddDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonthsIso(day: string, months: number): string {
  const d = new Date(`${day.slice(0, 8)}01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** El día de Bogotá de un instante (ISO con hora) o el mismo día si ya es un día. */
export function windowBogotaDay(value: string): string | null {
  if (DAY_RE.test(value)) return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t - 5 * 3600_000).toISOString().slice(0, 10);
}

/** Primer día de la ventana que termina en `anchor` (incluido). */
export function windowStart(anchor: string, size: WindowSize): string {
  if (size.kind === 'days') return windowAddDays(anchor, -(size.n - 1));
  if (size.kind === 'months') return addMonthsIso(anchor, -(size.n - 1));
  return anchor;
}

/** La fecha de una fila para la ventana: el campo si trae un día, si no la de creación. */
export function windowDateOf(
  row: { values: Record<string, string | number>; created_at: string },
  field: string,
): string | null {
  if (field !== 'created_at' && field !== 'updated_at') {
    const v = row.values[field];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return windowBogotaDay(row.created_at);
}

// ---------------------------------------------------------------------------
// Alcance pedido
// ---------------------------------------------------------------------------

export type Reach =
  | { kind: 'from'; from: string }
  | { kind: 'all' }
  | { kind: 'groups'; n: number };

/** Atajos del selector rápido; `g<N>` cuenta grupos. Lo demás se descarta. */
export function parseReach(raw: string | null | undefined, today: string): Reach | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t === 'all') return { kind: 'all' };
  if (t === 'year') return { kind: 'from', from: `${today.slice(0, 4)}-01-01` };
  const g = /^g(\d{1,4})$/.exec(t);
  if (g) return { kind: 'groups', n: Math.min(Math.max(1, Number(g[1])), WINDOW_MAX_GROUPS * 20) };
  const d = /^(\d{1,4})d$/.exec(t);
  if (d) return { kind: 'from', from: windowAddDays(today, -(Math.max(1, Number(d[1])) - 1)) };
  if (DAY_RE.test(t) && t >= '1990-01-01' && t <= windowAddDays(today, 1))
    return { kind: 'from', from: t };
  return null;
}

/** Inicio del primer bloque (el que se ve al abrir). */
export function initialReach(size: WindowSize, today: string): Reach {
  return size.kind === 'groups'
    ? { kind: 'groups', n: size.n }
    : { kind: 'from', from: windowStart(today, size) };
}

export interface SheetWindowRequest {
  /** Hasta dónde se cargó (ver `parseReach`). */
  reach?: string;
  /**
   * Carga INCREMENTAL: lo que el navegador ya tiene (un alcance anterior). Con esto
   * el servidor devuelve sólo el bloque nuevo (lo de `reach` que no está en `until`).
   */
  until?: string;
  /** Búsqueda en TODO el histórico. */
  q?: string;
  /** Filtros por columna (clave del campo → valores crudos) en TODO el histórico. */
  cols?: Record<string, string[]>;
}

export const SEARCH_MAX_CHARS = 80;
const SEARCH_MAX_COLS = 8;
const SEARCH_MAX_VALUES = 50;

/** El texto de búsqueda que el servidor admite: sin los signos que rompen la consulta. */
export function cleanSearch(q: string | undefined): string {
  return (q ?? '')
    .replace(/[,()%*\\"':;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_MAX_CHARS);
}

export function isSearching(req: SheetWindowRequest | undefined): boolean {
  if (!req) return false;
  return Boolean(cleanSearch(req.q)) || Object.values(req.cols ?? {}).some((v) => v.length > 0);
}

/**
 * Lo que viaja en la dirección de datos: `sw=<bloque>~<alcance>,…` y
 * `sq=<json>`. Sólo cuentan los bloques que el spec declara con ventana.
 */
export function parseSheetWindowParams(
  windowed: ReadonlySet<string>,
  sw: string | null | undefined,
  sq: string | null | undefined,
): Record<string, SheetWindowRequest> {
  const out: Record<string, SheetWindowRequest> = {};
  for (const part of (sw ?? '').split(',')) {
    const [id, reach, until] = part.split('~');
    if (id && reach && windowed.has(id) && reach.length <= 12)
      out[id] = { reach, ...(until && until.length <= 12 ? { until } : {}) };
  }
  if (sq && sq.length <= 4000) {
    try {
      const parsed = JSON.parse(sq) as Record<string, { q?: unknown; c?: unknown }>;
      for (const [id, v] of Object.entries(parsed ?? {})) {
        if (!windowed.has(id) || !v || typeof v !== 'object') continue;
        const q = typeof v.q === 'string' ? cleanSearch(v.q) : '';
        const cols: Record<string, string[]> = {};
        if (v.c && typeof v.c === 'object')
          for (const [key, vals] of Object.entries(v.c as Record<string, unknown>).slice(0, SEARCH_MAX_COLS))
            if (Array.isArray(vals) && /^[a-z0-9_]{1,32}$/i.test(key))
              cols[key] = vals
                .filter((x): x is string => typeof x === 'string')
                .slice(0, SEARCH_MAX_VALUES)
                .map((x) => x.slice(0, 200));
        out[id] = { ...(out[id] ?? {}), ...(q ? { q } : {}), ...(Object.keys(cols).length ? { cols } : {}) };
      }
    } catch {
      /* Un parámetro roto no tumba la hoja: se ignora. */
    }
  }
  return out;
}

/** Inverso de `parseSheetWindowParams` (lo usa el navegador). */
export function encodeSheetWindowParams(reqs: Record<string, SheetWindowRequest>): {
  sw: string;
  sq: string;
} {
  const sw = Object.entries(reqs)
    .filter(([, r]) => r.reach)
    .map(([id, r]) => `${id}~${r.reach}${r.until ? `~${r.until}` : ''}`)
    .join(',');
  const q: Record<string, { q?: string; c?: Record<string, string[]> }> = {};
  for (const [id, r] of Object.entries(reqs)) {
    const text = cleanSearch(r.q);
    const cols = Object.fromEntries(Object.entries(r.cols ?? {}).filter(([, v]) => v.length));
    if (text || Object.keys(cols).length)
      q[id] = { ...(text ? { q: text } : {}), ...(Object.keys(cols).length ? { c: cols } : {}) };
  }
  return { sw, sq: Object.keys(q).length ? JSON.stringify(q) : '' };
}

// ---------------------------------------------------------------------------
// El resultado
// ---------------------------------------------------------------------------

export interface SheetWindowInfo {
  mode: 'days' | 'months' | 'groups' | 'search';
  /** Campo de la fecha de la ventana. */
  field: string;
  /** `30d`, `3m` o `g10`: el tamaño de cada bloque. */
  size: string;
  /** Inicio de lo cargado (días/meses); null = desde siempre o por grupos. */
  from: string | null;
  /** Lo pedido (para que el navegador lo repita en cada refresco). */
  reach: string;
  /** Hay filas más viejas sin cargar. */
  more: boolean;
  /** El alcance del bloque siguiente (null si no hay más). */
  next: string | null;
  /** Fecha de la fila más vieja sin cargar (la frontera), si se conoce. */
  frontier: string | null;
  /** Se cortó en el tope de filas. */
  capped: boolean;
  /** Cuántos grupos trae (sólo con agrupado). */
  groupCount: number;
  /** Nombre en plural de lo agrupado («manifiestos») y de las filas («guías»). */
  groupNoun: string | null;
  rowNoun: string;
  /** Búsqueda o filtros en todo el histórico: no hay «cargar anterior». */
  search: boolean;
  /** Hoy en Bogotá, para los rótulos («Últimos 30 días»). */
  today: string;
  /** El rango tal cual quedó (fechas de la fila más vieja y más nueva cargadas). */
  shownFrom: string | null;
  shownTo: string | null;
  rows: number;
}

export interface WindowPlanRow {
  id: string;
  date: string | null;
  group: string;
}

export interface WindowPlan {
  /** Ids de las filas que entran. */
  ids: Set<string>;
  info: Pick<
    SheetWindowInfo,
    'mode' | 'from' | 'reach' | 'more' | 'next' | 'frontier' | 'capped' | 'groupCount'
  >;
}

/** Grupos de más reciente a más viejo (por la fecha de su fila más nueva). */
export function groupsByRecency(entries: WindowPlanRow[]): string[] {
  const newest = new Map<string, string>();
  for (const e of entries) {
    const d = e.date ?? '';
    const cur = newest.get(e.group);
    if (cur === undefined || d > cur) newest.set(e.group, d);
  }
  return [...newest.entries()]
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? 1 : -1))
    .map(([k]) => k);
}

/** El inicio del bloque siguiente: termina el día anterior al `from` actual (o en la última fecha que haya). */
export function previousFrom(from: string, size: WindowSize, latestBelow: string | null): string | null {
  if (!latestBelow) return null;
  const anchor = latestBelow < from ? latestBelow : windowAddDays(from, -1);
  return windowStart(anchor, size);
}

/**
 * La ventana sobre una lista COMPLETA de filas (en memoria): lo que usan las
 * fuentes de sólo lectura y las pruebas, y lo que la consulta de la base
 * reproduce paso a paso. `group` es la clave de agrupado de la fila ('' = sin
 * grupo; con ventana por grupos, sin agrupado cada fila es su propio grupo).
 */
export function planWindow(
  rows: WindowPlanRow[],
  cfg: { size: WindowSize; reach: Reach | null; today: string },
): WindowPlan {
  const { size, today } = cfg;
  const reach = cfg.reach ?? initialReach(size, today);
  if (reach.kind === 'all') {
    return {
      ids: new Set(rows.map((r) => r.id)),
      info: {
        mode: size.kind,
        from: null,
        reach: 'all',
        more: false,
        next: null,
        frontier: null,
        capped: false,
        groupCount: new Set(rows.map((r) => r.group)).size,
      },
    };
  }
  if (reach.kind === 'groups' || size.kind === 'groups') {
    const n = reach.kind === 'groups' ? reach.n : size.n;
    const order = groupsByRecency(rows);
    const chosen = new Set(order.slice(0, n));
    const ids = new Set(rows.filter((r) => chosen.has(r.group)).map((r) => r.id));
    const left = rows.filter((r) => !ids.has(r.id));
    const stepN = size.kind === 'groups' ? size.n : n;
    return {
      ids,
      info: {
        mode: 'groups',
        from: null,
        reach: `g${n}`,
        more: order.length > n,
        next: order.length > n ? `g${n + stepN}` : null,
        frontier: left.reduce<string | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null),
        capped: false,
        groupCount: chosen.size,
      },
    };
  }
  let from = reach.from;
  const explicit = cfg.reach !== null;
  let inside = rows.filter((r) => r.date === null || r.date >= from);
  if (!inside.length && !explicit) {
    // Datos viejos y nada reciente: el primer bloque cae donde están los datos.
    const latest = rows.reduce<string | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null);
    if (latest) {
      from = windowStart(latest, size);
      inside = rows.filter((r) => r.date === null || r.date >= from);
    }
  }
  const chosenGroups = new Set(inside.map((r) => r.group).filter(Boolean));
  const ids = new Set(inside.map((r) => r.id));
  for (const r of rows) if (r.group && chosenGroups.has(r.group)) ids.add(r.id);
  const left = rows.filter((r) => !ids.has(r.id));
  const latestBelow = left.reduce<string | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null);
  const next = left.length ? previousFrom(from, size, latestBelow) : null;
  return {
    ids,
    info: {
      mode: size.kind,
      from,
      reach: from,
      more: left.length > 0,
      next,
      frontier: latestBelow,
      capped: false,
      groupCount: new Set(rows.filter((r) => ids.has(r.id)).map((r) => r.group)).size,
    },
  };
}

// ---------------------------------------------------------------------------
// Textos (los comparten el servidor y el navegador)
// ---------------------------------------------------------------------------

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «3 ene 2026» (con año) o «3 ene». */
export function windowShortDay(day: string, withYear = false): string {
  const [y, m, d] = day.split('-').map(Number);
  const base = `${d} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
  return withYear ? `${base} ${y}` : base;
}

/** «1 sep – 28 oct» (con año si cruza de año o no es el actual). */
export function windowRangeLabel(from: string, to: string, today: string): string {
  const year = today.slice(0, 4);
  const cross = from.slice(0, 4) !== to.slice(0, 4) || to.slice(0, 4) !== year;
  return from === to ? windowShortDay(from, cross) : `${windowShortDay(from, cross)} – ${windowShortDay(to, cross)}`;
}

export function pluralEs(word: string): string {
  const w = word.trim().toLowerCase();
  if (!w) return w;
  if (/[aeiouáéíóú]$/.test(w)) return `${w}s`;
  if (/z$/.test(w)) return `${w.slice(0, -1)}ces`;
  return `${w}es`;
}

/** El tamaño tal como lo guarda `SheetWindowInfo.size` (`30d`, `3m`, `g10`). */
export function sizeFromText(text: string): WindowSize {
  const g = /^g(\d+)$/.exec(text);
  return g ? { kind: 'groups', n: Number(g[1]) } : parseWindowSize({ size: text });
}

/** El texto del botón de abajo según el tamaño de la ventana. */
export function loadMoreLabel(info: Pick<SheetWindowInfo, 'size' | 'groupNoun' | 'rowNoun'>): string {
  const g = /^g(\d+)$/.exec(info.size);
  if (g) return `Cargar ${g[1]} ${info.groupNoun ?? info.rowNoun} más`;
  const m = /^(\d+)([dm])$/.exec(info.size);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === 'm') return n === 1 ? 'Cargar mes anterior' : `Cargar ${n} meses anteriores`;
    return n === 7 ? 'Cargar semana anterior' : `Cargar ${n} días anteriores`;
  }
  return 'Cargar anteriores';
}

/** Lo que dice la «ventana» para el selector rápido: los alcances que ofrece. */
export function reachPresets(
  size: WindowSize,
): Array<{ id: string; label: string }> {
  if (size.kind === 'groups')
    return [
      { id: `g${size.n}`, label: `Últimos ${size.n}` },
      { id: `g${size.n * 3}`, label: `Últimos ${size.n * 3}` },
      { id: `g${size.n * 10}`, label: `Últimos ${size.n * 10}` },
      { id: 'all', label: 'Todo' },
    ];
  return [
    { id: '7d', label: 'Últimos 7 días' },
    { id: '30d', label: 'Últimos 30 días' },
    { id: '90d', label: 'Últimos 90 días' },
    { id: 'year', label: 'Este año' },
    { id: 'all', label: 'Todo' },
  ];
}

/** El rótulo del selector para el alcance en uso. */
export function reachLabel(info: Pick<SheetWindowInfo, 'reach' | 'size' | 'from'>, today: string): string {
  const r = info.reach;
  if (r === 'all') return 'Todo';
  if (/^g\d+$/.test(r)) return `Últimos ${r.slice(1)}`;
  const size = parseWindowSize({ size: /^\d+[dm]$/.test(info.size) ? info.size : undefined });
  for (const p of ['7d', '30d', '90d'] as const) {
    const parsed = parseReach(p, today);
    if (parsed?.kind === 'from' && parsed.from === r) return `Últimos ${p.slice(0, -1)} días`;
  }
  if (r === `${today.slice(0, 4)}-01-01`) return 'Este año';
  const initial = initialReach(size, today);
  if (initial.kind === 'from' && initial.from === r)
    return size.kind === 'months'
      ? size.n === 1
        ? 'Este mes'
        : `Últimos ${size.n} meses`
      : `Últimos ${size.n} días`;
  if (size.kind !== 'months') {
    const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${r}T12:00:00Z`)) / 86_400_000) + 1;
    if (days >= 1 && days <= 400) return `Últimos ${days} días`;
  }
  return `Desde ${windowShortDay(r, r.slice(0, 4) !== today.slice(0, 4))}`;
}

/**
 * La ventana DE UN BLOQUE NUEVO: lo de `reach` que no está ya en `until`, más los
 * grupos que ese bloque toca (completos). Sin `until` es la ventana de siempre.
 */
export function planDelta(
  rows: WindowPlanRow[],
  cfg: { size: WindowSize; reach: Reach | null; until: Reach | null; today: string },
): WindowPlan {
  const full = planWindow(rows, cfg);
  if (!cfg.until) return full;
  const prev = planWindow(rows, { size: cfg.size, reach: cfg.until, today: cfg.today });
  const fresh = rows.filter((r) => full.ids.has(r.id) && !prev.ids.has(r.id));
  const groups = new Set(fresh.map((r) => r.group).filter(Boolean));
  const ids = new Set(fresh.map((r) => r.id));
  for (const r of rows) if (full.ids.has(r.id) && r.group && groups.has(r.group)) ids.add(r.id);
  return { ids, info: full.info };
}

/** ¿`next` llega más atrás que `current`? (ensanchar es incremental; estrechar reinicia). */
export function reachIsWider(next: Reach, current: Reach): boolean {
  if (next.kind === 'all') return current.kind !== 'all';
  if (current.kind === 'all') return false;
  if (next.kind === 'groups' && current.kind === 'groups') return next.n > current.n;
  if (next.kind === 'from' && current.kind === 'from') return next.from < current.from;
  return false;
}

// ---------------------------------------------------------------------------
// Unir bloques ya calculados (el navegador acumula lo cargado hacia el pasado)
// ---------------------------------------------------------------------------

interface MergeGroup {
  key: string;
  sortKey?: string;
  fields: unknown[];
}
interface MergeRow {
  id: string;
  group: number;
}
interface MergeBlock {
  rows: MergeRow[];
  groups: MergeGroup[] | null;
  groupDir?: 1 | -1;
  total: number;
  truncated: boolean;
  window: Partial<SheetWindowInfo> | null;
  actions?: Array<{ id: string; rowIds?: string[] }>;
  record?: { rows: Record<string, unknown> } | null;
}

const naturalCmp = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true });

/**
 * `newer` (lo fresco) + `older` (lo cargado hacia el pasado) en una sola hoja.
 * Gana lo fresco cuando una fila está en las dos; los grupos se reordenan con la
 * misma regla del servidor (`sortKey` natural, «Sin …» al final) y las filas
 * quedan contiguas por grupo.
 */
export function mergeSheetBlocks<T extends MergeBlock>(newer: T, older: T): T {
  const have = new Set(newer.rows.map((r) => r.id));
  const extra = older.rows.filter((r) => !have.has(r.id));
  const grouped = Boolean(newer.groups || older.groups);
  let groups: MergeGroup[] | null = null;
  let rows: MergeRow[];
  if (grouped) {
    const byKey = new Map<string, MergeGroup>();
    for (const g of older.groups ?? []) byKey.set(g.key, g);
    for (const g of newer.groups ?? []) byKey.set(g.key, g);
    const keyOf = (src: T, i: number) => src.groups?.[i]?.key;
    const dir = newer.groupDir ?? older.groupDir ?? 1;
    const order = [...byKey.keys()].sort((a, b) => {
      if (a === '' || b === '') return a === '' ? 1 : -1;
      const ga = byKey.get(a) as MergeGroup;
      const gb = byKey.get(b) as MergeGroup;
      return naturalCmp(ga.sortKey ?? ga.key, gb.sortKey ?? gb.key) * dir;
    });
    groups = order.map((k) => byKey.get(k) as MergeGroup);
    const index = new Map(order.map((k, i) => [k, i]));
    const bucket = new Map<number, MergeRow[]>();
    const put = (src: T, r: MergeRow) => {
      const k = r.group >= 0 ? keyOf(src, r.group) : undefined;
      const gi = k === undefined ? -1 : (index.get(k) ?? -1);
      const list = bucket.get(gi) ?? [];
      list.push({ ...r, group: gi });
      bucket.set(gi, list);
    };
    for (const r of newer.rows) put(newer, r);
    for (const r of extra) put(older, r);
    rows = [...bucket.keys()]
      .sort((a, b) => (a === -1 ? 1 : b === -1 ? -1 : a - b))
      .flatMap((k) => bucket.get(k) ?? []);
  } else rows = [...newer.rows, ...extra];

  const actions = newer.actions?.map((a) => {
    const more = older.actions?.find((x) => x.id === a.id)?.rowIds;
    return a.rowIds && more ? { ...a, rowIds: [...new Set([...a.rowIds, ...more])] } : a;
  });
  const record =
    newer.record && older.record
      ? { ...newer.record, rows: { ...older.record.rows, ...newer.record.rows } }
      : (newer.record ?? older.record);
  const nw = newer.window;
  const ow = older.window;
  const window =
    nw && ow
      ? {
          ...ow,
          rows: rows.length,
          groupCount: groups?.length ?? 0,
          shownFrom: [nw.shownFrom, ow.shownFrom].filter(Boolean).sort()[0] ?? null,
          shownTo: [nw.shownTo, ow.shownTo].filter(Boolean).sort().reverse()[0] ?? null,
          capped: Boolean(nw.capped || ow.capped),
        }
      : (nw ?? ow);
  return {
    ...newer,
    rows,
    groups,
    total: rows.length,
    truncated: newer.truncated || older.truncated,
    window,
    ...(actions ? { actions } : {}),
    ...(record !== undefined ? { record } : {}),
  } as T;
}
