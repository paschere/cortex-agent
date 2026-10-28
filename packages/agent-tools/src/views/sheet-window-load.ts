import type { SupabaseClient } from '@supabase/supabase-js';
import { type RowAccess, applyRowScope } from '../apps/permissions';
import { parseRelationValue } from '../trackers/schema';
import type { ViewSpec } from './spec';
import type { SheetWindowData, ViewRow } from './compute';
import {
  type WindowPlanRow,
  type Reach,
  type SheetWindowRequest,
  type SheetWindowSpec,
  WINDOW_ROW_CAP,
  cleanSearch,
  isSearching,
  parseSheetWindowParams,
  parseReach,
  parseWindowSize,
  planDelta,
  planWindow,
  previousFrom,
  windowBogotaDay,
  windowDateOf,
  windowStart,
} from './sheet-window';

/**
 * LA CARGA DE UNA HOJA CON VENTANA. El filtro de fechas, el scope del rol y la
 * búsqueda van EN LA CONSULTA (no se trae la tabla para recortarla en memoria);
 * el agrupado se completa con una segunda consulta por los grupos que cayeron
 * dentro de la ventana. La lógica de qué entra es la de `planWindow` (pura, en
 * sheet-window.ts): aquí sólo se traducen sus reglas a consultas.
 */

const COLS = 'id, label, values, created_by, created_by_app_user, created_at, updated_at';
const KEY_RE = /^[a-z0-9_]{1,32}$/i;
const LIGHT_PAGE = 1000;
const LIGHT_MAX_PAGES = 40;
const ROW_PAGE = 1000;

interface LoadArgs {
  trackerId: string;
  fields: Array<{ key: string; type: string; tracker?: string }>;
  block: {
    id: string;
    columns: string[];
    window: SheetWindowSpec;
    group?: { by: string; parentTracker?: string };
  };
  access: RowAccess;
  /** Alcance del padre de los grupos (si no se ve, no se traen sus encabezados). */
  parentAccess?: RowAccess;
  request: SheetWindowRequest | undefined;
  today: string;
  adapt: (row: Record<string, unknown>) => ViewRow;
}

// biome-ignore lint/suspicious/noExplicitAny: el constructor de consultas de postgrest cambia de tipo en cada paso
type Query = any;

function scoped(db: SupabaseClient, a: LoadArgs, select = COLS): Query {
  let q: Query = db.from('tracker_rows').select(select).eq('tracker_id', a.trackerId);
  const acc = a.access;
  if (acc.kind === 'own') q = q.eq(acc.external ? 'created_by_app_user' : 'created_by', acc.userId);
  else if (acc.kind === 'equals' && KEY_RE.test(acc.field))
    q = acc.value === null ? q.is(`values->>${acc.field}`, null) : q.eq(`values->>${acc.field}`, acc.value);
  return q;
}

const tsOf = (day: string) => `${day}T00:00:00-05:00`;

function fieldOf(spec: SheetWindowSpec): string {
  const f = spec.field ?? 'created_at';
  return f === 'created_at' || f === 'updated_at' || KEY_RE.test(f) ? f : 'created_at';
}

function isColumn(field: string): boolean {
  return field === 'created_at' || field === 'updated_at';
}

/** «fecha ≥ día» con la de creación cuando la fila no trae la del campo. */
function dateGte(q: Query, field: string, day: string): Query {
  if (isColumn(field)) return q.gte(field, tsOf(day));
  return q.or(
    `values->>${field}.gte.${day},and(values->>${field}.is.null,created_at.gte.${tsOf(day)})`,
  );
}

function dateLt(q: Query, field: string, day: string): Query {
  if (isColumn(field)) return q.lt(field, tsOf(day));
  return q.or(
    `values->>${field}.lt.${day},and(values->>${field}.is.null,created_at.lt.${tsOf(day)})`,
  );
}

