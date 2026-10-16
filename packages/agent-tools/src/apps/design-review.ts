import type { TrackerField } from '../trackers/schema';
import { type ViewBlock, type ViewSpec, checkSpecAgainst, viewSpecSchema } from '../views/spec';
import type { AppDraft } from './design';
import {
  type PatternTable,
  buildDetailBlock,
  formStepsFor,
  inferFieldRoles,
} from './screen-patterns';

/**
 * AUTORREVISIÓN DEL DISEÑO DE UNA APP, ANTES DE ENSEÑARLA.
 *
 * `reviewAppDesign(draft, tables)` es puro: recibe el borrador ya validado y las
 * tablas reales (las que existen y las que el borrador crea) y devuelve
 *   - `draft`: el borrador con las CORRECCIONES SEGURAS ya aplicadas (formato de
 *     pesos, títulos humanos, un detalle para cada lista, formularios por pasos,
 *     tarjetas en vez de tablas largas para la gente de planta, métricas arriba
 *     y en fila, páginas cuando una pantalla pesa demasiado…);
 *   - `fixes`: lo que se corrigió, en una línea cada cosa;
 *   - `notes`: lo que sigue mal DESPUÉS de corregir y exige que el modelo
 *     decida (se audita el borrador ya corregido, no el original).
 *
 * Una corrección que dejaría la pantalla inválida contra las tablas se
 * descarta y esa pantalla queda como venía, con su nota.
 *
 * `design` por bloque (superficie, énfasis, tamaño…) lo añade otra pieza; aquí
 * se lee con tolerancia: si un bloque no lo trae, se ignora.
 */

export interface DesignNote {
  /** Título de la pantalla, o null si es de toda la app. */
  screen: string | null;
  rule: string;
  message: string;
}

export interface DesignReview {
  draft: AppDraft;
  fixes: string[];
  notes: DesignNote[];
}

type Screen = AppDraft['screens'][number];
type Role = AppDraft['roles'][number];

const MAX_BLOCKS = 8;
const MAX_STRONG = 2;
const MAX_METRICS = 4;
const LISTS = new Set(['cards', 'table', 'board', 'gallery', 'calendar', 'zones']);
/** Bloques grandes que piden la mirada por sí solos. */
const STRONG_TYPES = new Set(['board', 'zones', 'map', 'calendar', 'gallery']);
const GIANT_TYPES = new Set([...STRONG_TYPES, 'table', 'chart', 'cards']);

const isOwn = (slug: string) => !slug.includes('.');
const sourceOf = (b: ViewBlock): string | null => ('tracker' in b ? b.tracker : null);

function designOf(b: ViewBlock): Record<string, unknown> | null {
  const d = (b as { design?: unknown }).design;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
}

/** Los bloques fuertes de un grupo; una fila de métricas fuertes cuenta como UNO. */
function strongCount(group: ViewBlock[]): number {
  const strong = group.filter(isStrong);
  return strong.filter((b) => b.type !== 'metric').length + (strong.some((b) => b.type === 'metric') ? 1 : 0);
}

function isStrong(b: ViewBlock): boolean {
  const d = designOf(b);
  if (d && typeof d.emphasis === 'string') return d.emphasis === 'strong';
  return STRONG_TYPES.has(b.type);
}

/** Un rol de planta: registra y ve sólo lo suyo (mismo criterio que `designWarnings`). */
export function isFieldRole(r: Pick<Role, 'permissions'>): boolean {
  const perms = Object.values(r.permissions.tables);
  return (
    perms.length > 0 &&
    perms.some((p) => p.create) &&
    perms.every((p) => p.read === 'own' || typeof p.read === 'object' || p.edit !== 'all')
  );
}

function seeing(draft: AppDraft, s: Pick<Screen, 'roles'>): Role[] {
  return s.roles.length ? draft.roles.filter((r) => s.roles.includes(r.key)) : draft.roles;
}

// ---------------------------------------------------------------------------
// Títulos humanos
// ---------------------------------------------------------------------------

const SNAKE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;
const CAMEL = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;
const DOTTED = /^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/;

