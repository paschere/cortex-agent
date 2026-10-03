import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedProduct } from '../accounting/types';
import {
  CONSUMPTION_WINDOW_DAYS,
  addDaysIso,
  annualTurnover,
  consumption,
  daysOfCover,
  productAlert,
} from './math';
import {
  LOCATION_COLUMNS,
  type LocationRow,
  PRODUCT_COLUMNS,
  type ProductRow,
  type StockAlert,
  num,
  round,
} from './shape';
import type { SheetProductDraft } from './sheet';
import {
  type MovementDraft,
  ensureDefaultLocation,
  lastMovementByProduct,
  levelsToStock,
  loadLevels,
  outflowsSince,
  recordMovements,
} from './stock';

/**
 * EL CATÁLOGO DE INVENTARIO (migración 0183).
 *
 * Lectura para todos (la pantalla, las herramientas, cotizaciones/facturación
 * de 0182 vía `listProducts`) y las tres maneras de llenarlo: a mano, desde una
 * hoja/CSV y desde el programa contable (Siigo, Alegra, QuickBooks), que
 * además trae existencias cuando su API las da:
 *
 *   Siigo       `available_quantity` y `warehouses[{id,name,quantity}]`
 *   Alegra      `inventory.availableQuantity`, `unitCost` y por bodega
 *               `warehouses[{id,name,availableQuantity,minQuantity}]`
 *   QuickBooks  `QtyOnHand` (sólo si `TrackQtyOnHand`), `PurchaseCost`,
 *               `ReorderPoint`
 *
 * Un producto cuyo programa trae existencias queda con `stock_from =
 * 'accounting'`: cada sincronización escribe un ajuste por la diferencia (el
 * libro siempre cuadra con lo último que dijo el programa, y la historia
 * queda). Uno a mano o de hoja lleva su libro en Cortex.
 */

const IN_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_,()]/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Lectura simple (contrato con cotizaciones/facturación, 0182)
// ---------------------------------------------------------------------------

/** Un producto con su existencia total. Lo que otro módulo necesita para cotizar. */
export interface InventoryProduct {
  id: string;
  sku: string | null;
  name: string;
  unit: string;
  category: string | null;
  currency: string;
  /** Precio de venta. */
  price: number | null;
  /** Costo promedio ponderado. */
  cost: number | null;
  /** Existencia total (todas las bodegas); null si no lleva existencias. */
  onHand: number | null;
  trackStock: boolean;
  active: boolean;
  minStock: number | null;
  reorderQty: number | null;
  leadTimeDays: number | null;
  preferredSupplierId: string | null;
  source: ProductRow['source'];
  sourceSystem: string | null;
  sourceRef: string | null;
  stockFrom: ProductRow['stock_from'];
}

export function adaptProduct(row: ProductRow, onHand: number | null): InventoryProduct {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    category: row.category,
    currency: row.currency,
    price: num(row.price),
    cost: num(row.cost),
    onHand: row.track_stock ? (onHand ?? 0) : null,
    trackStock: row.track_stock,
    active: row.active,
    minStock: num(row.min_stock),
    reorderQty: num(row.reorder_qty),
    leadTimeDays: row.lead_time_days,
    preferredSupplierId: row.preferred_supplier_id,
    source: row.source,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    stockFrom: row.stock_from,
  };
}

/**
 * Los productos de la empresa con su existencia. `search` busca en nombre y
 * código. Por defecto sólo los activos.
 */
export async function listProducts(
  db: SupabaseClient,
  opts: { search?: string; limit?: number; includeInactive?: boolean; ids?: string[] } = {},
): Promise<InventoryProduct[]> {
  const rows = await loadProductRows(db, opts);
  const stock = levelsToStock(
    await loadLevels(
      db,
      rows.map((r) => r.id),
    ),
  );
  return rows.map((r) => adaptProduct(r, stock.get(r.id)?.total ?? 0));
}