function newestFirst(q: Query, field: string): Query {
  return isColumn(field)
    ? q.order(field, { ascending: false }).order('id', { ascending: false })
    : q
        .order(`values->>${field}`, { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
}

function groupKeyOf(type: string | undefined, raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (type === 'relation') return parseRelationValue(raw)?.id ?? '';
  return String(raw);
}

async function rowsOf(q: Query, a: LoadArgs): Promise<ViewRow[]> {
  const { data, error } = await q;
  if (error) throw error;
  return applyRowScope(
    ((data ?? []) as Array<Record<string, unknown>>).map((r) => a.adapt(r)),
    a.access,
  );
}

/**
 * Lee por páginas (el servidor de datos corta cada respuesta): hasta `cap + 1`
 * filas, para poder decir que se llegó al tope. `make` arma la consulta con un
 * orden estable (siempre termina en `id`).
 */
async function pagedRows(make: () => Query, a: LoadArgs, cap: number): Promise<ViewRow[]> {
  const out: ViewRow[] = [];
  for (let from = 0; out.length <= cap; from += ROW_PAGE) {
    const { data, error } = await make().range(from, from + ROW_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    out.push(...applyRowScope(batch.map((r) => a.adapt(r)), a.access));
    if (batch.length < ROW_PAGE) break;
  }
  return out.slice(0, cap + 1);
}

/** Las filas de los grupos dados (relación: por el id; valor común: por igualdad). */
async function membersOf(db: SupabaseClient, a: LoadArgs, keys: string[]): Promise<ViewRow[]> {
  const by = a.block.group?.by;
  if (!by || !KEY_RE.test(by)) return [];
  const type = a.fields.find((f) => f.key === by)?.type;
  const out: ViewRow[] = [];
  const step = type === 'relation' ? 25 : 60;
  const ungrouped = keys.includes('');
  const named = keys.filter(Boolean);
  for (let i = 0; i < named.length; i += step) {
    const chunk = named.slice(i, i + step);
    let q = scoped(db, a);
    q =
      type === 'relation'
        ? q.or(chunk.map((k) => `values->>${by}.ilike.%${k}%`).join(','))
        : q.in(`values->>${by}`, chunk);
    out.push(...(await pagedRows(() => q.order('id'), a, WINDOW_ROW_CAP)));
  }
  if (ungrouped) {
    out.push(
      ...(await pagedRows(
        () => newestFirst(scoped(db, a).or(`values->>${by}.is.null,values->>${by}.eq.`), fieldOf(a.block.window)),
        a,
        WINDOW_ROW_CAP,
      )),
    );
  }
  return out;
}

async function parentsOf(db: SupabaseClient, a: LoadArgs, rows: ViewRow[]): Promise<ViewRow[]> {
  const g = a.block.group;
  if (!g?.parentTracker || !a.parentAccess || a.parentAccess.kind === 'none') return [];
  const type = a.fields.find((f) => f.key === g.by)?.type;
  if (type !== 'relation') return [];
  const ids = [...new Set(rows.map((r) => groupKeyOf(type, r.values[g.by])).filter(Boolean))];
  if (!ids.length) return [];
  const { data: t } = await db.from('trackers').select('id').eq('slug', g.parentTracker).maybeSingle();
  const parentId = (t as { id?: string } | null)?.id;
  if (!parentId) return [];
  const out: ViewRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db
      .from('tracker_rows')
      .select(COLS)
      .eq('tracker_id', parentId)
      .in('id', ids.slice(i, i + 100));
    if (error) throw error;
    out.push(...((data ?? []) as Array<Record<string, unknown>>).map((r) => a.adapt(r)));
  }
  return applyRowScope(out, a.parentAccess);
}

function sizeText(size: ReturnType<typeof parseWindowSize>): string {
  return size.kind === 'groups' ? `g${size.n}` : `${size.n}${size.kind === 'months' ? 'm' : 'd'}`;
}

function baseInfo(a: LoadArgs): Pick<SheetWindowData['info'], 'field' | 'size'> {
  return { field: fieldOf(a.block.window), size: sizeText(parseWindowSize(a.block.window)) };
}

/** Búsqueda y filtros por columna: TODO el histórico, en la consulta. */
async function searchAll(db: SupabaseClient, a: LoadArgs): Promise<SheetWindowData> {
  const req = a.request ?? {};
  const field = fieldOf(a.block.window);
  let q = scoped(db, a);
  const text = cleanSearch(req.q);
  if (text) {
    const keys = [...new Set(a.block.columns.filter((k) => KEY_RE.test(k) && k !== 'label'))];
    const likes = [
      `label.ilike.%${text}%`,
      ...keys.map((k) => (isColumn(k) ? '' : `values->>${k}.ilike.%${text}%`)),
    ].filter(Boolean);
    q = q.or(likes.join(','));
  }
  for (const [key, vals] of Object.entries(req.cols ?? {})) {
    if (!vals.length || !KEY_RE.test(key)) continue;
    const type = a.fields.find((f) => f.key === key)?.type;
    const present = vals.filter((v) => v !== '' && v !== '—');
    const empty = present.length !== vals.length;
    const col = key === 'label' ? 'label' : `values->>${key}`;
    // Una relación se guarda como id o como {id, label}: se busca por el id.
    const parts =
      type === 'relation'
        ? present
            .filter((v) => /^[0-9a-f-]{36}$/i.test(v))
            .map((v) => `${col}.ilike.%${v}%`)
        : present.length
          ? [`${col}.in.(${present.map((v) => `"${v.replace(/["\\]/g, ' ')}"`).join(',')})`]
          : [];
    if (empty) parts.push(`${col}.is.null`);
    if (parts.length) q = q.or(parts.join(','));
  }
  const list = await pagedRows(() => newestFirst(q, field), a, WINDOW_ROW_CAP);
  const capped = list.length > WINDOW_ROW_CAP;
  const rows = list.slice(0, WINDOW_ROW_CAP);
  return {
    rows,
    parents: await parentsOf(db, a, rows),
    info: {
      mode: 'search',
      ...baseInfo(a),
      from: null,
      reach: a.request?.reach ?? '',
      more: false,
      next: null,
      frontier: null,
      capped,
      groupCount: 0,
      search: true,
    },
  };
}