/** ¿Parece un nombre técnico (snake_case, camelCase, `cortex.x`, o el id de una tabla/campo)? */
export function looksTechnical(text: string, ids: ReadonlySet<string> = new Set()): boolean {
  const t = text.trim();
  if (!t || t.includes(' ')) return false;
  return SNAKE.test(t) || CAMEL.test(t) || DOTTED.test(t) || ids.has(t);
}

/** «ventas_por_mes» → «Ventas por mes»; el nombre de una tabla o campo conocido gana. */
export function humanizeTitle(
  text: string,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const t = text.trim();
  const known = names.get(t);
  if (known) return known;
  const spaced = t
    .replace(/^[a-z][a-z0-9_]*\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : t;
}

// ---------------------------------------------------------------------------
// Utilidades de pantalla
// ---------------------------------------------------------------------------

function uniqueId(spec: ViewSpec, base: string): string {
  const taken = new Set(spec.blocks.map((b) => b.id));
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32) || 'bloque';
  if (!taken.has(clean)) return clean;
  for (let i = 2; i < 100; i++) if (!taken.has(`${clean}_${i}`)) return `${clean}_${i}`;
  return `${clean}_x`;
}

/** Los bloques agrupados por página (sin páginas: un solo grupo). */
function groupsOf(spec: ViewSpec): ViewBlock[][] {
  if (!spec.pages?.length) return [spec.blocks];
  const placed = new Set(spec.pages.flatMap((p) => p.blockIds));
  return spec.pages.map((p, i) =>
    spec.blocks.filter((b) => p.blockIds.includes(b.id) || (i === 0 && !placed.has(b.id))),
  );
}

function tableFor(tables: Map<string, PatternTable>, slug: string | null): PatternTable | null {
  return slug ? (tables.get(slug) ?? null) : null;
}

function fieldOf(table: PatternTable | null, key?: string): TrackerField | undefined {
  return key ? table?.fields.find((f) => f.key === key) : undefined;
}

// ---------------------------------------------------------------------------
// Correcciones (mutan la copia de la pantalla)
// ---------------------------------------------------------------------------

interface Ctx {
  draft: AppDraft;
  tables: Map<string, PatternTable>;
  names: Map<string, string>;
  ids: Set<string>;
}

function fixTitles(s: Screen, ctx: Ctx, fixes: string[]): void {
  const fix = (value: string | undefined): string | undefined => {
    if (value === undefined || !looksTechnical(value, ctx.ids)) return value;
    return humanizeTitle(value, ctx.names);
  };
  const before = JSON.stringify([s.title, s.spec.blocks.map((b) => ('title' in b ? b.title : ''))]);
  s.title = fix(s.title) ?? s.title;
  for (const b of s.spec.blocks) {
    if ('title' in b && typeof b.title === 'string') b.title = fix(b.title) ?? b.title;
    if (b.type === 'detail') {
      for (const sec of b.sections) sec.title = fix(sec.title) ?? sec.title;
      for (const rel of b.related) rel.title = fix(rel.title) ?? rel.title;
    }
    if (b.type === 'form') for (const st of b.steps ?? []) st.title = fix(st.title) ?? st.title;
  }
  for (const p of s.spec.pages ?? []) p.title = fix(p.title) ?? p.title;
  if (before !== JSON.stringify([s.title, s.spec.blocks.map((b) => ('title' in b ? b.title : ''))]))
    fixes.push(`«${s.title}»: títulos con nombres técnicos pasados a lenguaje de persona.`);
}

function fixMoney(s: Screen, ctx: Ctx, fixes: string[]): void {
  let changed = 0;
  for (const b of s.spec.blocks) {
    if (b.type !== 'metric' && b.type !== 'chart' && b.type !== 'progress') continue;
    if (b.aggregate === 'count' || !b.field) continue;
    const t = fieldOf(tableFor(ctx.tables, b.tracker), b.field);
    if (t?.type === 'money' && b.format !== 'money') {
      b.format = 'money';
      changed++;
    }
  }
  if (changed) fixes.push(`«${s.title}»: ${changed} cifra(s) de dinero ahora se muestran en pesos.`);
}

function audience(ctx: Ctx, s: Screen) {
  const roles = seeing(ctx.draft, s);
  return {
    roles,
    fieldOnly: roles.length > 0 && roles.every(isFieldRole),
    hasField: roles.some(isFieldRole),
  };
}

