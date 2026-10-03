import 'server-only';
import {
  type InventoryOverview,
  type PurchaseOrder,
  type ReorderPlan,
  type SupplierRef,
  addDays,
  buildReorderPlan,
  getPurchaseOrder,
  isCompanyManager,
  listLocations,
  listPurchaseOrders,
  listPurchasingSuppliers,
  loadInventoryOverview,
  productMovements,
  stockConsumption,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PoDetailView, ProductDetailView } from './shape';
import { poDetail, productDetail } from './views';

/**
 * LAS LECTURAS DE /inventario (0183). Con el handle de la empresa; cada pieza
 * revisa su error y la pantalla dice qué no se pudo leer en vez de enseñar
 * ceros.
 */

export interface InventoryData {
  overview: InventoryOverview;
  plan: ReorderPlan;
  orders: PurchaseOrder[];
  suppliers: SupplierRef[];
}

export async function loadInventoryData(db: SupabaseClient, today: string): Promise<InventoryData> {
  const [overview, plan, orders, suppliers] = await Promise.all([
    loadInventoryOverview(db, { today, includeInactive: true }),
    buildReorderPlan(db, { today }),
    listPurchaseOrders(db, { limit: 300 }),
    listPurchasingSuppliers(db),
  ]);
  return { overview, plan, orders, suppliers };
}

export async function loadProductDetail(
  db: SupabaseClient,
  id: string,
  today: string,
): Promise<ProductDetailView | null> {
  const overview = await loadInventoryOverview(db, { today, includeInactive: true });
  const product = overview.products.find((p) => p.id === id);
  if (!product) return null;
  const since = addDays(today, -90 + 1);
  const [movements, recent] = await Promise.all([
    productMovements(db, id, { limit: 100 }),
    productMovements(db, id, { since, limit: 5000 }),
  ]);
  const consumption = stockConsumption(
    recent.map((m) => ({ kind: m.kind, qty: Number(m.qty), occurredOn: m.occurred_on })),
    today,
  );
  return productDetail(product, { movements, consumption, locations: overview.locations });
}

export async function loadPoDetail(
  db: SupabaseClient,
  id: string,
  userId: string,
): Promise<PoDetailView | null> {
  const po = await getPurchaseOrder(db, id);
  if (!po) return null;
  const people = [po.requestedBy, po.approvedBy].filter(Boolean) as string[];
  const [locations, manager, users] = await Promise.all([
    listLocations(db),
    isCompanyManager(db, userId),
    people.length
      ? db.from('users').select('id, name, email').in('id', people)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const names = new Map<string, string>();
  if (!users.error)
    for (const u of (users.data ?? []) as Array<{ id: string; name: string | null; email: string }>)
      names.set(u.id, u.name?.trim() || u.email);
  return poDetail(po, { locations, canApprove: manager, names });
}
