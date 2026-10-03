import type { SupabaseClient } from '@supabase/supabase-js';
import { type ProductStock, averageCostAfter, stockByProduct } from './math';
import {
  LOCATION_COLUMNS,
  type LocationRow,
  MOVEMENT_COLUMNS,
  type MovementKind,
  type MovementRow,
  type ReferenceKind,
  num,
  round,
} from './shape';

/**
 * EL LIBRO DE EXISTENCIAS (migración 0183): bodegas, movimientos y la suma.
 *
 * Las existencias nunca se escriben: son la suma de `stock_movements` (vista
 * `stock_levels`). Escribir un movimiento es la única manera de cambiarlas, y
 * cada una lleva su referencia — así «¿por qué hay 12?» siempre tiene
 * respuesta.
 *
 * El costo promedio ponderado del producto se recalcula aquí, en el momento de
 * cada entrada con costo (math.ts › averageCostAfter), y las salidas se
 * valoran al promedio vigente.
 *
 * Toda lectura revisa `error`; el `db` llega con alcance de empresa.
 */

const IN_CHUNK = 100;
const WRITE_CHUNK = 200;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

// ---------------------------------------------------------------------------
// Bodegas
// ---------------------------------------------------------------------------

export async function listLocations(db: SupabaseClient): Promise<LocationRow[]> {
  const { data, error } = await db
    .from('stock_locations')
    .select(LOCATION_COLUMNS)
    .order('is_default', { ascending: false })
    .order('name')
    .limit(200);
  if (error) throw error;
  return (data ?? []) as LocationRow[];
}

/** La bodega por defecto; la crea («Bodega principal») si la empresa no tiene. */
export async function ensureDefaultLocation(
  db: SupabaseClient,
  userId?: string | null,
): Promise<LocationRow> {
  const found = await db
    .from('stock_locations')
    .select(LOCATION_COLUMNS)
    .eq('is_default', true)
    .maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data as LocationRow;
  const created = await db
    .from('stock_locations')
    .insert({ name: 'Bodega principal', is_default: true, created_by: userId ?? null })
    .select(LOCATION_COLUMNS)
    .single();
  if (created.error) {
    // Otra petición la creó al mismo tiempo: leerla.
    if (isUniqueViolation(created.error)) {
      const again = await db
        .from('stock_locations')
        .select(LOCATION_COLUMNS)
        .eq('is_default', true)
        .maybeSingle();
      if (again.error) throw again.error;
      if (again.data) return again.data as LocationRow;
    }
    throw created.error;
  }
  return created.data as LocationRow;
}

export async function saveLocation(
  db: SupabaseClient,
  input: {
    id?: string;
    name: string;
    code?: string | null;
    address?: string | null;
    userId?: string;
  },
): Promise<LocationRow> {
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('La bodega necesita un nombre.');
  const values = { name, code: input.code?.trim() || null, address: input.address?.trim() || null };
  const q = input.id
    ? db.from('stock_locations').update(values).eq('id', input.id)
    : db.from('stock_locations').insert({ ...values, created_by: input.userId ?? null });
  const { data, error } = await q.select(LOCATION_COLUMNS).single();
  if (error) {
    if (isUniqueViolation(error)) throw new Error(`Ya hay una bodega que se llama «${name}».`);
    throw error;
  }
  return data as LocationRow;
}