/** Ventana por grupos: una lectura LIVIANA (id, grupo, fecha) decide cuáles; luego se traen completos. */
async function byGroups(
  db: SupabaseClient,
  a: LoadArgs,
  reach: Reach | null,
  until: Reach | null,
): Promise<SheetWindowData> {
  const size = parseWindowSize(a.block.window);
  const field = fieldOf(a.block.window);
  const by = a.block.group?.by;
  const type = a.fields.find((f) => f.key === by)?.type;
  const light: WindowPlanRow[] = [];
  const gcol = by && KEY_RE.test(by) ? `g:values->>${by},` : '';
  const dcol = isColumn(field) ? '' : `d:values->>${field},`;
  let truncated = false;
  for (let page = 0; page < LIGHT_MAX_PAGES; page++) {
    const q = scoped(db, a, `id, ${gcol}${dcol}created_at`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * LIGHT_PAGE, (page + 1) * LIGHT_PAGE - 1);
    const { data, error } = await q;
    if (error) throw error;
    const batch = (data ?? []) as Array<{ id: string; g?: unknown; d?: unknown; created_at: string }>;
    for (const r of batch) {
      const d = typeof r.d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.d) ? r.d.slice(0, 10) : null;
      light.push({
        id: r.id,
        date: d ?? windowBogotaDay(r.created_at),
        // Sin agrupado cada fila es su propio grupo.
        group: by ? groupKeyOf(type, r.g) : r.id,
      });
    }
    if (batch.length < LIGHT_PAGE) break;
    if (page === LIGHT_MAX_PAGES - 1) truncated = true;
  }
  const plan = planDelta(light, { size, reach, until, today: a.today });
  const chosenGroups = [...new Set(light.filter((r) => plan.ids.has(r.id)).map((r) => r.group))];
  let rows: ViewRow[];
  if (by) rows = await membersOf(db, a, chosenGroups);
  else {
    rows = [];
    const ids = [...plan.ids];
    for (let i = 0; i < ids.length; i += 100)
      rows.push(...(await rowsOf(scoped(db, a).in('id', ids.slice(i, i + 100)), a)));
  }
  const seen = new Set<string>();
  rows = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const capped = truncated || rows.length > WINDOW_ROW_CAP;
  rows = rows.slice(0, WINDOW_ROW_CAP);
  return {
    rows,
    parents: await parentsOf(db, a, rows),
    info: { ...plan.info, ...baseInfo(a), capped, search: false },
  };
}

/** Ventana por días o meses: la consulta ya trae sólo el rango; los grupos se completan aparte. */
async function byDate(
  db: SupabaseClient,
  a: LoadArgs,
  reach: Reach | null,
  until: Reach | null,
): Promise<SheetWindowData> {
  const size = parseWindowSize(a.block.window);
  const field = fieldOf(a.block.window);
  const by = a.block.group?.by;
  const type = a.fields.find((f) => f.key === by)?.type;
  // Carga incremental: sólo el bloque entre `reach` y lo que el navegador ya tiene.
  const upper = until?.kind === 'from' ? until.from : null;
  const explicit = reach !== null;
  let from: string | null =
    reach?.kind === 'from' ? reach.from : reach?.kind === 'all' ? null : windowStart(a.today, size);
  const fetchFrom = async (day: string | null) => {
    const make = () => {
      let q = day ? dateGte(scoped(db, a), field, day) : scoped(db, a);
      if (upper) q = dateLt(q, field, upper);
      return newestFirst(q, field);
    };
    return pagedRows(make, a, WINDOW_ROW_CAP);
  };
  let inside = await fetchFrom(from);
  if (!inside.length && !explicit && from && !upper) {
    // Datos viejos y nada reciente: el primer bloque cae donde están los datos.
    const older = await rowsOf(newestFirst(dateLt(scoped(db, a), field, from), field).limit(1), a);
    const latest = older[0] ? windowDateOf(older[0], field) : null;
    if (latest) {
      from = windowStart(latest, size);
      inside = await fetchFrom(from);
    }
  }
  const capped = inside.length > WINDOW_ROW_CAP;
  inside = inside.slice(0, WINDOW_ROW_CAP);
  const have = new Set(inside.map((r) => r.id));
  let rows = inside;
  if (by && inside.length) {
    const keys = [...new Set(inside.map((r) => groupKeyOf(type, r.values[by])).filter(Boolean))];
    const extra = (await membersOf(db, a, keys)).filter((r) => !have.has(r.id));
    for (const r of extra) have.add(r.id);
    rows = [...inside, ...extra].slice(0, WINDOW_ROW_CAP);
  }
  let latestBelow: string | null = null;
  if (from) {
    const below = await rowsOf(
      newestFirst(dateLt(scoped(db, a), field, from), field).limit(rows.length - inside.length + 1),
      a,
    );
    const first = below.find((r) => !have.has(r.id));
    latestBelow = first ? windowDateOf(first, field) : null;
  }
  const next = from && latestBelow ? previousFrom(from, size, latestBelow) : null;
  return {
    rows,
    parents: await parentsOf(db, a, rows),
    info: {
      mode: size.kind === 'months' ? 'months' : 'days',
      ...baseInfo(a),
      from,
      reach: from ?? 'all',
      more: Boolean(latestBelow),
      next,
      frontier: latestBelow,
      capped,
      groupCount: 0,
      search: false,
    },
  };
}