function fixOperator(s: Screen, ctx: Ctx, fixes: string[]): void {
  const { fieldOnly } = audience(ctx, s);
  const layout = s.spec.theme?.layout;
  if (layout === 'tv') return;
  const usable = s.spec.blocks.some((b) => b.type === 'form' || b.type === 'cards' || b.type === 'table');
  if (fieldOnly && usable && layout !== 'operator') {
    s.spec.theme = { ...(s.spec.theme ?? {}), layout: 'operator', density: 'comfortable' };
    fixes.push(`«${s.title}»: diseño operario (una columna, controles grandes) para la gente de planta.`);
  } else if (layout === 'operator' && s.spec.theme?.density !== 'comfortable') {
    s.spec.theme = { ...(s.spec.theme ?? {}), density: 'comfortable' };
    fixes.push(`«${s.title}»: controles grandes en la pantalla de planta.`);
  }
  if (s.spec.theme?.layout === 'operator') {
    const formIdx = s.spec.blocks.findIndex((b) => b.type === 'form');
    if (formIdx > 0) {
      const [form] = s.spec.blocks.splice(formIdx, 1);
      if (form) s.spec.blocks.unshift(form);
      fixes.push(`«${s.title}»: el formulario va primero en la pantalla de planta.`);
    }
  }
}

function fixLongTables(s: Screen, ctx: Ctx, fixes: string[]): void {
  const { hasField } = audience(ctx, s);
  if (!hasField || s.spec.theme?.layout === 'tv') return;
  let n = 0;
  s.spec.blocks = s.spec.blocks.map((b) => {
    if (b.type !== 'table' || !isOwn(b.tracker) || b.editable.length) return b;
    const table = tableFor(ctx.tables, b.tracker);
    const cols = b.columns.length ? b.columns.length : (table?.fields.length ?? 0);
    if (!table || cols < 5) return b;
    const r = inferFieldRoles(table);
    const keys = b.columns.length ? b.columns : table.fields.map((f) => f.key);
    const has = (k?: string) => (k && keys.includes(k) ? k : undefined);
    const title = has(r.title) ?? keys.find((k) => fieldOf(table, k)?.type === 'text') ?? 'label';
    const status = has(r.status) ?? keys.find((k) => fieldOf(table, k)?.type === 'select');
    const date = keys.find((k) => fieldOf(table, k)?.type === 'date');
    const image = keys.find((k) => fieldOf(table, k)?.type === 'file');
    const data = keys
      .filter((k) => ![title, status, image].includes(k) && fieldOf(table, k)?.type !== 'file')
      .slice(0, 4);
    n++;
    return {
      id: b.id,
      type: 'cards',
      width: b.width,
      tracker: b.tracker,
      filters: b.filters,
      title: b.title,
      titleField: title,
      ...(status ? { statusField: status } : {}),
      ...(image ? { imageField: image } : {}),
      ...(date ? { dateField: date } : {}),
      dataFields: data,
      chips: [
        ...(status ? (['status'] as const) : []),
        ...(date ? (['today'] as const) : []),
      ],
      searchable: b.searchable,
      sortOptions: [],
      pageSize: 12,
      paging: 'more',
      limit: b.limit,
      sort: b.sort,
      actions: b.actions,
      ...(b.openRecord !== undefined ? { openRecord: b.openRecord } : {}),
      ...(b.detailFields ? { detailFields: b.detailFields } : {}),
      ...(b.recordEditable ? { recordEditable: b.recordEditable } : {}),
    } as ViewBlock;
  });
  if (n) fixes.push(`«${s.title}»: ${n} tabla(s) larga(s) pasadas a tarjetas, que se leen mejor en el celular.`);
}

function fixSteps(s: Screen, ctx: Ctx, fixes: string[]): void {
  let n = 0;
  for (const b of s.spec.blocks) {
    if (b.type !== 'form' || b.steps) continue;
    const table = tableFor(ctx.tables, b.tracker);
    if (!table) continue;
    const keys = b.fields.length ? b.fields : table.fields.map((f) => f.key);
    if (keys.length <= 8) continue;
    const steps = formStepsFor(table, keys);
    if (steps.length < 2) continue;
    b.steps = steps;
    n++;
  }
  if (n) fixes.push(`«${s.title}»: formulario(s) de más de 8 campos ahora van por pasos.`);
}