export async function loadProductRows(
  db: SupabaseClient,
  opts: { search?: string; limit?: number; includeInactive?: boolean; ids?: string[] } = {},
): Promise<ProductRow[]> {
  if (opts.ids) {
    const out: ProductRow[] = [];
    for (const ids of chunks([...new Set(opts.ids)], IN_CHUNK)) {
      if (!ids.length) continue;
      const { data, error } = await db.from('products').select(PRODUCT_COLUMNS).in('id', ids);
      if (error) throw error;
      out.push(...((data ?? []) as ProductRow[]));
    }
    return out;
  }
  let q = db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .order('name')
    .limit(Math.min(opts.limit ?? 5000, 5000));
  if (!opts.includeInactive) q = q.eq('active', true);
  const term = escapeLike(opts.search ?? '');
  if (term) q = q.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ProductRow[];
}

export async function getProductRow(db: SupabaseClient, id: string): Promise<ProductRow | null> {
  const { data, error } = await db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ProductRow | null) ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un producto por id, código exacto o nombre. Varios por nombre = ambiguo: se
 * devuelven los candidatos y no se elige ninguno.
 */
export async function findProduct(
  db: SupabaseClient,
  ref: string,
): Promise<{ product: ProductRow | null; candidates: ProductRow[] }> {
  const text = ref.trim();
  if (!text) return { product: null, candidates: [] };
  if (UUID_RE.test(text)) {
    const p = await getProductRow(db, text);
    return { product: p, candidates: p ? [p] : [] };
  }
  const bySku = await db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .ilike('sku', escapeLike(text))
    .limit(2);
  if (bySku.error) throw bySku.error;
  if ((bySku.data ?? []).length === 1)
    return { product: bySku.data?.[0] as ProductRow, candidates: bySku.data as ProductRow[] };
  const rows = await loadProductRows(db, { search: text, limit: 10 });
  const exact = rows.filter((r) => r.name.toLowerCase() === text.toLowerCase());
  if (exact.length === 1) return { product: exact[0] as ProductRow, candidates: exact };
  return { product: rows.length === 1 ? (rows[0] as ProductRow) : null, candidates: rows };
}

// ---------------------------------------------------------------------------
// El tablero: existencia, valor, consumo, rotación y alerta por producto
// ---------------------------------------------------------------------------

export interface ProductOverview extends InventoryProduct {
  /** Existencia por bodega. */
  byLocation: Record<string, number>;
  /** Existencia × costo promedio. */
  value: number | null;
  /** Salidas por día en los últimos 90 días. */
  dailyUse: number;
  /** Salidas en la ventana. */
  outQty: number;
  daysOfCover: number | null;
  turnover: number | null;
  lastMovementOn: string | null;
  alert: StockAlert;
  supplierName: string | null;
}

export interface InventoryOverview {
  products: ProductOverview[];
  locations: LocationRow[];
  totals: {
    products: number;
    value: number;
    belowMin: number;
    outOfStock: number;
  };
}

