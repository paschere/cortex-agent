import type { SupabaseClient } from '@supabase/supabase-js';
import { relationParts } from '../../trackers/computed';
import { normalizeMatchText } from '../../trackers/match-shape';
import { type TrackerRow, getTrackerById, getTrackerBySlug, upsertRow } from '../../trackers/store';
import { type ViewRow, matches } from '../../views/compute';
import type { CatalogTracker, ViewFilter } from '../../views/spec';
import { type TemplateContext, dayInBogota, renderTemplate, renderValues } from './engine';
import type { Values } from './match';
import {
  type AutomationAction,
  DEFAULT_RELATED_ROWS,
  MAX_RELATED_ROWS,
  ROLLUP_OP_LABEL,
  type RollupOp,
} from './spec';

/**
 * FILAS RELACIONADAS Y ACUMULADOS (acciones `update_related`, `update_rows` y
 * `rollup` de las automatizaciones).
 *
 * Dos mitades:
 *   - PURA (arriba): aritmética del acumulado, qué cambia en una fila, filtros
 *     con relaciones. Se prueba sin base.
 *   - CON BASE (abajo): `plan*` LEE y arma el plan (qué filas, qué cambiaría) sin
 *     escribir nada; `applyChanges` lo escribe. El simulador usa sólo `plan*` y la
 *     corrida usa los dos, así que lo que se muestra antes de activar la regla
 *     es exactamente lo que después se hace.
 *
 * ANTI-BUCLES. Una fila sólo se escribe si algún valor CAMBIA: lo que ya está
 * como se pide no se toca, no deja suceso y no despierta a otras reglas. Lo que
 * se escribe corre dentro de `withAutomationOrigin` (run.ts), así que los
 * eventos que nacen de ahí llevan la cadena de reglas y su profundidad
 * (`mayFire` / AUTOMATION_MAX_DEPTH): una regla no se dispara a sí misma ni
 * por una vuelta larga. Y el acumulado se calcula SIEMPRE desde las hijas (no
 * «suma uno»): correrlo dos veces deja el mismo número.
 */

// ---------------------------------------------------------------------------
// Pura
// ---------------------------------------------------------------------------

export const ROLLUP_SCAN_LIMIT = 5000;
export const RELATED_SCAN_LIMIT = 2000;

const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim());