function fixDetails(s: Screen, ctx: Ctx, fixes: string[]): void {
  const detailed = new Set(s.spec.blocks.flatMap((b) => (b.type === 'detail' ? [b.tracker] : [])));
  const added = new Set<string>();
  const related = [...ctx.tables.values()];
  const out: ViewBlock[] = [];
  for (const [i, b] of s.spec.blocks.entries()) {
    out.push(b);
    if (!LISTS.has(b.type) || !('tracker' in b)) continue;
    const slug = b.tracker;
    if (!isOwn(slug) || detailed.has(slug) || added.has(slug)) continue;
    if ('openRecord' in b && b.openRecord === false) continue;
    const table = tableFor(ctx.tables, slug);
    if (!table) continue;
    // Lo pone justo tras el último bloque de lista de esa tabla.
    const lastOfTable = !s.spec.blocks
      .slice(i + 1)
      .some((x) => LISTS.has(x.type) && sourceOf(x) === slug);
    if (!lastOfTable) continue;
    const id = uniqueId({ ...s.spec, blocks: [...s.spec.blocks, ...out] }, `detalle_${slug}`);
    // Sin `pages`: aquí sólo se valida el bloque nuevo, no la distribución.
    const parsed = viewSpecSchema.safeParse({
      ...s.spec,
      pages: undefined,
      blocks: [buildDetailBlock(table, related, id)],
    });
    const detail = parsed.success ? parsed.data.blocks[0] : undefined;
    if (!detail) continue;
    out.push(detail);
    added.add(slug);
    fixes.push(`«${s.title}»: se agregó el detalle de «${table.name}» para abrir cada registro.`);
  }
  if (added.size) s.spec.blocks = out;
}

function alignStatusFields(s: Screen, ctx: Ctx, fixes: string[]): void {
  const byTable = new Map<string, Array<{ block: ViewBlock; key: string; kind: string }>>();
  const push = (b: ViewBlock, key: string | undefined, kind: string) => {
    const slug = sourceOf(b);
    if (!slug || !key) return;
    byTable.set(slug, [...(byTable.get(slug) ?? []), { block: b, key, kind }]);
  };
  for (const b of s.spec.blocks) {
    if (b.type === 'cards' || b.type === 'detail') push(b, b.statusField, 'status');
    else if (b.type === 'gallery') push(b, b.badgeField, 'badge');
    else if (b.type === 'map' || b.type === 'calendar') push(b, b.colorField, 'color');
    else if (b.type === 'board' || b.type === 'zones') push(b, b.groupBy, 'group');
  }
  for (const [slug, uses] of byTable) {
    const keys = new Set(uses.map((u) => u.key));
    if (keys.size < 2) continue;
    const table = tableFor(ctx.tables, slug);
    const group = uses.find((u) => u.kind === 'group')?.key;
    const inferred = table ? inferFieldRoles(table).status : undefined;
    const canonical = group ?? (inferred && keys.has(inferred) ? inferred : uses[0]?.key);
    if (!canonical) continue;
    for (const u of uses) {
      if (u.key === canonical || u.kind === 'group') continue;
      const b = u.block;
      if (b.type === 'cards' || b.type === 'detail') b.statusField = canonical;
      else if (b.type === 'gallery') b.badgeField = canonical;
      else if (b.type === 'map' || b.type === 'calendar') b.colorField = canonical;
    }
    fixes.push(`«${s.title}»: el estado de «${table?.name ?? slug}» se pinta con el mismo campo en todos los bloques, para que los colores coincidan.`);
  }
}

const WIDTH_FOR: Record<number, 'full' | 'half' | 'third'> = {
  1: 'full',
  2: 'half',
  3: 'third',
  4: 'half',
};

