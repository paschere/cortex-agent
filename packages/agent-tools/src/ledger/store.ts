import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type CategoryRule,
  type LedgerClassifier,
  MODEL_BATCH,
  MODEL_ITEMS_PER_RUN,
  type RuleDirection,
  type RuleField,
  categorizeByRules,
  ruleMatches,
  signatureOf,
} from './categorize';
import { type DedupRow, findLikelyTwin, pickPrimary, planGroup } from './dedup';
import {
  MOVEMENT_COLUMNS,
  type MovementDraft,
  type MovementRow,
  TWIN_KINDS,
  accountNameKey,
  addDays,
  cleanDraft,
  draftFacts,
  isCategoryKey,
  isCounted,
  normalizeText,
  num,
  rowToMovement,
  sourceKey,
} from './shape';
import type { CashAccount, CategorySource, LedgerMovement, LedgerSourceKind } from './types';

/**
 * EL LIBRO DE PLATA CONTRA LA BASE DE DATOS (migración 0172).
 *
 * Todo lo que escribe en `ledger_movements` pasa por `upsertMovements`, y eso
 * es lo que sostiene las tres promesas del libro:
 *
 *   IDEMPOTENTE. La identidad de una fila es (fuente, sistema, referencia).
 *   Lo que ya estaba se ACTUALIZA por id —nunca se reinserta, nunca cambia de
 *   id, así que un `duplicate_of` que le apunte sigue valiendo— y lo nuevo se
 *   inserta. Si dos corridas insertan lo mismo a la vez, gana el índice único
 *   de la 0172 y la perdedora actualiza.
 *
 *   UNA VEZ POR HECHO REAL. Después de escribir, las filas que comparten
 *   `link_key` se ordenan (dedup.ts: una manda, las demás apuntan), y cada fila
 *   nueva ya liquidada busca su gemelo inequívoco en otra fuente.
 *
 *   LA CATEGORÍA DE UNA PERSONA NO SE TOCA. Una fila nueva entra con la
 *   categoría de las reglas (si alguna la reconoce); una que existe no cambia
 *   de categoría por re-ingerirse. Lo que ninguna regla reconoce espera al
 *   modelo (`categorizePending`), con tope por corrida.
 *
 * Toda lectura revisa `error`. El `db` llega con alcance de empresa.
 */

const IN_CHUNK = 100;
const WRITE_CHUNK = 200;