/** Lo que trae la hoja con ventana de una tabla propia. */
export async function loadSheetWindow(db: SupabaseClient, a: LoadArgs): Promise<SheetWindowData> {
  if (isSearching(a.request)) return searchAll(db, a);
  const size = parseWindowSize(a.block.window);
  const asked = parseReach(a.request?.reach, a.today);
  const until = parseReach(a.request?.until, a.today);
  if (size.kind === 'groups')
    return byGroups(
      db,
      a,
      asked && asked.kind !== 'from' ? asked : null,
      until && until.kind !== 'from' ? until : null,
    );
  return byDate(
    db,
    a,
    asked && asked.kind !== 'groups' ? asked : null,
    until && until.kind !== 'groups' ? until : null,
  );
}

/**
 * La misma ventana sobre filas que ya están en memoria (fuentes de sólo lectura
 * de la plataforma o del Feed, que no tienen consulta propia).
 */
export function windowRowsInMemory(
  rows: ViewRow[],
  a: {
    block: LoadArgs['block'];
    fields: LoadArgs['fields'];
    request: SheetWindowRequest | undefined;
    today: string;
  },
): SheetWindowData {
  const size = parseWindowSize(a.block.window);
  const field = fieldOf(a.block.window);
  const by = a.block.group?.by;
  const type = a.fields.find((f) => f.key === by)?.type;
  const info = { field, size: sizeText(size), groupCount: 0 };
  if (isSearching(a.request)) {
    const text = cleanSearch(a.request?.q).toLowerCase();
    const hit = rows.filter((r) => {
      if (text && !`${r.label} ${Object.values(r.values).join(' ')}`.toLowerCase().includes(text))
        return false;
      for (const [k, vals] of Object.entries(a.request?.cols ?? {}))
        if (vals.length && !vals.includes(String(k === 'label' ? r.label : (r.values[k] ?? ''))))
          return false;
      return true;
    });
    return {
      rows: hit.slice(0, WINDOW_ROW_CAP),
      info: {
        mode: 'search',
        ...info,
        from: null,
        reach: a.request?.reach ?? '',
        more: false,
        next: null,
        frontier: null,
        capped: hit.length > WINDOW_ROW_CAP,
        search: true,
      },
    };
  }
  const plan = planDelta(
    rows.map((r) => ({
      id: r.id,
      date: windowDateOf(r, field),
      group: by ? groupKeyOf(type, r.values[by]) : r.id,
    })),
    {
      size,
      reach: parseReach(a.request?.reach, a.today),
      until: parseReach(a.request?.until, a.today),
      today: a.today,
    },
  );
  return {
    rows: rows.filter((r) => plan.ids.has(r.id)).slice(0, WINDOW_ROW_CAP),
    info: { ...plan.info, ...info, capped: false, search: false },
  };
}

/** `sw` y `sq` de la dirección de datos, validados contra las hojas con ventana del spec GUARDADO. */
export function sheetWindowRequestsOf(
  spec: Pick<ViewSpec, 'blocks'>,
  sw: string | null | undefined,
  sq: string | null | undefined,
): Record<string, SheetWindowRequest> {
  const ids = new Set(spec.blocks.flatMap((b) => (b.type === 'sheet' && b.window ? [b.id] : [])));
  return ids.size ? parseSheetWindowParams(ids, sw, sq) : {};
}