function fixMetricsRow(s: Screen, fixes: string[]): void {
  const layout = s.spec.theme?.layout;
  if (layout === 'operator') return;
  const blocks = s.spec.blocks;
  const metrics = blocks.filter((b) => b.type === 'metric');
  if (!metrics.length) return;
  const reorder = layout !== 'tv' && !blocks.some((b) => b.type === 'form');
  let changed = false;
  if (reorder) {
    const firstNon = blocks.findIndex((b) => b.type !== 'metric');
    const lastMetric = blocks.map((b) => b.type).lastIndexOf('metric');
    if (firstNon !== -1 && firstNon < lastMetric) {
      s.spec.blocks = [...metrics, ...blocks.filter((b) => b.type !== 'metric')];
      changed = true;
      fixes.push(`«${s.title}»: las métricas suben al principio.`);
    }
  }
  if (s.spec.pages?.length) return;
  const top: ViewBlock[] = [];
  for (const b of s.spec.blocks) {
    if (b.type !== 'metric') break;
    top.push(b);
  }
  const count = top.length;
  if (count >= 2 && count <= MAX_METRICS) {
    const width = WIDTH_FOR[count] ?? 'third';
    const need = top.some((b) => b.width !== width);
    if (need) {
      for (const b of top) b.width = width;
      if (!changed) fixes.push(`«${s.title}»: las ${count} métricas quedan en una fila.`);
    }
  }
}

function fixSingleGiant(s: Screen, ctx: Ctx, fixes: string[]): void {
  const main = s.spec.blocks.filter((b) => b.type !== 'detail');
  if (main.length !== 1 || s.spec.theme?.layout === 'operator') return;
  const only = main[0];
  if (!only || !GIANT_TYPES.has(only.type) || !('tracker' in only) || !isOwn(only.tracker)) return;
  const table = tableFor(ctx.tables, only.tracker);
  if (!table) return;
  const own = 'filters' in only ? only.filters : [];
  const r = inferFieldRoles(table);
  const first = table.fields.find((f) => f.key === r.status)?.options?.[0];
  const amountType = fieldOf(table, r.amount)?.type;
  const extra: unknown[] = [
    { id: 'resumen_total', type: 'metric', width: 'third', tracker: table.slug, title: `${table.name} en total`, aggregate: 'count', filters: own },
  ];
  if (r.status && first)
    extra.push({ id: 'resumen_estado', type: 'metric', width: 'third', tracker: table.slug, title: `En «${first}»`, aggregate: 'count', tone: 'amber', filters: [{ field: r.status, op: 'eq', value: first }] });
  if (r.amount)
    extra.push({ id: 'resumen_monto', type: 'metric', width: 'third', tracker: table.slug, title: `Total de ${fieldOf(table, r.amount)?.label.toLowerCase()}`, aggregate: 'sum', field: r.amount, format: amountType === 'money' ? 'money' : 'number', tone: 'emerald', filters: own });
  const metrics = extra.slice(0, 3).map((m, i, all) => ({ ...(m as object), width: WIDTH_FOR[all.length] ?? 'third' }));
  const parsed = viewSpecSchema.safeParse({ ...s.spec, blocks: [...metrics, only] });
  if (!parsed.success) return;
  s.spec.blocks = [...parsed.data.blocks.slice(0, -1), ...s.spec.blocks];
  fixes.push(`«${s.title}»: era un solo bloque grande; se le puso una fila de cifras arriba.`);
}

function autoPages(s: Screen, fixes: string[]): void {
  if (s.spec.pages?.length) return;
  const blocks = s.spec.blocks;
  const heavy = strongCount(blocks);
  if (blocks.length <= MAX_BLOCKS && heavy <= MAX_STRONG) return;
  const pages: Array<{ id: string; title: string; blockIds: string[] }> = [];
  let cur: ViewBlock[] = [];
  const flush = () => {
    if (!cur.length) return;
    const head = cur.find((b) => 'title' in b && typeof b.title === 'string' && b.type !== 'metric');
    const raw = head && 'title' in head && typeof head.title === 'string' ? head.title : `Parte ${pages.length + 1}`;
    pages.push({ id: `p${pages.length + 1}`, title: raw.slice(0, 40), blockIds: cur.map((b) => b.id) });
    cur = [];
  };
  for (const b of blocks) {
    const strong = strongCount(cur);
    if (cur.length >= 6 || (isStrong(b) && b.type !== 'metric' && strong >= MAX_STRONG)) flush();
    cur.push(b);
  }
  flush();
  if (pages.length < 2 || pages.length > 8) return;
  s.spec.pages = pages;
  fixes.push(`«${s.title}»: la pantalla pesaba demasiado y se partió en ${pages.length} páginas.`);
}