export interface UpsertResult {
  inserted: string[];
  updated: string[];
  unchanged: number;
  rejected: Array<{ ref: string; reason: string }>;
  /** Filas que quedaron enlazadas como el mismo movimiento de otra fuente. */
  linked: number;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Las filas existentes con estas identidades, por llave de fuente. */
async function existingByKey(
  db: SupabaseClient,
  drafts: MovementDraft[],
): Promise<Map<string, MovementRow>> {
  const groups = new Map<string, { kind: string; system: string; refs: string[] }>();
  for (const d of drafts) {
    const g = `${d.source.kind}\u0001${d.source.system ?? ''}`;
    const entry = groups.get(g) ?? {
      kind: d.source.kind,
      system: d.source.system ?? '',
      refs: [],
    };
    entry.refs.push(d.source.ref);
    groups.set(g, entry);
  }
  const out = new Map<string, MovementRow>();
  for (const g of groups.values()) {
    for (const refs of chunks([...new Set(g.refs)], IN_CHUNK)) {
      const { data, error } = await db
        .from('ledger_movements')
        .select(MOVEMENT_COLUMNS)
        .eq('source_kind', g.kind)
        .eq('source_system', g.system)
        .in('source_ref', refs);
      if (error) throw error;
      for (const row of (data ?? []) as MovementRow[]) {
        out.set(
          sourceKey({ kind: row.source_kind, system: row.source_system, ref: row.source_ref }),
          row,
        );
      }
    }
  }
  return out;
}

const FACT_KEYS = [
  'direction',
  'kind',
  'status',
  'amount',
  'currency',
  'date',
  'due_date',
  'settled_at',
  'outstanding',
  'counterparty_name',
  'counterparty_tax_id',
  'description',
  'doc_number',
  'account_id',
  'link_key',
  'excluded_reason',
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  const na = typeof a === 'string' && a !== '' && !Number.isNaN(Number(a)) ? Number(a) : a;
  const nb = typeof b === 'string' && b !== '' && !Number.isNaN(Number(b)) ? Number(b) : b;
  return na === nb;
}

/** Lo que cambia de una fila existente con este borrador, o null si nada. */
function factChanges(row: MovementRow, draft: MovementDraft): Record<string, unknown> | null {
  const facts = draftFacts(draft);
  const keys =
    draft.merge === 'status'
      ? (['status', 'excluded_reason', 'link_key'] as const)
      : (FACT_KEYS as readonly string[]);
  // Una factura por pagar que el banco ya saldó (payables.ts): si su fuente la
  // vuelve a traer abierta (el programa contable aún no registra el pago),
  // manda el banco. Si la fuente la anula, se anula y suelta la salida.
  const held = Boolean(row.settled_by) && draft.status === 'expected';
  const heldKeys = new Set(['status', 'outstanding', 'settled_at']);
  const patch: Record<string, unknown> = {};
  if (row.settled_by && draft.status === 'cancelled') {
    patch.settled_by = null;
    patch.settled_by_outstanding = null;
  }
  for (const key of keys) {
    if (held && heldKeys.has(key)) continue;
    // Una fuente que no sabe la cuenta o la llave no borra la que otra puso.
    if ((key === 'account_id' || key === 'link_key') && facts[key] == null) continue;
    if (!sameValue((row as unknown as Record<string, unknown>)[key], facts[key]))
      patch[key] = facts[key];
  }
  // Una persona puso la categoría en ESTA llamada (el chat, una hoja con su
  // columna): manda sobre lo que hubiera.
  if (
    draft.categorySource === 'person' &&
    draft.category &&
    (row.category !== draft.category || row.category_source !== 'person')
  ) {
    patch.category = draft.category;
    patch.category_source = 'person';
    patch.category_rule_id = null;
  }
  return Object.keys(patch).length ? patch : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/**
 * Escribir borradores en el libro. Ver la cabecera: idempotente, una vez por
 * hecho real, sin pisar la categoría de una persona. Lo que no pasa la
 * limpieza (`cleanDraft`) sale en `rejected` con el motivo, sin tumbar el resto.
 */
export async function upsertMovements(
  db: SupabaseClient,
  drafts: MovementDraft[],
  opts: { rules?: CategoryRule[]; recordedBy?: string | null; skipDedup?: boolean } = {},
): Promise<UpsertResult> {
  const result: UpsertResult = { inserted: [], updated: [], unchanged: 0, rejected: [], linked: 0 };
  const clean = new Map<string, MovementDraft>();
  for (const draft of drafts) {
    try {
      const c = cleanDraft(draft);
      clean.set(sourceKey(c.source), c);
    } catch (err) {
      result.rejected.push({
        ref: draft.source?.ref ?? '',
        reason: err instanceof Error ? err.message : 'No se pudo leer el movimiento.',
      });
    }
  }
  if (!clean.size) return result;
  const list = [...clean.values()];
  const rules = opts.rules ?? (await loadRules(db));
  const existing = await existingByKey(db, list);
  const now = new Date().toISOString();

  const fresh: Array<Record<string, unknown>> = [];
  const touchedKeys = new Set<string>();
  for (const draft of list) {
    const key = sourceKey(draft.source);
    const row = existing.get(key);
    if (draft.linkKey) touchedKeys.add(draft.linkKey);
    if (row) {
      if (row.link_key) touchedKeys.add(row.link_key);
      const patch = factChanges(row, draft);
      if (!patch) {
        result.unchanged += 1;
        continue;
      }
      const { error } = await db
        .from('ledger_movements')
        .update({ ...patch, updated_at: now })
        .eq('id', row.id);
      if (error) throw error;
      result.updated.push(row.id);
      continue;
    }
    const decision =
      draft.categorySource === 'person' && draft.category
        ? { category: draft.category, source: 'person' as CategorySource, ruleId: null }
        : categorizeByRules(draft, rules);
    fresh.push({
      id: randomUUID(),
      ...draftFacts(draft),
      category: decision?.category ?? null,
      category_source: decision?.source ?? null,
      category_rule_id: decision?.ruleId ?? null,
      recorded_by: draft.recordedBy ?? opts.recordedBy ?? null,
      created_at: now,
      updated_at: now,
    });
  }

  for (const batch of chunks(fresh, WRITE_CHUNK)) {
    const { error } = await db.from('ledger_movements').insert(batch);
    if (!error) {
      result.inserted.push(...batch.map((r) => r.id as string));
      continue;
    }
    if (!isUniqueViolation(error)) throw error;
    // Otra corrida metió alguna de estas a la vez: fila por fila, y la que ya
    // existe se actualiza en vez de insertarse.
    for (const row of batch) {
      const single = await db.from('ledger_movements').insert(row);
      if (!single.error) {
        result.inserted.push(row.id as string);
        continue;
      }
      if (!isUniqueViolation(single.error)) throw single.error;
      const {
        id: _id,
        created_at: _c,
        category: _cat,
        category_source: _cs,
        category_rule_id: _cr,
        recorded_by: _rb,
        ...facts
      } = row;
      const upd = await db
        .from('ledger_movements')
        .update({ ...facts, updated_at: now })
        .eq('source_kind', row.source_kind as string)
        .eq('source_system', row.source_system as string)
        .eq('source_ref', row.source_ref as string);
      if (upd.error) throw upd.error;
      result.updated.push(row.id as string);
    }
  }

  if (!opts.skipDedup) {
    result.linked += await resolveLinkGroups(db, [...touchedKeys]);
    result.linked += await linkTwins(db, result.inserted);
  }
  return result;
}

function toDedup(row: MovementRow): DedupRow {
  return {
    id: row.id,
    kind: row.kind,
    direction: row.direction,
    status: row.status,
    amount: num(row.amount) ?? 0,
    currency: row.currency,
    date: row.date,
    counterpartyName: row.counterparty_name,
    counterpartyTaxId: row.counterparty_tax_id,
    description: row.description,
    sourceKind: row.source_kind,
    sourceSystem: row.source_system || null,
    linkKey: row.link_key,
    duplicateOf: row.duplicate_of,
    createdAt: row.created_at,
  };
}

/**
 * La categoría que una persona puso en una fila que resultó duplicada sube a
 * la que manda: corregir el recibo de Siigo no se pierde porque el banco gane.
 */
async function inheritPersonCategory(
  db: SupabaseClient,
  primary: MovementRow,
  group: MovementRow[],
): Promise<void> {
  if (primary.category_source === 'person') return;
  const person = group.find((r) => r.id !== primary.id && r.category_source === 'person');
  if (!person?.category) return;
  const { error } = await db
    .from('ledger_movements')
    .update({
      category: person.category,
      category_source: 'person',
      category_rule_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', primary.id);
  if (error) throw error;
}

/** Ordenar cada grupo de filas con la misma llave del hecho. Devuelve cuántas se enlazaron. */
export async function resolveLinkGroups(db: SupabaseClient, linkKeys: string[]): Promise<number> {
  let linked = 0;
  for (const keys of chunks([...new Set(linkKeys.filter(Boolean))], IN_CHUNK)) {
    const { data, error } = await db
      .from('ledger_movements')
      .select(MOVEMENT_COLUMNS)
      .in('link_key', keys);
    if (error) throw error;
    const byKey = new Map<string, MovementRow[]>();
    for (const row of (data ?? []) as MovementRow[]) {
      const list = byKey.get(row.link_key as string) ?? [];
      list.push(row);
      byKey.set(row.link_key as string, list);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) {
        // Sola en su grupo: si apuntaba a una fila que tiene OTRA llave (su
        // llave cambió, por ejemplo el número de la factura), vuelve a contar.
        // Un gemelo por coincidencia (la otra sin llave) no se toca aquí.
        const lone = group[0] as MovementRow;
        if (lone.duplicate_of) {
          const { data: target, error: targetError } = await db
            .from('ledger_movements')
            .select('id, link_key')
            .eq('id', lone.duplicate_of)
            .maybeSingle();
          if (targetError) throw targetError;
          const key = (target as { link_key: string | null } | null)?.link_key ?? null;
          if (key && key !== lone.link_key) {
            const { error: e } = await db
              .from('ledger_movements')
              .update({ duplicate_of: null, updated_at: new Date().toISOString() })
              .eq('id', lone.id);
            if (e) throw e;
          }
        }
        continue;
      }
      const plan = planGroup(group.map(toDedup));
      for (const step of plan) {
        const { error: e } = await db
          .from('ledger_movements')
          .update({ duplicate_of: step.duplicateOf, updated_at: new Date().toISOString() })
          .eq('id', step.id);
        if (e) throw e;
        if (step.duplicateOf) linked += 1;
      }
      const primary = pickPrimary(group.map(toDedup));
      const primaryRow = group.find((r) => r.id === primary?.id);
      if (primaryRow) await inheritPersonCategory(db, primaryRow, group);
    }
  }
  return linked;
}

/**
 * Para cada fila nueva ya liquidada, su gemelo inequívoco en otra fuente
 * (dedup.ts). El que manda queda limpio; el otro apunta a él, y si el que
 * pierde mandaba sobre otras, ésas pasan a apuntar al nuevo.
 */
export async function linkTwins(db: SupabaseClient, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const fresh: MovementRow[] = [];
  for (const chunk of chunks(ids, IN_CHUNK)) {
    const { data, error } = await db
      .from('ledger_movements')
      .select(MOVEMENT_COLUMNS)
      .in('id', chunk)
      .eq('status', 'settled')
      .in('kind', [...TWIN_KINDS]);
    if (error) throw error;
    fresh.push(...((data ?? []) as MovementRow[]).filter((r) => !r.duplicate_of));
  }
  if (!fresh.length) return 0;
  let linked = 0;
  const byCurrency = new Map<string, MovementRow[]>();
  for (const r of fresh) {
    const list = byCurrency.get(r.currency) ?? [];
    list.push(r);
    byCurrency.set(r.currency, list);
  }
  for (const [currency, rows] of byCurrency) {
    const dates = rows.map((r) => r.date).sort();
    const { data, error } = await db
      .from('ledger_movements')
      .select(MOVEMENT_COLUMNS)
      .eq('currency', currency)
      .eq('status', 'settled')
      .in('kind', [...TWIN_KINDS])
      .is('duplicate_of', null)
      .gte('date', addDays(dates[0] as string, -3))
      .lte('date', addDays(dates[dates.length - 1] as string, 3))
      .limit(3000);
    if (error) throw error;
    const pool = new Map(((data ?? []) as MovementRow[]).map((r) => [r.id, toDedup(r)]));
    for (const row of rows) {
      const candidate = pool.get(row.id) ?? toDedup(row);
      if (candidate.duplicateOf) continue;
      const twin = findLikelyTwin(candidate, [...pool.values()]);
      if (!twin) continue;
      const primary = pickPrimary([candidate, twin]);
      if (!primary) continue;
      const loser = primary.id === candidate.id ? twin : candidate;
      const now = new Date().toISOString();
      const { error: e1 } = await db
        .from('ledger_movements')
        .update({ duplicate_of: primary.id, updated_at: now })
        .eq('id', loser.id);
      if (e1) throw e1;
      const { error: e2 } = await db
        .from('ledger_movements')
        .update({ duplicate_of: primary.id, updated_at: now })
        .eq('duplicate_of', loser.id);
      if (e2) throw e2;
      pool.set(loser.id, { ...loser, duplicateOf: primary.id });
      linked += 1;
    }
  }
  return linked;
}

// ---------------------------------------------------------------------------
// Reglas de categoría
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string;
  field: RuleField;
  pattern: string;
  direction: RuleDirection;
  category: string;
  hits: number;
}

export async function loadRules(db: SupabaseClient): Promise<CategoryRule[]> {
  const { data, error } = await db
    .from('ledger_category_rules')
    .select('id, field, pattern, direction, category, hits')
    .limit(2000);
  if (error) throw error;
  return ((data ?? []) as RuleRow[]).map((r) => ({
    id: r.id,
    field: r.field,
    pattern: r.pattern,
    direction: r.direction,
    category: r.category,
  }));
}

export interface SaveRuleInput {
  pattern: string;
  field?: RuleField;
  direction?: RuleDirection;
  category: string;
  createdBy?: string | null;
}

/** Guardar (o cambiar) una regla de la empresa. El patrón se normaliza. */
export async function saveRule(db: SupabaseClient, input: SaveRuleInput): Promise<CategoryRule> {
  const pattern = normalizeText(input.pattern).slice(0, 120);
  if (pattern.length < 2) throw new Error('El patrón de la regla es muy corto.');
  if (!isCategoryKey(input.category)) throw new Error('Esa categoría no tiene una forma válida.');
  const field = input.field ?? 'any';
  const direction = input.direction ?? 'any';
  const now = new Date().toISOString();
  const { data: found, error: readError } = await db
    .from('ledger_category_rules')
    .select('id, field, pattern, direction, category, hits')
    .eq('field', field)
    .eq('pattern', pattern)
    .eq('direction', direction)
    .maybeSingle();
  if (readError) throw readError;
  if (found) {
    const { error } = await db
      .from('ledger_category_rules')
      .update({ category: input.category, updated_at: now })
      .eq('id', (found as RuleRow).id);
    if (error) throw error;
    return { id: (found as RuleRow).id, field, pattern, direction, category: input.category };
  }
  const id = randomUUID();
  const { error } = await db.from('ledger_category_rules').insert({
    id,
    field,
    pattern,
    direction,
    category: input.category,
    created_by: input.createdBy ?? null,
    hits: 0,
    created_at: now,
    updated_at: now,
  });
  if (error) throw error;
  return { id, field, pattern, direction, category: input.category };
}

export interface RecategorizeResult {
  rule: CategoryRule;
  updated: number;
  /** Filas que coincidían pero ya tenían una categoría puesta por una persona. */
  keptPerson: number;
  examples: Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    currency: string;
  }>;
}

/**
 * «Los pagos a Rappi son mercadeo»: guarda la regla y la aplica a lo que ya
 * está en el libro. Lo que una persona categorizó a mano en otra cosa NO se
 * cambia — a menos que `overridePerson`, que es esta misma persona diciéndolo
 * explícitamente. Lo que la regla cambia queda como `person`: alguien lo dijo.
 */
export async function recategorize(
  db: SupabaseClient,
  input: SaveRuleInput & { overridePerson?: boolean; scan?: number },
): Promise<RecategorizeResult> {
  const rule = await saveRule(db, input);
  const scan = Math.min(input.scan ?? 5000, 10_000);
  let q = db
    .from('ledger_movements')
    .select(MOVEMENT_COLUMNS)
    .neq('kind', 'transfer')
    .order('date', { ascending: false })
    .limit(scan);
  if (rule.direction !== 'any') q = q.eq('direction', rule.direction);
  const { data, error } = await q;
  if (error) throw error;
  const rows = ((data ?? []) as MovementRow[]).filter((r) =>
    ruleMatches(rule, {
      direction: r.direction,
      kind: r.kind,
      counterpartyName: r.counterparty_name,
      description: r.description,
    }),
  );
  let updated = 0;
  let keptPerson = 0;
  const now = new Date().toISOString();
  const examples: RecategorizeResult['examples'] = [];
  for (const r of rows) {
    if (r.category === rule.category) continue;
    if (r.category_source === 'person' && !input.overridePerson) {
      keptPerson += 1;
      continue;
    }
    const { error: e } = await db
      .from('ledger_movements')
      .update({
        category: rule.category,
        category_source: 'person',
        category_rule_id: rule.id,
        updated_at: now,
      })
      .eq('id', r.id);
    if (e) throw e;
    updated += 1;
    if (examples.length < 5)
      examples.push({
        id: r.id,
        date: r.date,
        description: r.description,
        amount: num(r.amount) ?? 0,
        currency: r.currency,
      });
  }
  if (rule.id && updated > 0) {
    const { data: cur, error: hitsRead } = await db
      .from('ledger_category_rules')
      .select('hits')
      .eq('id', rule.id)
      .maybeSingle();
    if (hitsRead) throw hitsRead;
    const { error: hitsError } = await db
      .from('ledger_category_rules')
      .update({ hits: ((cur as { hits?: number } | null)?.hits ?? 0) + updated })
      .eq('id', rule.id);
    if (hitsError) throw hitsError;
  }
  return { rule, updated, keptPerson, examples };
}

/** Poner a mano la categoría de un movimiento (y de sus duplicados). */
export async function setMovementCategory(
  db: SupabaseClient,
  id: string,
  category: string,
): Promise<boolean> {
  if (!isCategoryKey(category)) throw new Error('Esa categoría no tiene una forma válida.');
  const { data, error } = await db
    .from('ledger_movements')
    .update({
      category,
      category_source: 'person',
      category_rule_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id');
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

// ---------------------------------------------------------------------------
// Lo que ninguna regla reconoció: las reglas otra vez, la memoria, el modelo
// ---------------------------------------------------------------------------

export interface CategorizeCounts {
  byRule: number;
  byMemory: number;
  byModel: number;
  pending: number;
  modelError: string | null;
}

/**
 * Las filas sin categoría: primero las reglas (pudo nacer una regla nueva
 * desde que entraron), después lo que el modelo ya decidió para la misma
 * contraparte, y al final el modelo — como mucho `maxModelItems` por corrida,
 * en tandas de `MODEL_BATCH`. Nunca toca una fila con categoría.
 */
export async function categorizePending(
  db: SupabaseClient,
  opts: { classifier?: LedgerClassifier | null; maxModelItems?: number; scan?: number } = {},
): Promise<CategorizeCounts> {
  const counts: CategorizeCounts = {
    byRule: 0,
    byMemory: 0,
    byModel: 0,
    pending: 0,
    modelError: null,
  };
  const { data, error } = await db
    .from('ledger_movements')
    .select(MOVEMENT_COLUMNS)
    .is('category', null)
    .neq('kind', 'transfer')
    .is('duplicate_of', null)
    .order('date', { ascending: false })
    .limit(Math.min(opts.scan ?? 1000, 5000));
  if (error) throw error;
  const rows = ((data ?? []) as MovementRow[]).filter((r) => r.status !== 'cancelled');
  if (!rows.length) return counts;

  const rules = await loadRules(db);
  const now = () => new Date().toISOString();
  const write = async (
    id: string,
    category: string,
    source: CategorySource,
    ruleId: string | null,
  ) => {
    const { error: e } = await db
      .from('ledger_movements')
      .update({ category, category_source: source, category_rule_id: ruleId, updated_at: now() })
      .eq('id', id)
      .is('category', null);
    if (e) throw e;
  };

  const rest: MovementRow[] = [];
  for (const r of rows) {
    const decision = categorizeByRules(
      {
        direction: r.direction,
        kind: r.kind,
        counterpartyName: r.counterparty_name,
        description: r.description,
        sourceKind: r.source_kind,
      },
      rules,
    );
    if (decision) {
      await write(r.id, decision.category, decision.source, decision.ruleId);
      counts.byRule += 1;
    } else rest.push(r);
  }
  if (!rest.length) return counts;

  // La memoria: lo que el modelo ya dijo para la misma firma.
  const { data: known, error: knownError } = await db
    .from('ledger_movements')
    .select('direction, kind, counterparty_name, description, category')
    .eq('category_source', 'model')
    .order('updated_at', { ascending: false })
    .limit(3000);
  if (knownError) throw knownError;
  const memory = new Map<string, string>();
  for (const k of (known ?? []) as Array<
    Pick<MovementRow, 'direction' | 'kind' | 'counterparty_name' | 'description' | 'category'>
  >) {
    const sig = signatureOf({
      direction: k.direction,
      kind: k.kind,
      counterpartyName: k.counterparty_name,
      description: k.description,
    });
    if (k.category && !memory.has(sig)) memory.set(sig, k.category);
  }

  const forModel: MovementRow[] = [];
  for (const r of rest) {
    const sig = signatureOf({
      direction: r.direction,
      kind: r.kind,
      counterpartyName: r.counterparty_name,
      description: r.description,
    });
    const remembered = memory.get(sig);
    if (remembered) {
      await write(r.id, remembered, 'model', null);
      counts.byMemory += 1;
    } else forModel.push(r);
  }

  const classifier = opts.classifier;
  const cap = Math.max(0, opts.maxModelItems ?? MODEL_ITEMS_PER_RUN);
  if (!classifier || cap === 0) {
    counts.pending = forModel.length;
    return counts;
  }
  // Una sola pregunta por firma: la respuesta vale para todas las filas iguales.
  const bySig = new Map<string, MovementRow[]>();
  for (const r of forModel) {
    const sig = signatureOf({
      direction: r.direction,
      kind: r.kind,
      counterpartyName: r.counterparty_name,
      description: r.description,
    });
    const list = bySig.get(sig) ?? [];
    list.push(r);
    bySig.set(sig, list);
  }
  const asked = [...bySig.entries()].slice(0, cap);
  counts.pending = [...bySig.entries()].slice(cap).reduce((s, [, l]) => s + l.length, 0);
  for (const batch of chunks(asked, MODEL_BATCH)) {
    let answers: Record<string, string> = {};
    try {
      answers = await classifier(
        batch.map(([, list]) => {
          const r = list[0] as MovementRow;
          return {
            id: r.id,
            direction: r.direction,
            kind: r.kind,
            amount: num(r.amount) ?? 0,
            currency: r.currency,
            counterparty: r.counterparty_name,
            description: r.description,
          };
        }),
      );
    } catch (err) {
      counts.modelError =
        err instanceof Error ? err.message.slice(0, 200) : 'el modelo no respondió';
      counts.pending += batch.reduce((s, [, l]) => s + l.length, 0);
      continue;
    }
    for (const [, list] of batch) {
      const category = answers[(list[0] as MovementRow).id];
      if (!category || !isCategoryKey(category)) {
        counts.pending += list.length;
        continue;
      }
      for (const r of list) {
        await write(r.id, category, 'model', null);
        counts.byModel += 1;
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Cuentas de caja
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  name: string;
  name_key: string;
  currency: string;
  balance: number | string;
  balance_at: string;
  balance_source: 'bank' | 'manual' | 'accounting';
  source_kind: LedgerSourceKind;
  source_system: string;
  source_ref: string;
  created_at: string;
  updated_at: string;
}

const ACCOUNT_COLUMNS =
  'id, name, name_key, currency, balance, balance_at, balance_source, source_kind, source_system, source_ref, created_at, updated_at';

export function accountToCash(row: AccountRow): CashAccount {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    balance: num(row.balance) ?? 0,
    balanceAt: row.balance_at,
    source: { kind: row.source_kind, system: row.source_system || null, ref: row.source_ref },
  };
}

export async function listAccounts(db: SupabaseClient): Promise<AccountRow[]> {
  const { data, error } = await db
    .from('ledger_accounts')
    .select(ACCOUNT_COLUMNS)
    .order('name', { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as AccountRow[];
}

export async function findAccount(db: SupabaseClient, name: string): Promise<AccountRow | null> {
  const key = accountNameKey(name);
  if (!key) return null;
  const { data, error } = await db
    .from('ledger_accounts')
    .select(ACCOUNT_COLUMNS)
    .eq('name_key', key)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountRow | null) ?? null;
}

export interface EnsureAccountInput {
  name: string;
  currency: string;
  source: { kind: LedgerSourceKind; system?: string | null; ref: string };
  createdBy?: string | null;
  /** Un saldo conocido, con su fecha y quién lo dijo. */
  balance?: { amount: number; at: string; source: 'bank' | 'manual' | 'accounting' } | null;
}

/**
 * La cuenta con ese nombre, creada si no existe. Un saldo nuevo se guarda sólo
 * si es de la misma fecha o más reciente que el que había — un extracto de
 * marzo importado en junio no pisa el saldo de mayo — salvo que lo diga una
 * persona, que siempre manda. Una cuenta no cambia de moneda.
 */
export async function ensureAccount(
  db: SupabaseClient,
  input: EnsureAccountInput,
): Promise<{ account: AccountRow; created: boolean; balanceUpdated: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 80);
  const key = accountNameKey(name);
  if (!key) throw new Error('La cuenta necesita un nombre.');
  const now = new Date().toISOString();
  const existing = await findAccount(db, name);
  if (existing) {
    const b = input.balance;
    if (!b) return { account: existing, created: false, balanceUpdated: false };
    if (existing.currency !== input.currency) {
      throw new Error(
        `La cuenta «${existing.name}» es en ${existing.currency}; no se le puede poner un saldo en ${input.currency}.`,
      );
    }
    const newer = b.source === 'manual' || b.at >= existing.balance_at;
    if (!newer) return { account: existing, created: false, balanceUpdated: false };
    const patch = {
      balance: b.amount,
      balance_at: b.at,
      balance_source: b.source,
      updated_at: now,
    };
    const { error } = await db.from('ledger_accounts').update(patch).eq('id', existing.id);
    if (error) throw error;
    return {
      account: { ...existing, ...patch },
      created: false,
      balanceUpdated: true,
    };
  }
  const row: AccountRow & { created_by: string | null } = {
    id: randomUUID(),
    name,
    name_key: key,
    currency: input.currency,
    balance: input.balance?.amount ?? 0,
    balance_at: input.balance?.at ?? now.slice(0, 10),
    balance_source: input.balance?.source ?? (input.source.kind === 'bank' ? 'bank' : 'manual'),
    source_kind: input.source.kind,
    source_system: input.source.system ?? '',
    source_ref: input.source.ref.slice(0, 200),
    created_by: input.createdBy ?? null,
    created_at: now,
    updated_at: now,
  };
  const { error } = await db.from('ledger_accounts').insert(row);
  if (error) {
    if (!isUniqueViolation(error)) throw error;
    // Otra corrida la creó a la vez: se usa esa.
    const again = await findAccount(db, name);
    if (!again) throw error;
    return ensureAccount(db, input).then((r) => ({ ...r, created: false }));
  }
  return { account: row, created: true, balanceUpdated: Boolean(input.balance) };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export interface MovementFilter {
  from?: string | null;
  to?: string | null;
  direction?: 'in' | 'out' | null;
  kinds?: string[] | null;
  status?: string[] | null;
  category?: string | null;
  currency?: string | null;
  accountId?: string | null;
  /** Incluir duplicadas, anuladas y en disputa (para auditar). */
  includeUncounted?: boolean;
  limit?: number;
}

export const READ_CAP = 5000;

/** Movimientos del libro, los que cuentan por defecto, del más reciente al más viejo. */
export async function listMovements(
  db: SupabaseClient,
  filter: MovementFilter = {},
): Promise<{ rows: MovementRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(filter.limit ?? READ_CAP, 1), READ_CAP);
  let q = db.from('ledger_movements').select(MOVEMENT_COLUMNS);
  if (filter.from) q = q.gte('date', filter.from);
  if (filter.to) q = q.lte('date', filter.to);
  if (filter.direction) q = q.eq('direction', filter.direction);
  if (filter.kinds?.length) q = q.in('kind', filter.kinds);
  if (filter.status?.length) q = q.in('status', filter.status);
  if (filter.category) q = q.eq('category', filter.category);
  if (filter.currency) q = q.eq('currency', filter.currency);
  if (filter.accountId) q = q.eq('account_id', filter.accountId);
  if (!filter.includeUncounted) {
    q = q.is('duplicate_of', null).neq('status', 'cancelled').is('excluded_reason', null);
  }
  const { data, error } = await q.order('date', { ascending: false }).limit(limit + 1);
  if (error) throw error;
  const rows = ((data ?? []) as MovementRow[]).filter(
    (r) => filter.includeUncounted || isCounted(r),
  );
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Lo que la proyección de caja necesita (ledger/forecast*.ts): las cuentas
 * con su saldo y los movimientos que cuentan —todo lo esperado (por cobrar,
 * por pagar) y lo liquidado de los últimos `historyDays` para detectar lo que
 * se repite y cómo paga cada cliente—, ya en la forma del contrato.
 */
export async function loadLedger(
  db: SupabaseClient,
  opts: { today: string; historyDays?: number; currency?: string | null },
): Promise<{ accounts: CashAccount[]; movements: LedgerMovement[]; truncated: boolean }> {
  const since = addDays(opts.today, -(opts.historyDays ?? 365));
  const [accounts, settled, expected, invoices] = await Promise.all([
    listAccounts(db),
    listMovements(db, { from: since, currency: opts.currency ?? null }),
    listMovements(db, { status: ['expected'], currency: opts.currency ?? null }),
    // Facturas ya pagadas del último año: cómo paga cada cliente.
    listMovements(db, {
      from: since,
      kinds: ['receivable', 'payable'],
      status: ['settled'],
      currency: opts.currency ?? null,
    }),
  ]);
  const byId = new Map<string, MovementRow>();
  for (const r of [...settled.rows, ...expected.rows, ...invoices.rows]) byId.set(r.id, r);
  return {
    accounts: accounts
      .filter((a) => !opts.currency || a.currency === opts.currency)
      .map(accountToCash),
    movements: [...byId.values()].map(rowToMovement),
    truncated: settled.truncated || expected.truncated || invoices.truncated,
  };
}