export async function loadInventoryOverview(
  db: SupabaseClient,
  opts: { today: string; includeInactive?: boolean; search?: string },
): Promise<InventoryOverview> {
  const since = addDaysIso(opts.today, -CONSUMPTION_WINDOW_DAYS + 1);
  const [rows, levels, outflows, locations] = await Promise.all([
    loadProductRows(db, { includeInactive: opts.includeInactive, search: opts.search }),
    loadLevels(db),
    outflowsSince(db, since),
    db
      .from('stock_locations')
      .select(LOCATION_COLUMNS)
      .order('is_default', { ascending: false })
      .order('name'),
  ]);
  if (locations.error) throw locations.error;
  const stock = levelsToStock(levels);
  const last = lastMovementByProduct(levels);
  const outByProduct = new Map<
    string,
    Array<{ kind: 'salida'; qty: number; occurredOn: string }>
  >();
  for (const o of outflows) {
    const list = outByProduct.get(o.product_id) ?? [];
    list.push({ kind: 'salida', qty: num(o.qty) ?? 0, occurredOn: o.occurred_on });
    outByProduct.set(o.product_id, list);
  }
  const supplierIds = [
    ...new Set(rows.map((r) => r.preferred_supplier_id).filter(Boolean)),
  ] as string[];
  const supplierNames = await supplierNamesById(db, supplierIds);

  const products = rows.map((r): ProductOverview => {
    const s = stock.get(r.id);
    const base = adaptProduct(r, s?.total ?? 0);
    const c = consumption(outByProduct.get(r.id) ?? [], opts.today);
    const onHand = base.onHand ?? 0;
    return {
      ...base,
      byLocation: Object.fromEntries(s?.byLocation ?? []),
      value:
        base.trackStock && base.cost !== null ? round(Math.max(onHand, 0) * base.cost, 2) : null,
      dailyUse: c.daily,
      outQty: c.outQty,
      daysOfCover: base.trackStock ? daysOfCover(onHand, c.daily) : null,
      turnover: base.trackStock ? annualTurnover(onHand, c) : null,
      lastMovementOn: last.get(r.id) ?? null,
      alert: productAlert({
        onHand,
        minStock: base.minStock,
        daily: c.daily,
        leadTimeDays: base.leadTimeDays,
        lastMovementOn: last.get(r.id) ?? null,
        today: opts.today,
        trackStock: base.trackStock && base.active,
      }),
      supplierName: r.preferred_supplier_id
        ? (supplierNames.get(r.preferred_supplier_id) ?? null)
        : null,
    };
  });
  return {
    products,
    locations: (locations.data ?? []) as LocationRow[],
    totals: {
      products: products.length,
      value: round(
        products.reduce((sum, p) => sum + (p.value ?? 0), 0),
        2,
      ),
      belowMin: products.filter((p) => p.alert === 'bajo_minimo').length,
      outOfStock: products.filter((p) => p.alert === 'agotado').length,
    },
  };
}

export async function supplierNamesById(
  db: SupabaseClient,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of chunks([...new Set(ids)], IN_CHUNK)) {
    if (!chunk.length) continue;
    const { data, error } = await db.from('suppliers').select('id, name').in('id', chunk);
    if (error) throw error;
    for (const s of (data ?? []) as Array<{ id: string; name: string }>) out.set(s.id, s.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escribir: a mano
// ---------------------------------------------------------------------------

export interface ProductInput {
  sku?: string | null;
  name?: string;
  unit?: string | null;
  category?: string | null;
  trackStock?: boolean;
  cost?: number | null;
  price?: number | null;
  minStock?: number | null;
  reorderQty?: number | null;
  leadTimeDays?: number | null;
  preferredSupplierId?: string | null;
  active?: boolean;
  notes?: string | null;
}

export class ProductInputError extends Error {}

function cleanProductInput(input: ProductInput, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const nonNeg = (v: number | null | undefined, label: string) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!Number.isFinite(v) || v < 0)
      throw new ProductInputError(`${label}: tiene que ser cero o más.`);
    return v;
  };
  if (input.name !== undefined || creating) {
    const name = (input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!name) throw new ProductInputError('El producto necesita un nombre.');
    out.name = name;
  }
  if (input.sku !== undefined) out.sku = input.sku?.trim().slice(0, 60) || null;
  if (input.unit !== undefined) out.unit = input.unit?.trim().slice(0, 30) || 'und';
  if (input.category !== undefined) out.category = input.category?.trim().slice(0, 120) || null;
  if (input.trackStock !== undefined) out.track_stock = input.trackStock;
  const cost = nonNeg(input.cost, 'Costo');
  if (cost !== undefined) out.cost = cost;
  const price = nonNeg(input.price, 'Precio');
  if (price !== undefined) out.price = price;
  const min = nonNeg(input.minStock, 'Mínimo');
  if (min !== undefined) out.min_stock = min;
  if (input.reorderQty !== undefined) {
    const r = input.reorderQty;
    if (r !== null && (!Number.isFinite(r) || r <= 0))
      throw new ProductInputError('La cantidad a pedir tiene que ser mayor que cero.');
    out.reorder_qty = r;
  }
  if (input.leadTimeDays !== undefined) {
    const d = input.leadTimeDays;
    if (d !== null && (!Number.isInteger(d) || d < 0 || d > 365))
      throw new ProductInputError('Los días de entrega van de 0 a 365.');
    out.lead_time_days = d;
  }
  if (input.preferredSupplierId !== undefined)
    out.preferred_supplier_id = input.preferredSupplierId;
  if (input.active !== undefined) out.active = input.active;
  if (input.notes !== undefined) out.notes = input.notes?.trim().slice(0, 2000) || null;
  return out;
}