function downgradeEmphasis(s: Screen, fixes: string[]): void {
  let n = 0;
  for (const group of groupsOf(s.spec)) {
    const strong = group.filter((b) => designOf(b)?.emphasis === 'strong' && b.type !== 'metric');
    const room = MAX_STRONG - (group.some((b) => b.type === 'metric' && isStrong(b)) ? 1 : 0);
    for (const b of strong.slice(Math.max(1, room))) {
      (b as { design?: Record<string, unknown> }).design = { ...designOf(b), emphasis: 'normal' };
      n++;
    }
  }
  if (n) fixes.push(`«${s.title}»: ${n} bloque(s) bajaron de énfasis; sólo 1-2 quedan fuertes.`);
}

// ---------------------------------------------------------------------------
// Auditoría de lo que queda
// ---------------------------------------------------------------------------

function auditScreen(s: Screen, ctx: Ctx): DesignNote[] {
  const notes: DesignNote[] = [];
  const note = (rule: string, message: string) => notes.push({ screen: s.title, rule, message });
  const { fieldOnly, hasField } = audience(ctx, s);
  const layout = s.spec.theme?.layout;

  const detailed = new Set(s.spec.blocks.flatMap((b) => (b.type === 'detail' ? [b.tracker] : [])));
  for (const b of s.spec.blocks) {
    if (!LISTS.has(b.type) || !('tracker' in b) || !isOwn(b.tracker)) continue;
    if (detailed.has(b.tracker) || ('openRecord' in b && b.openRecord === false)) continue;
    detailed.add(b.tracker);
    note('lista_sin_detalle', `La lista de «${b.tracker}» no tiene su detalle: agrega un bloque detail de esa tabla.`);
  }
  for (const b of s.spec.blocks) {
    const table = 'tracker' in b ? tableFor(ctx.tables, b.tracker) : null;
    if (b.type === 'table' && hasField && layout !== 'tv') {
      const cols = b.columns.length || table?.fields.length || 0;
      if (cols >= 5)
        note('tabla_larga', `La tabla «${b.title}» es larga para el celular: usa tarjetas (cards).`);
    }
    if (b.type === 'form' && !b.steps) {
      const asked = b.fields.length || table?.fields.length || 0;
      if (asked > 8)
        note('formulario_largo', `El formulario «${b.title}» pide más de 8 campos: pártelo por pasos (steps).`);
    }
  }
  if (fieldOnly && layout !== 'operator' && layout !== 'tv' && s.spec.blocks.some((b) => b.type === 'form' || b.type === 'cards'))
    note('sin_diseno_operario', 'La usa gente de planta y no tiene el diseño operario (theme.layout "operator").');

  const metrics = s.spec.blocks.filter((b) => b.type === 'metric');
  if (metrics.length > MAX_METRICS && !s.spec.pages?.length)
    note('demasiadas_metricas', `Hay ${metrics.length} métricas: deja las 4 que más importan o reparte en páginas.`);
  for (const group of groupsOf(s.spec)) {
    const strong = strongCount(group);
    if (strong > MAX_STRONG)
      note('jerarquia', `Hay ${strong} bloques fuertes en el mismo lugar: deja 1 o 2 y pasa el resto a otra pantalla o página.`);
  }
  if (s.spec.blocks.length > MAX_BLOCKS && !s.spec.pages?.length)
    note('pantalla_larga', `La pantalla tiene ${s.spec.blocks.length} bloques: pártela en páginas o en dos pantallas.`);
  const main = s.spec.blocks.filter((b) => b.type !== 'detail');
  if (main.length === 1 && main[0] && GIANT_TYPES.has(main[0].type) && layout !== 'operator')
    note('un_solo_bloque', 'Es un solo bloque grande: agrégale cifras arriba o un resumen.');

  const ids = new Set<string>([s.title]);
  for (const b of s.spec.blocks) if ('title' in b && typeof b.title === 'string') ids.add(b.title);
  for (const t of ids)
    if (looksTechnical(t, ctx.ids)) note('titulo_tecnico', `«${t}» parece un nombre técnico: escríbelo como lo diría la persona.`);

  for (const b of s.spec.blocks) {
    if ((b.type === 'metric' || b.type === 'chart' || b.type === 'progress') && b.aggregate !== 'count' && b.field) {
      const t = fieldOf(tableFor(ctx.tables, b.tracker), b.field);
      if (t?.type === 'money' && b.format !== 'money')
        note('dinero_sin_formato', `«${b.title}» suma dinero y no usa format "money".`);
    }
  }
  return notes;
}