/** Un valor guardado como número, o null si no lo es («1.500», «1,5» y «$ 1.500» también). */
export function toNumber(raw: unknown): number | null {
  if (isBlank(raw)) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const t = String(raw)
    .replace(/[^\d,.\-]/g, '')
    .trim();
  if (!t || t === '-') return null;
  // «1.500,25» (coma decimal) o «1,500.25»: el último separador es el decimal.
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let n: number;
  if (lastComma > lastDot) n = Number(t.replace(/\./g, '').replace(',', '.'));
  else if (lastDot > lastComma && lastComma >= 0) n = Number(t.replace(/,/g, ''));
  else if (lastDot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(t)) n = Number(t.replace(/\./g, ''));
  else n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function roundFor(n: number, type: string | undefined): number {
  const f = type === 'money' ? 100 : 1_000_000;
  return Math.round(n * f) / f;
}

/**
 * El acumulado de una lista de valores. `suma` de nada es 0; `promedio`,
 * `mínimo` y `máximo` de nada son null (el campo queda vacío); `conteo` cuenta
 * las filas (con `field`, sólo las que traen un valor).
 */
export function rollupValue(
  op: RollupOp,
  values: ReadonlyArray<unknown>,
  options: { hasField?: boolean } = {},
): number | null {
  if (op === 'count')
    return options.hasField ? values.filter((v) => !isBlank(v)).length : values.length;
  const nums = values.map(toNumber).filter((n): n is number => n !== null);
  if (op === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (!nums.length) return null;
  if (op === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  return op === 'min' ? Math.min(...nums) : Math.max(...nums);
}

export interface Change {
  field: string;
  from: string | number | undefined;
  to: string | number | undefined;
}

const same = (a: unknown, b: unknown) => {
  if (isBlank(a) && isBlank(b)) return true;
  const na = typeof a === 'number' ? a : null;
  const nb = typeof b === 'number' ? b : null;
  if (na !== null && nb !== null) return na === nb;
  if (na !== null || nb !== null) {
    const x = toNumber(a);
    const y = toNumber(b);
    if (
      x !== null &&
      y !== null &&
      /^[\d.,\-\s$]+$/.test(String(a)) &&
      /^[\d.,\-\s$]+$/.test(String(b))
    )
      return x === y;
  }
  return String(a ?? '').trim() === String(b ?? '').trim();
};

/** Qué campos de la fila cambian con estos valores (los que ya están igual no cuentan). */
export function diffValues(current: Values, set: Values): Change[] {
  const out: Change[] = [];
  for (const [field, to] of Object.entries(set)) {
    const from = current[field];
    if (!same(from, to)) out.push({ field, from: isBlank(from) ? undefined : from, to });
  }
  return out;
}

/** Los valores a escribir se ajustan al tipo del campo (un número para un campo de texto va como texto). */
export function adaptSet(
  fields: ReadonlyArray<{ key: string; type: string }>,
  set: Values,
): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(set)) {
    const type = fields.find((f) => f.key === k)?.type;
    if (typeof v === 'number' && type && !['number', 'money', 'checkbox'].includes(type))
      out[k] = String(v);
    else if (typeof v === 'string' && (type === 'number' || type === 'money')) {
      const n = toNumber(v);
      out[k] = n === null ? v : n;
    } else out[k] = v;
  }
  return out;
}

/** El id de la fila a la que apunta un valor de relación (JSON, objeto o id suelto). */
export function relatedId(raw: unknown): string | null {
  return relationParts(raw)?.id ?? null;
}

/**
 * ¿La fila cumple todos los filtros? Los valores de los filtros pueden llevar
 * `{{campo}}` de la fila que disparó la regla. En un campo de relación se
 * compara por el ID de la fila relacionada (el valor guardado es JSON con id y
 * nombre; el filtro puede traer ese JSON, el id o el nombre).
 */
export function rowMatchesWhere(
  tracker: CatalogTracker,
  row: ViewRow,
  where: ReadonlyArray<ViewFilter>,
  ctx: TemplateContext,
  today: string,
): boolean {
  if (!where.length) return true;
  const relKeys = new Set(tracker.fields.filter((f) => f.type === 'relation').map((f) => f.key));
  const prepared: ViewRow = { ...row, values: { ...row.values } };
  for (const k of relKeys) {
    const rel = relationParts(prepared.values[k]);
    if (rel) prepared.values[k] = rel.id;
  }
  for (const f of where) {
    let value = f.value;
    if (typeof value === 'string') {
      value = renderTemplate(value, ctx);
      if (relKeys.has(f.field)) {
        const rel = relationParts(value);
        if (rel) value = rel.id;
        else {
          // Un nombre: se compara con la etiqueta de la relación guardada.
          const label = relationParts(row.values[f.field])?.label;
          if (label && label.trim().toLowerCase() === value.trim().toLowerCase())
            value = relationParts(row.values[f.field])?.id ?? value;
        }
      }
    }
    const filter = { ...f, ...(value !== undefined ? { value } : {}) } as ViewFilter;
    if (!matches(tracker, prepared, filter, today)) return false;
  }
  return true;
}

export interface PlannedRow {
  id: string;
  label: string;
  values: Values;
  /** Lo que cambiaría (vacío = ya estaba como se pide). */
  changes: Change[];
}

export interface RelatedPlan {
  kind: 'update_related' | 'update_rows' | 'link_rows';
  tracker: { id: string; slug: string; name: string } | null;
  /** Todas las filas que cumplen (con o sin cambios), hasta el tope. */
  rows: PlannedRow[];
  /** Cuántas cumplían en total (puede pasar del tope). */
  matched: number;
  max: number;
  capped: boolean;
  /** Por qué no hay filas, si no las hay («esta fila no tiene vuelo»). */
  note?: string;
  set: Values;
}

export interface RollupPlan {
  kind: 'rollup';
  parentTracker: { id: string; slug: string; name: string } | null;
  parents: Array<{
    id: string;
    label: string;
    values: Values;
    children: number;
    from: string | number | undefined;
    to: number | null;
  }>;
  target: string;
  note?: string;
}

export function summarizeChanges(changes: Change[], limit = 4): string {
  const shown = changes
    .slice(0, limit)
    .map((c) => `${c.field}: ${c.from === undefined ? '—' : c.from} → ${c.to === '' ? '—' : c.to}`);
  const more = changes.length > limit ? ` y ${changes.length - limit} más` : '';
  return shown.join(', ') + more;
}

/** El texto del plan (simulador e historial de la corrida). */
export function describeRelatedPlan(plan: RelatedPlan, done = false): string {
  const name = plan.tracker?.name ?? 'otra tabla';
  if (plan.note && !plan.rows.length) return plan.note;
  const changing = plan.rows.filter((r) => r.changes.length);
  const verb = done ? 'Cambié' : 'Cambiaría';
  if (!plan.rows.length)
    return `No hay filas en «${name}» que cumplan; no se ${done ? 'cambió' : 'cambiaría'} nada.`;
  if (!changing.length)
    return `${plan.rows.length} fila${plan.rows.length === 1 ? '' : 's'} de «${name}» ya ${plan.rows.length === 1 ? 'estaba' : 'estaban'} como se pide; nada que cambiar.`;
  const sample = changing
    .slice(0, 3)
    .map((r) => `«${r.label}» (${summarizeChanges(r.changes, 3)})`)
    .join('; ');
  const warn = plan.capped
    ? ` AVISO: cumplen ${plan.matched} filas y el tope es ${plan.max}; sólo ${done ? 'se cambiaron' : 'se cambiarían'} las primeras ${plan.rows.length}.`
    : '';
  return `${verb} ${changing.length} fila${changing.length === 1 ? '' : 's'} de «${name}»: ${sample}${changing.length > 3 ? `; y ${changing.length - 3} más` : ''}.${warn}`;
}

export function describeRollupPlan(
  action: Extract<AutomationAction, { type: 'rollup' }>,
  plan: RollupPlan,
  done = false,
): string {
  if (plan.note && !plan.parents.length) return plan.note;
  const op = ROLLUP_OP_LABEL[action.op];
  return plan.parents
    .map((p) => {
      const to = p.to === null ? 'vacío' : String(p.to);
      const from = p.from === undefined ? 'vacío' : String(p.from);
      if (from === to)
        return `«${p.label}»: ${action.target} ya estaba en ${to} (${op} de ${p.children} fila${p.children === 1 ? '' : 's'}).`;
      return `«${p.label}»: ${action.target} ${done ? 'quedó' : 'quedaría'} en ${to} (antes ${from}; ${op} de ${p.children} fila${p.children === 1 ? '' : 's'}).`;
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Con base
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  label: string;
  values: Values;
  created_at: string;
  updated_at: string;
}

const catalogOf = (t: Pick<TrackerRow, 'slug' | 'name' | 'fields'>): CatalogTracker => ({
  slug: t.slug,
  name: t.name,
  fields: t.fields,
});

async function rowsPointingAt(
  db: SupabaseClient,
  tracker: Pick<TrackerRow, 'id'>,
  via: string,
  parentId: string,
  limit: number,
): Promise<RawRow[]> {
  // El valor de una relación se guarda como JSON de {id, label}: el id (uuid) es
  // único, así que buscarlo como texto no mezcla filas de otro padre; abajo se confirma.
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, created_at, updated_at')
    .eq('tracker_id', tracker.id)
    .ilike(`values->>${via}`, `%${parentId}%`)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as RawRow[]).filter((r) => relatedId(r.values?.[via]) === parentId);
}

async function readRow(db: SupabaseClient, trackerId: string, id: string): Promise<RawRow | null> {
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, created_at, updated_at')
    .eq('id', id)
    .eq('tracker_id', trackerId)
    .maybeSingle();
  if (error) throw error;
  return (data as RawRow | null) ?? null;
}

function plannedRow(tracker: Pick<TrackerRow, 'fields'>, row: RawRow, set: Values): PlannedRow {
  return {
    id: row.id,
    label: row.label,
    values: row.values ?? {},
    changes: diffValues(row.values ?? {}, adaptSet(tracker.fields, set)),
  };
}

/** Subir o bajar por una relación: qué filas, y qué cambiaría en cada una. */
export async function planUpdateRelated(
  db: SupabaseClient,
  input: {
    /** La tabla de la fila que disparó. */
    tracker: TrackerRow;
    rowId: string | undefined;
    action: Extract<AutomationAction, { type: 'update_related' }>;
    ctx: TemplateContext;
    now: Date;
  },
): Promise<RelatedPlan> {
  const { action, ctx } = input;
  const set = renderValues(action.set, ctx);
  const empty = (note: string, tracker: RelatedPlan['tracker'] = null): RelatedPlan => ({
    kind: 'update_related',
    tracker,
    rows: [],
    matched: 0,
    max: 1,
    capped: false,
    note,
    set,
  });

  if (action.up) {
    const field = input.tracker.fields.find((f) => f.key === action.up);
    if (!field || field.type !== 'relation' || !field.tracker)
      return empty(`«${action.up}» no es un campo de relación de «${input.tracker.name}».`);
    const id = relatedId(ctx.after[action.up]);
    if (!id)
      return empty(`Esta fila no tiene «${field.label}» elegido; no hay fila a la que subir.`);
    const target = await getTrackerBySlug(db, field.tracker);
    if (!target) return empty(`La tabla «${field.tracker}» ya no existe.`);
    const info = { id: target.id, slug: target.slug, name: target.name };
    const row = await readRow(db, target.id, id);
    if (!row) return empty(`La fila de «${field.label}» ya no existe.`, info);
    return {
      kind: 'update_related',
      tracker: info,
      rows: [plannedRow(target, row, set)],
      matched: 1,
      max: 1,
      capped: false,
      set,
    };
  }

  const down = action.down;
  if (!down || !input.rowId) return empty('Sin fila de partida para bajar por la relación.');
  const child = await getTrackerBySlug(db, down.tracker);
  if (!child) return empty(`La tabla «${down.tracker}» ya no existe.`);
  const info = { id: child.id, slug: child.slug, name: child.name };
  const via = child.fields.find((f) => f.key === down.via);
  if (!via || via.type !== 'relation' || via.tracker !== input.tracker.slug)
    return empty(
      `«${down.via}» de «${child.name}» no apunta a «${input.tracker.name}»; no hay por dónde bajar.`,
      info,
    );
  const found = await rowsPointingAt(db, child, down.via, input.rowId, RELATED_SCAN_LIMIT);
  const today = dayInBogota(input.now);
  const cat = catalogOf(child);
  const matching = found.filter((r) =>
    rowMatchesWhere(cat, r as ViewRow, action.where ?? [], ctx, today),
  );
  const max = action.max ?? DEFAULT_RELATED_ROWS;
  const taken = matching.slice(0, max);
  return {
    kind: 'update_related',
    tracker: info,
    rows: taken.map((r) => plannedRow(child, r, set)),
    matched: matching.length,
    max,
    capped: matching.length > max,
    note: matching.length ? undefined : `Ninguna fila de «${child.name}» apunta a esta fila.`,
    set,
  };
}

/** Cambiar filas de otra tabla por filtro. */
export async function planUpdateRows(
  db: SupabaseClient,
  input: {
    action: Extract<AutomationAction, { type: 'update_rows' }>;
    ctx: TemplateContext;
    now: Date;
  },
): Promise<RelatedPlan> {
  const { action, ctx } = input;
  const set = renderValues(action.set, ctx);
  const target = await getTrackerBySlug(db, action.tracker);
  if (!target)
    return {
      kind: 'update_rows',
      tracker: null,
      rows: [],
      matched: 0,
      max: 0,
      capped: false,
      note: `La tabla «${action.tracker}» ya no existe.`,
      set,
    };
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, created_at, updated_at')
    .eq('tracker_id', target.id)
    .order('created_at', { ascending: true })
    .limit(RELATED_SCAN_LIMIT);
  if (error) throw error;
  const today = dayInBogota(input.now);
  const cat = catalogOf(target);
  const matching = ((data ?? []) as RawRow[]).filter((r) =>
    rowMatchesWhere(cat, r as ViewRow, action.where, ctx, today),
  );
  const max = action.max ?? DEFAULT_RELATED_ROWS;
  const taken = matching.slice(0, max);
  return {
    kind: 'update_rows',
    tracker: { id: target.id, slug: target.slug, name: target.name },
    rows: taken.map((r) => plannedRow(target, r, set)),
    matched: matching.length,
    max,
    capped: matching.length > max,
    set,
  };
}

/**
 * Escribe un plan. Sólo se tocan las filas que cambian; cada una pasa por
 * `upsertRow` (las mismas reglas, fórmulas, flujo y sucesos que una edición
 * normal). Si alguna falla se siguen las demás y al final se lanza el error:
 * la corrida se reintenta y, como lo ya cambiado ya está igual, no se repite.
 */
export async function applyRelatedPlan(
  db: SupabaseClient,
  plan: RelatedPlan,
  userId: string | null,
  rule?: RuleAttribution,
): Promise<{ changed: number; failures: string[] }> {
  if (!plan.tracker) return { changed: 0, failures: [] };
  const target = await getTrackerById(db, plan.tracker.id);
  if (!target) return { changed: 0, failures: ['La tabla ya no existe.'] };
  let changed = 0;
  const failures: string[] = [];
  const set = adaptSet(target.fields, plan.set);
  for (const row of plan.rows) {
    if (!row.changes.length) continue;
    try {
      await upsertRow(db, {
        tracker: target,
        rowId: row.id,
        values: { ...row.values, ...set },
        userId,
        only: new Set(Object.keys(set)),
      });
      changed += 1;
      if (rule) await recordRuleChange(db, { rowId: row.id, changes: row.changes, rule });
    } catch (err) {
      failures.push(`«${row.label}»: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { changed, failures };
}


/** Quién escribió: la regla (nombre) y por qué (la fila que la despertó). */
export interface RuleAttribution {
  name: string;
  reason?: string;
}

/**
 * Deja constancia en el Historial de la fila de lo que una regla le cambió:
 * un evento por escritura (`kind = 'rule'`), con el antes → después por campo.
 * Nunca rompe la regla: si no se puede anotar, el cambio ya está hecho.
 */
export async function recordRuleChange(
  db: SupabaseClient,
  input: { rowId: string; changes: Change[]; rule: RuleAttribution },
): Promise<void> {
  if (!input.changes.length) return;
  try {
    const changes: Record<string, { from?: unknown; to?: unknown }> = {};
    for (const c of input.changes) changes[c.field] = { from: c.from, to: c.to };
    await db.from('custom_view_events').insert({
      view_id: null,
      block_id: null,
      kind: 'rule',
      action_id: null,
      tracker_row_id: input.rowId,
      changes,
      actor: null,
      actor_kind: 'member',
      rule_name: input.rule.name.slice(0, 120) || 'Regla',
      reason: input.rule.reason ? input.rule.reason.slice(0, 300) : null,
    });
  } catch {
    // La historia es un rastro, no una condición del cambio.
  }
}

/** Los padres que hay que recalcular: el de ahora y, si la fila cambió de padre, el de antes. */
export function parentIdsToRecompute(
  up: string,
  after: Values | null | undefined,
  before: Values | null | undefined,
): string[] {
  const ids = [relatedId(after?.[up]), relatedId(before?.[up])].filter((x): x is string => !!x);
  return [...new Set(ids)];
}

/** Acumular en la fila padre: se recalcula desde TODAS las hijas (nunca «suma uno»). */
export async function planRollup(
  db: SupabaseClient,
  input: {
    /** La tabla hija (la de la fila que disparó). */
    tracker: TrackerRow;
    action: Extract<AutomationAction, { type: 'rollup' }>;
    ctx: TemplateContext;
    before?: Values | null;
    now: Date;
  },
): Promise<RollupPlan> {
  const { action, ctx } = input;
  const bad = (note: string, parent: RollupPlan['parentTracker'] = null): RollupPlan => ({
    kind: 'rollup',
    parentTracker: parent,
    parents: [],
    target: action.target,
    note,
  });
  const rel = input.tracker.fields.find((f) => f.key === action.up);
  if (!rel || rel.type !== 'relation' || !rel.tracker)
    return bad(`«${action.up}» no es un campo de relación de «${input.tracker.name}».`);
  const parentTracker = await getTrackerBySlug(db, rel.tracker);
  if (!parentTracker) return bad(`La tabla «${rel.tracker}» ya no existe.`);
  const info = { id: parentTracker.id, slug: parentTracker.slug, name: parentTracker.name };
  const targetField = parentTracker.fields.find((f) => f.key === action.target);
  if (!targetField || !['number', 'money'].includes(targetField.type) || targetField.formula)
    return bad(
      `«${action.target}» tiene que ser un campo de número o dinero (sin fórmula) de «${parentTracker.name}».`,
      info,
    );
  const ids = parentIdsToRecompute(action.up, ctx.after, input.before);
  if (!ids.length)
    return bad(`Esta fila no tiene «${rel.label}» elegido; no hay fila padre.`, info);

  const today = dayInBogota(input.now);
  const childCat = catalogOf(input.tracker);
  const parents: RollupPlan['parents'] = [];
  for (const id of ids) {
    const parent = await readRow(db, parentTracker.id, id);
    if (!parent) continue; // el padre se borró: nada que acumular
    const children = (
      await rowsPointingAt(db, input.tracker, action.up, id, ROLLUP_SCAN_LIMIT)
    ).filter((r) => rowMatchesWhere(childCat, r as ViewRow, action.where ?? [], ctx, today));
    const raw = rollupValue(
      action.op,
      children.map((c) => (action.field ? c.values?.[action.field] : 1)),
      { hasField: !!action.field },
    );
    parents.push({
      id,
      label: parent.label,
      values: parent.values ?? {},
      children: children.length,
      from: isBlank(parent.values?.[action.target]) ? undefined : parent.values[action.target],
      to: raw === null ? null : roundFor(raw, targetField.type),
    });
  }
  return { kind: 'rollup', parentTracker: info, parents, target: action.target };
}

export async function applyRollupPlan(
  db: SupabaseClient,
  plan: RollupPlan,
  userId: string | null,
  rule?: RuleAttribution,
): Promise<{ changed: number; failures: string[] }> {
  if (!plan.parentTracker) return { changed: 0, failures: [] };
  const target = await getTrackerById(db, plan.parentTracker.id);
  if (!target) return { changed: 0, failures: ['La tabla ya no existe.'] };
  let changed = 0;
  const failures: string[] = [];
  for (const p of plan.parents) {
    const current = p.values[plan.target];
    const unchanged = p.to === null ? isBlank(current) : same(current, p.to);
    if (unchanged) continue;
    try {
      const values: Record<string, unknown> = { ...p.values };
      if (p.to === null) delete values[plan.target];
      else values[plan.target] = p.to;
      await upsertRow(db, {
        tracker: target,
        rowId: p.id,
        values,
        userId,
        only: new Set([plan.target]),
      });
      changed += 1;
      if (rule)
        await recordRuleChange(db, {
          rowId: p.id,
          changes: [
            {
              field: plan.target,
              from: isBlank(current) ? undefined : (current as string | number),
              to: p.to === null ? '' : p.to,
            },
          ],
          rule,
        });
    } catch (err) {
      failures.push(`«${p.label}»: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { changed, failures };
}

// ---------------------------------------------------------------------------
// CASAR FILAS POR CLAVE (acción `link_rows`)
// ---------------------------------------------------------------------------

export const LINK_SCAN_LIMIT = 5000;

/**
 * Las claves de un texto: se parte por «/», «,», «;» o «|» y cada trozo se
 * normaliza (mayúsculas, sin espacios, guiones, puntos ni tildes), de modo que
 * «FLEX 29 / FLEX- 30» da FLEX29 y FLEX30. Los trozos de un solo carácter se ignoran.
 */
export function linkTokens(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(/[\/,;|]+/)
    .map((t) => normalizeMatchText(t))
    .filter((t) => t.length >= 2);
}

/** ¿Estas dos claves se refieren a lo mismo? Por texto (alguna clave en común) o por monto (con tolerancia). */
export function linkMatches(needle: string, candidate: unknown, tolerance?: number): boolean {
  if (tolerance !== undefined) {
    const a = toNumber(needle);
    const b = toNumber(candidate);
    return a !== null && b !== null && Math.abs(a - b) <= tolerance;
  }
  const want = new Set(linkTokens(needle));
  if (!want.size) return false;
  return linkTokens(candidate).some((t) => want.has(t));
}

async function scanRows(db: SupabaseClient, trackerId: string): Promise<RawRow[]> {
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, created_at, updated_at')
    .eq('tracker_id', trackerId)
    .order('created_at', { ascending: true })
    .limit(LINK_SCAN_LIMIT);
  if (error) throw error;
  return (data ?? []) as RawRow[];
}

/**
 * Casar por una clave: busca en otra tabla la fila cuyo campo `on` coincide con lo
 * que dice `value`, y deja la relación puesta.
 *   - `up`: ESTA fila recibe la relación a la ÚNICA fila que coincide (si hay cero o
 *     varias, no se escribe nada y la nota lo dice: para revisar a mano).
 *   - `down`: las filas de otra tabla que coinciden reciben la relación a ESTA fila.
 * Nunca pisa una relación ya puesta (la asignada a mano manda) salvo `overwrite`.
 */
export async function planLinkRows(
  db: SupabaseClient,
  input: {
    tracker: TrackerRow;
    rowId: string | undefined;
    action: Extract<AutomationAction, { type: 'link_rows' }>;
    ctx: TemplateContext;
    now: Date;
  },
): Promise<RelatedPlan> {
  const { action, ctx } = input;
  const extra = renderValues(action.set ?? {}, ctx);
  const none = (note: string, tracker: RelatedPlan['tracker'] = null, set: Values = extra): RelatedPlan => ({
    kind: 'link_rows',
    tracker,
    rows: [],
    matched: 0,
    max: 1,
    capped: false,
    note,
    set,
  });
  if (!input.rowId) return none('Sin fila de partida para casar.');
  const needle = renderTemplate(action.value, ctx).trim();
  if (!needle) return none('La fila no trae todavía el dato con el que se casa; no se casó.');
  const today = dayInBogota(input.now);
  const ownLabel = ctx.label ?? '';

  if (action.up) {
    const field = input.tracker.fields.find((f) => f.key === action.up);
    if (!field || field.type !== 'relation' || !field.tracker)
      return none(`«${action.up}» no es un campo de relación de «${input.tracker.name}».`);
    const own = await readRow(db, input.tracker.id, input.rowId);
    if (!own) return none('La fila ya no existe.');
    if (relatedId(own.values?.[action.up]) && !action.overwrite)
      return none(`Ya tenía «${field.label}» (asignada); no se tocó.`);
    const target = await getTrackerBySlug(db, field.tracker);
    if (!target) return none(`La tabla «${field.tracker}» ya no existe.`);
    const info = { id: target.id, slug: target.slug, name: target.name };
    const cat = catalogOf(target);
    const found = (await scanRows(db, target.id)).filter(
      (r) =>
        linkMatches(needle, r.values?.[action.on], action.tolerance) &&
        rowMatchesWhere(cat, r as ViewRow, action.where ?? [], ctx, today),
    );
    if (!found.length)
      return none(`Ninguna fila de «${target.name}» coincide con «${needle}»; queda sin casar.`, info);
    if (found.length > 1)
      return none(
        `«${needle}» coincide con ${found.length} filas de «${target.name}» (${found
          .slice(0, 3)
          .map((r) => r.label)
          .join(', ')}${found.length > 3 ? '…' : ''}); es dudoso, se deja para casar a mano.`,
        info,
      );
    const hit = found[0] as RawRow;
    const set: Values = { [action.up]: JSON.stringify({ id: hit.id, label: hit.label }), ...extra };
    return {
      kind: 'link_rows',
      tracker: { id: input.tracker.id, slug: input.tracker.slug, name: input.tracker.name },
      rows: [plannedRow(input.tracker, own, set)],
      matched: 1,
      max: 1,
      capped: false,
      note: `Casada con «${hit.label}» de «${target.name}».`,
      set,
    };
  }

  const down = action.down;
  if (!down) return none('Falta la dirección: `up` o `down`.');
  const child = await getTrackerBySlug(db, down.tracker);
  if (!child) return none(`La tabla «${down.tracker}» ya no existe.`);
  const info = { id: child.id, slug: child.slug, name: child.name };
  const via = child.fields.find((f) => f.key === down.via);
  if (!via || via.type !== 'relation' || via.tracker !== input.tracker.slug)
    return none(`«${down.via}» de «${child.name}» no apunta a «${input.tracker.name}».`, info);
  const cat = catalogOf(child);
  const set: Values = { [down.via]: JSON.stringify({ id: input.rowId, label: ownLabel }), ...extra };
  const hits = (await scanRows(db, child.id)).filter(
    (r) =>
      (action.overwrite || !relatedId(r.values?.[down.via])) &&
      linkMatches(needle, r.values?.[action.on], action.tolerance) &&
      rowMatchesWhere(cat, r as ViewRow, action.where ?? [], ctx, today),
  );
  const max = action.max ?? DEFAULT_RELATED_ROWS;
  return {
    kind: 'link_rows',
    tracker: info,
    rows: hits.slice(0, max).map((r) => plannedRow(child, r, set)),
    matched: hits.length,
    max,
    capped: hits.length > max,
    note: hits.length ? undefined : `Ninguna fila libre de «${child.name}» coincide con «${needle}».`,
    set,
  };
}

export { MAX_RELATED_ROWS };