export async function createProduct(
  db: SupabaseClient,
  input: ProductInput,
  opts: { userId?: string | null } = {},
): Promise<ProductRow> {
  const values = cleanProductInput(input, true);
  const { data, error } = await db
    .from('products')
    .insert({ ...values, source: 'manual', created_by: opts.userId ?? null })
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error))
      throw new ProductInputError(`Ya hay un producto con el código «${values.sku}».`);
    throw error;
  }
  return data as ProductRow;
}

export async function updateProduct(
  db: SupabaseClient,
  id: string,
  input: ProductInput,
): Promise<ProductRow> {
  const values = cleanProductInput(input, false);
  if (!Object.keys(values).length) {
    const current = await getProductRow(db, id);
    if (!current) throw new ProductInputError('Ese producto ya no existe.');
    return current;
  }
  const { data, error } = await db
    .from('products')
    .update(values)
    .eq('id', id)
    .select(PRODUCT_COLUMNS)
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error))
      throw new ProductInputError(`Ya hay un producto con el código «${values.sku}».`);
    throw error;
  }
  if (!data) throw new ProductInputError('Ese producto ya no existe.');
  return data as ProductRow;
}

// ---------------------------------------------------------------------------
// Escribir: desde una hoja o CSV
// ---------------------------------------------------------------------------

export interface ImportResult {
  created: number;
  updated: number;
  /** Ajustes de existencias escritos. */
  adjusted: number;
  skipped: Array<{ row: number; reason: string }>;
}

/**
 * Crea o actualiza por código (o, sin código, por nombre exacto) y, si la hoja
 * trae existencias, escribe un ajuste por la diferencia con el libro. Los
 * proveedores se buscan o crean en `suppliers` (0181) por NIT o nombre.
 */