/** La bodega por nombre (sin mayúsculas) o id; null si no existe. */
export async function findLocation(
  db: SupabaseClient,
  ref: string | null | undefined,
): Promise<LocationRow | null> {
  const text = (ref ?? '').trim();
  if (!text) return null;
  const all = await listLocations(db);
  const key = text.toLowerCase();
  return (
    all.find(
      (l) => l.id === text || l.name.toLowerCase() === key || l.code?.toLowerCase() === key,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Existencias
// ---------------------------------------------------------------------------

export interface LevelRow {
  product_id: string;
  location_id: string;
  on_hand: number | string;
  last_movement_on: string | null;
  movements: number;
}

/** Las filas de la vista; de todos los productos o de los pedidos. */
export async function loadLevels(
  db: SupabaseClient,
  productIds?: readonly string[],
): Promise<LevelRow[]> {
  const select = 'product_id, location_id, on_hand, last_movement_on, movements';
  if (!productIds) {
    const { data, error } = await db.from('stock_levels').select(select).limit(20_000);
    if (error) throw error;
    return (data ?? []) as LevelRow[];
  }
  const out: LevelRow[] = [];
  for (const ids of chunks([...new Set(productIds)], IN_CHUNK)) {
    if (!ids.length) continue;
    const { data, error } = await db.from('stock_levels').select(select).in('product_id', ids);
    if (error) throw error;
    out.push(...((data ?? []) as LevelRow[]));
  }
  return out;
}

export function levelsToStock(levels: readonly LevelRow[]): Map<string, ProductStock> {
  return stockByProduct(
    levels.map((l) => ({
      productId: l.product_id,
      locationId: l.location_id,
      onHand: num(l.on_hand) ?? 0,
    })),
  );
}

/** El último movimiento de cada producto (de la vista). */
export function lastMovementByProduct(levels: readonly LevelRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of levels) {
    if (!l.last_movement_on) continue;
    const prev = out.get(l.product_id);
    if (!prev || l.last_movement_on > prev) out.set(l.product_id, l.last_movement_on);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Movimientos
// ---------------------------------------------------------------------------

export interface MovementDraft {
  productId: string;
  /** Sin bodega: la por defecto. */
  locationId?: string | null;
  kind: MovementKind;
  /**
   * Entrada y salida: la cantidad (positiva; el signo lo pone el tipo).
   * Ajuste: con signo (+ sobra, − falta). Traslado: positiva, de `locationId`
   * a `toLocationId`.
   */
  qty: number;
  toLocationId?: string | null;
  /** Costo por unidad de una entrada (el de compra). */
  unitCost?: number | null;
  referenceKind?: ReferenceKind;
  referenceId?: string | null;
  referenceLabel?: string | null;
  purchaseOrderId?: string | null;
  note?: string | null;
  occurredOn?: string | null;
  dedupeKey?: string | null;
}

export interface RecordResult {
  inserted: number;
  /** Ya estaban (misma `dedupeKey`): no se repitieron. */
  duplicates: number;
  /** Costo promedio nuevo por producto, para los que cambió. */
  costs: Map<string, number>;
}

export class StockMovementError extends Error {}

interface ProductCostRow {
  id: string;
  name: string;
  cost: number | string | null;
  track_stock: boolean;
}

/**
 * Escribir movimientos. Valida, pone el signo, valora las salidas al promedio
 * vigente, recalcula el costo promedio con cada entrada con costo, y no repite
 * lo que trae una `dedupeKey` ya escrita.
 */
export async function recordMovements(
  db: SupabaseClient,
  drafts: readonly MovementDraft[],
  opts: { userId?: string | null; today: string },
): Promise<RecordResult> {
  const result: RecordResult = { inserted: 0, duplicates: 0, costs: new Map() };
  if (!drafts.length) return result;

  const productIds = [...new Set(drafts.map((d) => d.productId))];
  const products = new Map<string, ProductCostRow>();
  for (const ids of chunks(productIds, IN_CHUNK)) {
    const { data, error } = await db
      .from('products')
      .select('id, name, cost, track_stock')
      .in('id', ids);
    if (error) throw error;
    for (const p of (data ?? []) as ProductCostRow[]) products.set(p.id, p);
  }
  const missing = productIds.filter((id) => !products.has(id));
  if (missing.length) throw new StockMovementError('Uno de los productos ya no existe.');

  const needsDefault = drafts.some((d) => !d.locationId);
  const fallback = needsDefault ? (await ensureDefaultLocation(db, opts.userId)).id : null;
  const totals = levelsToStock(await loadLevels(db, productIds));
  const state = new Map(
    productIds.map((id) => [
      id,
      { onHand: totals.get(id)?.total ?? 0, cost: num(products.get(id)?.cost) },
    ]),
  );
  const costChanged = new Set<string>();

  const rows: Array<Record<string, unknown>> = [];
  for (const d of drafts) {
    const product = products.get(d.productId) as ProductCostRow;
    if (!product.track_stock)
      throw new StockMovementError(`«${product.name}» es un servicio: no lleva existencias.`);
    if (!Number.isFinite(d.qty) || d.qty === 0)
      throw new StockMovementError('La cantidad tiene que ser un número distinto de cero.');
    const location = d.locationId ?? fallback;
    if (!location) throw new StockMovementError('Falta la bodega.');
    const base = {
      product_id: d.productId,
      reference_kind: d.referenceKind ?? (d.kind === 'traslado' ? 'traslado' : 'manual'),
      reference_id: d.referenceId?.slice(0, 120) ?? null,
      reference_label: d.referenceLabel?.slice(0, 200) ?? null,
      purchase_order_id: d.purchaseOrderId ?? null,
      note: d.note?.trim().slice(0, 500) || null,
      occurred_on: d.occurredOn ?? opts.today,
      created_by: opts.userId ?? null,
    };
    const st = state.get(d.productId) as { onHand: number; cost: number | null };

    if (d.kind === 'traslado') {
      if (!d.toLocationId || d.toLocationId === location)
        throw new StockMovementError('Un traslado necesita una bodega de destino distinta.');
      const qty = Math.abs(d.qty);
      const transferId = globalThis.crypto.randomUUID();
      rows.push(
        {
          ...base,
          location_id: location,
          kind: 'traslado',
          qty: -qty,
          unit_cost: st.cost,
          transfer_id: transferId,
          dedupe_key: d.dedupeKey ? `${d.dedupeKey}:sale` : null,
        },
        {
          ...base,
          location_id: d.toLocationId,
          kind: 'traslado',
          qty,
          unit_cost: st.cost,
          transfer_id: transferId,
          dedupe_key: d.dedupeKey ? `${d.dedupeKey}:entra` : null,
        },
      );
      continue;
    }

    const qty =
      d.kind === 'entrada' ? Math.abs(d.qty) : d.kind === 'salida' ? -Math.abs(d.qty) : d.qty;
    const unitCost =
      qty > 0 && d.unitCost !== undefined && d.unitCost !== null && d.unitCost >= 0
        ? d.unitCost
        : st.cost;
    const next = averageCostAfter(st, {
      kind: d.kind,
      qty,
      unitCost: qty > 0 && d.unitCost != null ? d.unitCost : null,
    });
    if (next.cost !== st.cost) costChanged.add(d.productId);
    state.set(d.productId, next);
    rows.push({
      ...base,
      location_id: location,
      kind: d.kind,
      qty: round(qty, 4),
      unit_cost: unitCost,
      transfer_id: null,
      dedupe_key: d.dedupeKey?.slice(0, 200) ?? null,
    });
  }

  // Con llave: de a una, para que una repetida no tumbe a las demás.
  const keyed = rows.filter((r) => r.dedupe_key);
  const loose = rows.filter((r) => !r.dedupe_key);
  for (const row of keyed) {
    const { error } = await db.from('stock_movements').insert(row);
    if (error) {
      if (isUniqueViolation(error)) {
        result.duplicates += 1;
        continue;
      }
      throw error;
    }
    result.inserted += 1;
  }
  for (const batch of chunks(loose, WRITE_CHUNK)) {
    const { error } = await db.from('stock_movements').insert(batch);
    if (error) throw error;
    result.inserted += batch.length;
  }

  // Si todo lo que movía el costo era repetido, el costo no cambia.
  if (result.inserted > 0)
    for (const id of costChanged) {
      const cost = state.get(id)?.cost;
      if (cost === null || cost === undefined) continue;
      const { error } = await db.from('products').update({ cost }).eq('id', id);
      if (error) throw error;
      result.costs.set(id, cost);
    }
  return result;
}

/** Los movimientos de un producto, el más reciente primero. */
export async function productMovements(
  db: SupabaseClient,
  productId: string,
  opts: { limit?: number; since?: string } = {},
): Promise<MovementRow[]> {
  let q = db
    .from('stock_movements')
    .select(MOVEMENT_COLUMNS)
    .eq('product_id', productId)
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.since) q = q.gte('occurred_on', opts.since);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as MovementRow[];
}

/** Las salidas de todos los productos desde un día, para el consumo. */
export async function outflowsSince(
  db: SupabaseClient,
  since: string,
): Promise<
  Array<{ product_id: string; qty: number | string; occurred_on: string; kind: MovementKind }>
> {
  const { data, error } = await db
    .from('stock_movements')
    .select('product_id, qty, occurred_on, kind')
    .eq('kind', 'salida')
    .gte('occurred_on', since)
    .limit(50_000);
  if (error) throw error;
  return (data ?? []) as Array<{
    product_id: string;
    qty: number | string;
    occurred_on: string;
    kind: MovementKind;
  }>;
}

// ---------------------------------------------------------------------------
// Conteo
// ---------------------------------------------------------------------------

export interface CountLine {
  productId: string;
  /** Lo que se contó en la bodega. */
  counted: number;
}

export interface CountResult {
  adjusted: number;
  unchanged: number;
  /** Diferencia valorada al costo promedio (+ sobró, − faltó). */
  value: number;
}

/**
 * Un conteo físico: por cada producto contado, un ajuste por la diferencia con
 * lo que dice el libro en ESA bodega. Lo que cuadra no escribe nada.
 */
export async function applyStockCount(
  db: SupabaseClient,
  input: {
    locationId?: string | null;
    lines: readonly CountLine[];
    userId?: string | null;
    note?: string | null;
    today: string;
  },
): Promise<CountResult> {
  const location = input.locationId ?? (await ensureDefaultLocation(db, input.userId)).id;
  const ids = input.lines.map((l) => l.productId);
  const levels = levelsToStock(await loadLevels(db, ids));
  const costs = new Map<string, number | null>();
  for (const chunk of chunks([...new Set(ids)], IN_CHUNK)) {
    const { data, error } = await db.from('products').select('id, cost').in('id', chunk);
    if (error) throw error;
    for (const p of (data ?? []) as Array<{ id: string; cost: number | string | null }>)
      costs.set(p.id, num(p.cost));
  }
  const drafts: MovementDraft[] = [];
  let value = 0;
  let unchanged = 0;
  const countId = globalThis.crypto.randomUUID();
  for (const line of input.lines) {
    if (!Number.isFinite(line.counted) || line.counted < 0)
      throw new StockMovementError('Lo contado tiene que ser cero o más.');
    const system = levels.get(line.productId)?.byLocation.get(location) ?? 0;
    const diff = round(line.counted - system, 4);
    if (diff === 0) {
      unchanged += 1;
      continue;
    }
    value += diff * (costs.get(line.productId) ?? 0);
    drafts.push({
      productId: line.productId,
      locationId: location,
      kind: 'ajuste',
      qty: diff,
      referenceKind: 'conteo',
      referenceId: countId,
      referenceLabel: `Conteo: había ${system}, se contaron ${line.counted}`,
      note: input.note ?? null,
    });
  }
  const written = await recordMovements(db, drafts, { userId: input.userId, today: input.today });
  return { adjusted: written.inserted, unchanged, value: round(value, 2) };
}