function auditApp(draft: AppDraft): DesignNote[] {
  const notes: DesignNote[] = [];
  const screens = draft.screens;
  const home = draft.homeScreen ?? screens[0]?.slug;
  for (const r of draft.roles) {
    const visible = screens.filter((s) => !s.roles.length || s.roles.includes(r.key));
    if (!visible.length) continue;
    const landing = visible.find((s) => s.slug === home) ?? visible[0];
    if (!landing) continue;
    const blocks = landing.spec.blocks;
    const hasEntry = blocks.some((b) => b.type === 'form' || b.type === 'cards' || b.type === 'voice');
    const dashboard = blocks.some((b) => b.type === 'chart' || b.type === 'progress');
    if (isFieldRole(r) && !hasEntry && dashboard)
      notes.push({
        screen: landing.title,
        rule: 'inicio_por_rol',
        message: `«${r.name}» entra a un tablero de gráficos; la gente de planta debería abrir en su lista o en el formulario.`,
      });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export function reviewAppDesign(draft: AppDraft, tableList: PatternTable[]): DesignReview {
  const tables = new Map(tableList.map((t) => [t.slug, t]));
  const names = new Map<string, string>();
  for (const t of tableList) {
    names.set(t.slug, t.name);
    for (const f of t.fields) if (!names.has(f.key)) names.set(f.key, f.label);
  }
  const ctx0 = { tables, names, ids: new Set(names.keys()) };
  const fixes: string[] = [];
  const screens: Screen[] = [];
  const failed: DesignNote[] = [];

  for (const original of draft.screens) {
    const ctx: Ctx = { ...ctx0, draft };
    const copy = structuredClone(original) as Screen;
    const local: string[] = [];
    try {
      fixTitles(copy, ctx, local);
      fixMoney(copy, ctx, local);
      fixOperator(copy, ctx, local);
      fixLongTables(copy, ctx, local);
      fixSteps(copy, ctx, local);
      fixDetails(copy, ctx, local);
      alignStatusFields(copy, ctx, local);
      fixSingleGiant(copy, ctx, local);
      fixMetricsRow(copy, local);
      downgradeEmphasis(copy, local);
      autoPages(copy, local);
    } catch {
      // Una corrección que falla no tumba la revisión: la pantalla queda como venía.
      screens.push(original);
      continue;
    }
    if (!local.length) {
      screens.push(original);
      continue;
    }
    // Una corrección que rompe la pantalla no se aplica.
    const parsed = viewSpecSchema.safeParse(copy.spec);
    const known = [...tables.values()].map((t) => ({ ...t, fields: t.fields }));
    const problems = parsed.success ? checkSpecAgainst(parsed.data, known) : ['no valida'];
    if (!parsed.success || problems.length) {
      failed.push({
        screen: original.title,
        rule: 'autocorreccion_descartada',
        message: `No se pudo corregir sola (${problems[0] ?? 'no valida'}); revisa el diseño a mano.`,
      });
      screens.push(original);
      continue;
    }
    fixes.push(...local);
    screens.push({ ...copy, spec: parsed.data });
  }

  const fixed: AppDraft = { ...draft, screens };
  const ctx: Ctx = { ...ctx0, draft: fixed };
  const notes = [...fixed.screens.flatMap((s) => auditScreen(s, ctx)), ...auditApp(fixed), ...failed];
  // Sin repetir la misma nota.
  const seen = new Set<string>();
  const unique = notes.filter((n) => {
    const k = `${n.screen}|${n.rule}|${n.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { draft: fixed, fixes, notes: unique };
}

/** Las notas como líneas de texto para el modelo. */
export function designNoteLines(notes: DesignNote[]): string[] {
  return notes.map((n) => `${n.screen ? `«${n.screen}»: ` : ''}${n.message}`);
}