export async function importSheetProducts(
  db: SupabaseClient,
  drafts: readonly SheetProductDraft[],
  opts: {
    userId?: string | null;
    today: string;
    resolveSupplier?: (name: string, taxId: string | null) => Promise<string | null>;
  },
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, adjusted: 0, skipped: [] };
  if (!drafts.length) return result;
  const existing = await loadProductRows(db, { includeInactive: true });
  const bySku = new Map(existing.filter((p) => p.sku).map((p) => [p.sku?.toLowerCase(), p]));
  const byName = new Map<string, ProductRow[]>();
  for (const p of existing) {
    const k = p.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const locations = new Map<string, string>();
  const location = async (name: string | null): Promise<string | null> => {
    if (!name) return null;
    const key = name.toLowerCase();
    if (locations.has(key)) return locations.get(key) ?? null;
    const found = await db.from('stock_locations').select('id, name').limit(200);
    if (found.error) throw found.error;
    const hit = ((found.data ?? []) as Array<{ id: string; name: string }>).find(
      (l) => l.name.toLowerCase() === key,
    );
    let id = hit?.id ?? null;
    if (!id) {
      const created = await db
        .from('stock_locations')
        .insert({ name: name.slice(0, 120), created_by: opts.userId ?? null })
        .select('id')
        .single();
      if (created.error) throw created.error;
      id = (created.data as { id: string }).id;
    }
    locations.set(key, id);
    return id;
  };

  const counts: Array<{
    productId: string;
    counted: number;
    locationId: string | null;
    row: number;
  }> = [];
  for (const d of drafts) {
    try {
      const supplierId =
        d.supplierName && opts.resolveSupplier
          ? await opts.resolveSupplier(d.supplierName, d.supplierTaxId)
          : undefined;
      const input: ProductInput = {
        name: d.name,
        sku: d.sku,
        ...(d.unit ? { unit: d.unit } : {}),
        ...(d.category ? { category: d.category } : {}),
        ...(d.cost !== null ? { cost: d.cost } : {}),
        ...(d.price !== null ? { price: d.price } : {}),
        ...(d.minStock !== null ? { minStock: d.minStock } : {}),
        ...(d.reorderQty !== null ? { reorderQty: d.reorderQty } : {}),
        ...(d.leadTimeDays !== null ? { leadTimeDays: d.leadTimeDays } : {}),
        ...(supplierId ? { preferredSupplierId: supplierId } : {}),
      };
      const sameName = byName.get(d.name.toLowerCase()) ?? [];
      const match =
        (d.sku ? bySku.get(d.sku.toLowerCase()) : undefined) ??
        (sameName.length === 1 ? sameName[0] : undefined);
      let product: ProductRow;
      if (match) {
        product = await updateProduct(db, match.id, input);
        result.updated += 1;
      } else {
        const values = cleanProductInput(input, true);
        const { data, error } = await db
          .from('products')
          .insert({ ...values, source: 'sheet', created_by: opts.userId ?? null })
          .select(PRODUCT_COLUMNS)
          .single();
        if (error)
          throw isUniqueViolation(error) ? new ProductInputError('código repetido') : error;
        product = data as ProductRow;
        result.created += 1;
        if (product.sku) bySku.set(product.sku.toLowerCase(), product);
        byName.set(product.name.toLowerCase(), [product]);
      }
      if (d.stock !== null && product.track_stock && product.stock_from === 'cortex')
        counts.push({
          productId: product.id,
          counted: d.stock,
          locationId: await location(d.location),
          row: d.row,
        });
    } catch (err) {
      result.skipped.push({
        row: d.row,
        reason: err instanceof ProductInputError ? err.message : 'no se pudo guardar',
      });
    }
  }

  if (counts.length) {
    const fallback = (await ensureDefaultLocation(db, opts.userId)).id;
    const levels = levelsToStock(
      await loadLevels(
        db,
        counts.map((c) => c.productId),
      ),
    );
    const moves: MovementDraft[] = [];
    for (const c of counts) {
      const loc = c.locationId ?? fallback;
      const system = levels.get(c.productId)?.byLocation.get(loc) ?? 0;
      const diff = round(c.counted - system, 4);
      if (diff === 0) continue;
      moves.push({
        productId: c.productId,
        locationId: loc,
        kind: 'ajuste',
        qty: diff,
        referenceKind: 'importacion',
        referenceLabel: `Hoja de inventario, fila ${c.row}`,
      });
    }
    const written = await recordMovements(db, moves, { userId: opts.userId, today: opts.today });
    result.adjusted = written.inserted;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Escribir: desde el programa contable
// ---------------------------------------------------------------------------

export interface AccountingImportResult {
  created: number;
  updated: number;
  adjusted: number;
}

const SOURCE_SYSTEMS = new Set(['siigo', 'alegra', 'quickbooks']);

/**
 * Lo que trajo una página de productos del programa → `products` (+ ajustes
 * de existencias). Idempotente: re-importar lo mismo no escribe nada.
 *
 *   - Se ata por el id del programa; si no estaba atado, por código (un
 *     producto que alguien creó a mano con el mismo código queda atado).
 *   - Nombre, código, unidad, grupo, precio y estado los manda el programa.
 *     El costo, el mínimo y la cantidad a pedir sólo se llenan si Cortex no
 *     tiene uno (lo que una persona fijó aquí no se pisa).
 *   - Si el programa da existencias, el producto queda con `stock_from =
 *     'accounting'` y se ajusta la diferencia, por bodega si el programa las
 *     da (la bodega del programa se crea aquí con su id).
 */
export async function importAccountingProducts(
  db: SupabaseClient,
  input: {
    provider: string;
    records: readonly NormalizedProduct[];
    userId?: string | null;
    today: string;
  },
): Promise<AccountingImportResult> {
  const result: AccountingImportResult = { created: 0, updated: 0, adjusted: 0 };
  if (!SOURCE_SYSTEMS.has(input.provider) || !input.records.length) return result;
  const system = input.provider;
  const refs = input.records.map((r) => r.externalId);
  const linked = new Map<string, ProductRow>();
  for (const chunk of chunks(refs, IN_CHUNK)) {
    const { data, error } = await db
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('source_system', system)
      .in('source_ref', chunk);
    if (error) throw error;
    for (const p of (data ?? []) as ProductRow[]) linked.set(p.source_ref as string, p);
  }
  const codes = input.records
    .filter((r) => !linked.has(r.externalId) && r.code)
    .map((r) => r.code as string);
  const bySku = new Map<string, ProductRow>();
  for (const chunk of chunks([...new Set(codes)], IN_CHUNK)) {
    const { data, error } = await db
      .from('products')
      .select(PRODUCT_COLUMNS)
      .is('source_system', null)
      .in('sku', chunk);
    if (error) throw error;
    for (const p of (data ?? []) as ProductRow[]) if (p.sku) bySku.set(p.sku.toLowerCase(), p);
  }

  const stockTargets: Array<{ product: ProductRow; record: NormalizedProduct }> = [];
  for (const r of input.records) {
    const name = (r.name ?? r.code ?? '').trim().slice(0, 200);
    if (!name) continue;
    const service = r.kind === 'Servicio';
    const hasStock = !service && (r.stock !== undefined || (r.warehouses?.length ?? 0) > 0);
    const facts: Record<string, unknown> = {
      name,
      unit: r.unit?.trim().slice(0, 30) || 'und',
      category: r.group?.slice(0, 120) ?? null,
      price: r.price ?? null,
      active: r.active !== false,
      track_stock: !service,
    };
    const current =
      linked.get(r.externalId) ?? (r.code ? bySku.get(r.code.toLowerCase()) : undefined);
    if (current) {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(facts))
        if (
          v !== null &&
          String((current as unknown as Record<string, unknown>)[k] ?? '') !== String(v)
        )
          patch[k] = v;
      if (!current.source_system) {
        patch.source_system = system;
        patch.source_ref = r.externalId;
      }
      if (r.code && !current.sku) patch.sku = r.code.slice(0, 60);
      if (num(current.cost) === null && r.cost !== undefined) patch.cost = r.cost;
      if (num(current.min_stock) === null && r.minStock !== undefined) patch.min_stock = r.minStock;
      if (hasStock && current.stock_from !== 'accounting') patch.stock_from = 'accounting';
      let row = current;
      if (Object.keys(patch).length) {
        const { data, error } = await db
          .from('products')
          .update(patch)
          .eq('id', current.id)
          .select(PRODUCT_COLUMNS)
          .single();
        if (error) {
          if (isUniqueViolation(error)) continue;
          throw error;
        }
        row = data as ProductRow;
        result.updated += 1;
      }
      if (hasStock) stockTargets.push({ product: row, record: r });
      continue;
    }
    const { data, error } = await db
      .from('products')
      .insert({
        ...facts,
        sku: r.code?.slice(0, 60) || null,
        cost: r.cost ?? null,
        min_stock: r.minStock ?? null,
        source: 'accounting',
        source_system: system,
        source_ref: r.externalId,
        stock_from: hasStock ? 'accounting' : 'cortex',
        created_by: input.userId ?? null,
      })
      .select(PRODUCT_COLUMNS)
      .single();
    if (error) {
      // Código ya usado por otro producto atado a otro programa: no se pisa.
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    result.created += 1;
    if (hasStock) stockTargets.push({ product: data as ProductRow, record: r });
  }

  if (stockTargets.length)
    result.adjusted = await reconcileAccountingStock(db, system, stockTargets, input);
  return result;
}

async function reconcileAccountingStock(
  db: SupabaseClient,
  system: string,
  targets: Array<{ product: ProductRow; record: NormalizedProduct }>,
  input: { userId?: string | null; today: string },
): Promise<number> {
  const fallback = (await ensureDefaultLocation(db, input.userId)).id;
  // Las bodegas del programa, por su id allá.
  const warehouseRefs = new Map<string, string>();
  for (const t of targets)
    for (const w of t.record.warehouses ?? []) warehouseRefs.set(w.externalId, w.name);
  const locationByRef = new Map<string, string>();
  if (warehouseRefs.size) {
    const { data, error } = await db
      .from('stock_locations')
      .select('id, name, source_ref')
      .eq('source_system', system);
    if (error) throw error;
    for (const l of (data ?? []) as Array<{ id: string; source_ref: string }>)
      locationByRef.set(l.source_ref, l.id);
    for (const [ref, name] of warehouseRefs) {
      if (locationByRef.has(ref)) continue;
      const label =
        `${name || 'Bodega'} (${system === 'quickbooks' ? 'QuickBooks' : system === 'alegra' ? 'Alegra' : 'Siigo'})`.slice(
          0,
          120,
        );
      const created = await db
        .from('stock_locations')
        .insert({
          name: label,
          source_system: system,
          source_ref: ref,
          created_by: input.userId ?? null,
        })
        .select('id')
        .single();
      if (created.error) {
        if (isUniqueViolation(created.error)) continue;
        throw created.error;
      }
      locationByRef.set(ref, (created.data as { id: string }).id);
    }
  }

  const levels = levelsToStock(
    await loadLevels(
      db,
      targets.map((t) => t.product.id),
    ),
  );
  const moves: MovementDraft[] = [];
  for (const { product, record } of targets) {
    if (product.stock_from !== 'accounting' || !product.track_stock) continue;
    const current = levels.get(product.id);
    const wanted = new Map<string, number>();
    const warehouses = (record.warehouses ?? []).filter((w) => locationByRef.has(w.externalId));
    if (warehouses.length)
      for (const w of warehouses) wanted.set(locationByRef.get(w.externalId) as string, w.quantity);
    else if (record.stock !== undefined) {
      // Sin bodegas: el total va a la bodega por defecto y lo demás a cero
      // no se toca (el programa no lo distingue).
      const elsewhere = [...(current?.byLocation ?? new Map())]
        .filter(([loc]) => loc !== fallback)
        .reduce((s, [, q]) => s + q, 0);
      wanted.set(fallback, round(record.stock - elsewhere, 4));
    }
    for (const [loc, qty] of wanted) {
      const have = current?.byLocation.get(loc) ?? 0;
      const diff = round(qty - have, 4);
      if (diff === 0) continue;
      moves.push({
        productId: product.id,
        locationId: loc,
        kind: 'ajuste',
        qty: diff,
        referenceKind: 'sincronizacion',
        referenceId: record.externalId,
        referenceLabel: `Existencias según ${system === 'quickbooks' ? 'QuickBooks' : system === 'alegra' ? 'Alegra' : 'Siigo'}`,
      });
    }
  }
  const written = await recordMovements(db, moves, { userId: input.userId, today: input.today });
  return written.inserted;
}
