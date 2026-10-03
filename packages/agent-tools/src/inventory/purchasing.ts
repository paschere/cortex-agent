import type { SupabaseClient } from '@supabase/supabase-js';
import { buildClientIndex, resolveAgainst } from '../clients/identity';
import { isCompanyManager, orgAdmins } from '../directory/store';
import type { MovementDraft as LedgerDraft } from '../ledger/shape';
import { upsertMovements } from '../ledger/store';
import { cleanNit, supplierNameKey } from '../payables/shape';
import {
  type ReorderInput,
  type ReorderSuggestion,
  type SupplierGroup,
  addDaysIso,
  expectedPaymentDue,
  groupBySupplier,
  planReceipt,
  poTotals,
  reorderSuggestions,
} from './math';
import { loadInventoryOverview } from './products';
import {
  PO_COLUMNS,
  PO_INBOUND,
  PO_INVOICEABLE,
  PO_LINE_COLUMNS,
  PO_STATUS_LABEL,
  type PoLineRow,
  type PoStatus,
  type PurchaseOrderRow,
  PurchaseOrderStateError,
  assertPoMove,
  num,
  parsePoNumber,
  poLabel,
  round,
} from './shape';
import { type MovementDraft, ensureDefaultLocation, recordMovements } from './stock';

/**
 * COMPRAS: DE «HAY QUE PEDIR» A LA FACTURA DEL PROVEEDOR (migración 0183).
 *
 *   sugerencias de reposición ─→ borradores agrupados por proveedor
 *        ─→ por aprobar (una aprobación en /approvals, en lote si son varias)
 *        ─→ aprobada (el libro de plata la ve como «por pagar» esperado)
 *        ─→ enviada (correo al proveedor con el PDF de la orden)
 *        ─→ recibida en parte / recibida (entradas al libro de existencias)
 *        ─→ facturada (la factura del proveedor, 0181, la cubre) ─→ cerrada
 *
 * EL PROVEEDOR es `public.suppliers` (0181): a quién se le paga. Se encuentra
 * con el mismo motor de identidad que los clientes (clients/identity.ts): por
 * NIT primero, por nombre después, y nunca se elige entre dos parecidos.
 *
 * LA APROBACIÓN es la cola de siempre (`mcp_pending_actions`): una fila por
 * orden con `purchasing.send_po`, para quien aprueba las compras de ese
 * proveedor (`suppliers.approver_id`) o, si no hay, quien pidió la orden si
 * administra la empresa, o el primer administrador. Aprobarla aprueba y envía;
 * como son la misma herramienta, «Aprobar las 6» las aprueba juntas.
 *
 * EL CONTRATO CON CUENTAS POR PAGAR (0181): `listOpenPurchaseOrders` y
 * `markPurchaseOrderInvoiced`. Lo demás es de esta pantalla y del chat.
 */

const IN_CHUNK = 100;
const APPROVAL_TTL_MS = 14 * 24 * 60 * 60_000;
/** La fuente del «por pagar» esperado en el libro de plata. */
export const PO_LEDGER_SYSTEM = 'orden de compra';

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

export interface SupplierRef {
  id: string;
  name: string;
  nit: string | null;
  email: string | null;
  termsDays: number | null;
  approverId: string | null;
}

interface SupplierDbRow {
  id: string;
  name: string;
  nit: string | null;
  email: string | null;
  payment_terms_days: number | null;
  approver_id: string | null;
}

const SUPPLIER_SELECT = 'id, name, nit, email, payment_terms_days, approver_id';

function adaptSupplier(r: SupplierDbRow): SupplierRef {
  return {
    id: r.id,
    name: r.name,
    nit: r.nit,
    email: r.email,
    termsDays: r.payment_terms_days,
    approverId: r.approver_id,
  };
}

export async function listSuppliers(db: SupabaseClient): Promise<SupplierRef[]> {
  const { data, error } = await db
    .from('suppliers')
    .select(SUPPLIER_SELECT)
    .order('name')
    .limit(2000);
  if (error) throw error;
  return ((data ?? []) as SupplierDbRow[]).map(adaptSupplier);
}

export interface SupplierResolution {
  supplier: SupplierRef | null;
  /** Varios igual de buenos: no se elige ninguno. */
  candidates: SupplierRef[];
  created: boolean;
}

/**
 * El proveedor por id, NIT o nombre, con el motor de identidad de clientes.
 * Con `create`, si no hay ninguno (ni ambiguo), se registra.
 */
export async function resolveSupplier(
  db: SupabaseClient,
  input: {
    supplierId?: string | null;
    name?: string | null;
    taxId?: string | null;
    email?: string | null;
  },
  opts: { create?: boolean; userId?: string | null } = {},
): Promise<SupplierResolution> {
  if (input.supplierId) {
    const { data, error } = await db
      .from('suppliers')
      .select(SUPPLIER_SELECT)
      .eq('id', input.supplierId)
      .maybeSingle();
    if (error) throw error;
    const s = data ? adaptSupplier(data as SupplierDbRow) : null;
    return { supplier: s, candidates: s ? [s] : [], created: false };
  }
  const all = await listSuppliers(db);
  const byId = new Map(all.map((s) => [s.id, s]));
  const index = buildClientIndex({
    clients: all.map((s) => ({ id: s.id, name: s.name, tax_id: s.nit })),
  });
  const r = resolveAgainst(index, { taxId: input.taxId ?? null, name: input.name ?? null });
  if (r.client && !r.ambiguous && !r.conflict) {
    const s = byId.get(r.client.clientId) ?? null;
    if (s && input.email && !s.email) {
      const { error } = await db.from('suppliers').update({ email: input.email }).eq('id', s.id);
      if (error) throw error;
      s.email = input.email;
    }
    return { supplier: s, candidates: s ? [s] : [], created: false };
  }
  const candidates = r.candidates.map((c) => byId.get(c.clientId)).filter(Boolean) as SupplierRef[];
  if (r.ambiguous || r.conflict || !opts.create || !input.name?.trim())
    return { supplier: null, candidates, created: false };
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 200);
  const { data, error } = await db
    .from('suppliers')
    .insert({
      name,
      name_key: supplierNameKey(name),
      nit: cleanNit(input.taxId),
      email: input.email?.trim().toLowerCase() || null,
      created_by: opts.userId ?? null,
    })
    .select(SUPPLIER_SELECT)
    .single();
  if (error) {
    if (isUniqueViolation(error)) return { supplier: null, candidates, created: false };
    throw error;
  }
  return { supplier: adaptSupplier(data as SupplierDbRow), candidates: [], created: true };
}

// ---------------------------------------------------------------------------
// Órdenes: lectura
// ---------------------------------------------------------------------------

export interface PurchaseOrderLine {
  id: string;
  productId: string | null;
  position: number;
  description: string;
  unit: string;
  qty: number;
  unitCost: number;
  taxRate: number;
  qtyReceived: number;
  pending: number;
  lineTotal: number;
}

export interface PurchaseOrder {
  id: string;
  number: number;
  label: string;
  status: PoStatus;
  statusLabel: string;
  supplierId: string | null;
  supplierName: string;
  supplierTaxId: string | null;
  supplierEmail: string | null;
  currency: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  expectedOn: string | null;
  locationId: string | null;
  termsDays: number;
  notes: string | null;
  origin: PurchaseOrderRow['origin'];
  approvalId: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  sentTo: string | null;
  receivedAt: string | null;
  invoicedAt: string | null;
  payableId: string | null;
  cancelledReason: string | null;
  createdAt: string;
  lines: PurchaseOrderLine[];
}

function adaptLine(l: PoLineRow): PurchaseOrderLine {
  const qty = num(l.qty) ?? 0;
  const received = num(l.qty_received) ?? 0;
  const unitCost = num(l.unit_cost) ?? 0;
  return {
    id: l.id,
    productId: l.product_id,
    position: l.position,
    description: l.description,
    unit: l.unit,
    qty,
    unitCost,
    taxRate: num(l.tax_rate) ?? 0,
    qtyReceived: received,
    pending: round(Math.max(qty - received, 0), 4),
    lineTotal: round(qty * unitCost, 2),
  };
}

export function adaptPurchaseOrder(row: PurchaseOrderRow, lines: PoLineRow[]): PurchaseOrder {
  return {
    id: row.id,
    number: row.number,
    label: poLabel(row.number),
    status: row.status,
    statusLabel: PO_STATUS_LABEL[row.status],
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierTaxId: row.supplier_tax_id,
    supplierEmail: row.supplier_email,
    currency: row.currency,
    subtotal: num(row.subtotal) ?? 0,
    taxTotal: num(row.tax_total) ?? 0,
    total: num(row.total) ?? 0,
    expectedOn: row.expected_on,
    locationId: row.location_id,
    termsDays: row.payment_terms_days,
    notes: row.notes,
    origin: row.origin,
    approvalId: row.approval_id,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    sentTo: row.sent_to,
    receivedAt: row.received_at,
    invoicedAt: row.invoiced_at,
    payableId: row.payable_id,
    cancelledReason: row.cancelled_reason,
    createdAt: row.created_at,
    lines: [...lines].sort((a, b) => a.position - b.position).map(adaptLine),
  };
}

async function linesFor(
  db: SupabaseClient,
  poIds: readonly string[],
): Promise<Map<string, PoLineRow[]>> {
  const out = new Map<string, PoLineRow[]>();
  for (const ids of chunks([...new Set(poIds)], IN_CHUNK)) {
    if (!ids.length) continue;
    const { data, error } = await db
      .from('purchase_order_lines')
      .select(PO_LINE_COLUMNS)
      .in('purchase_order_id', ids)
      .order('position');
    if (error) throw error;
    for (const l of (data ?? []) as PoLineRow[])
      out.set(l.purchase_order_id, [...(out.get(l.purchase_order_id) ?? []), l]);
  }
  return out;
}

export async function listPurchaseOrders(
  db: SupabaseClient,
  opts: { statuses?: readonly PoStatus[]; supplierTaxId?: string | null; limit?: number } = {},
): Promise<PurchaseOrder[]> {
  let q = db
    .from('purchase_orders')
    .select(PO_COLUMNS)
    .order('number', { ascending: false })
    .limit(Math.min(opts.limit ?? 200, 1000));
  if (opts.statuses?.length) q = q.in('status', [...opts.statuses]);
  if (opts.supplierTaxId) q = q.eq('supplier_tax_id', opts.supplierTaxId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as PurchaseOrderRow[];
  const lines = await linesFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => adaptPurchaseOrder(r, lines.get(r.id) ?? []));
}

/** Una orden por id o por número («OC-0007», «7»). */
export async function getPurchaseOrder(
  db: SupabaseClient,
  ref: string,
): Promise<PurchaseOrder | null> {
  const text = ref.trim();
  let q = db.from('purchase_orders').select(PO_COLUMNS);
  if (UUID_RE.test(text)) q = q.eq('id', text);
  else {
    const n = parsePoNumber(text);
    if (n === null) return null;
    q = q.eq('number', n);
  }
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as PurchaseOrderRow;
  const lines = await linesFor(db, [row.id]);
  return adaptPurchaseOrder(row, lines.get(row.id) ?? []);
}

async function requirePo(db: SupabaseClient, ref: string): Promise<PurchaseOrder> {
  const po = await getPurchaseOrder(db, ref);
  if (!po) throw new PurchaseOrderStateError('No encontré esa orden de compra.');
  return po;
}

// ---------------------------------------------------------------------------
// Contrato con cuentas por pagar (0181)
// ---------------------------------------------------------------------------

/**
 * Las órdenes que una factura de proveedor puede cubrir: aprobadas, enviadas o
 * recibidas, sin factura todavía. Con `supplierTaxId` (NIT sin DV), sólo las de
 * ese proveedor.
 */
export async function listOpenPurchaseOrders(
  db: SupabaseClient,
  opts: { supplierTaxId?: string | null } = {},
): Promise<PurchaseOrder[]> {
  const nit = opts.supplierTaxId ? cleanNit(opts.supplierTaxId) : null;
  if (opts.supplierTaxId && !nit) return [];
  return listPurchaseOrders(db, { statuses: PO_INVOICEABLE, supplierTaxId: nit, limit: 500 });
}

/**
 * La factura del proveedor (`payable_id`, de 0181) cubre esta orden: queda
 * facturada y su «por pagar» esperado sale del libro de plata (lo reemplaza la
 * factura real). Idempotente con la misma factura.
 */
export async function markPurchaseOrderInvoiced(
  db: SupabaseClient,
  poId: string,
  payableId: string,
  opts: { today?: string } = {},
): Promise<PurchaseOrder> {
  const po = await requirePo(db, poId);
  if (po.status === 'facturada' && po.payableId === payableId) return po;
  if (po.payableId && po.payableId !== payableId)
    throw new PurchaseOrderStateError(`La orden ${po.label} ya está cubierta por otra factura.`);
  if (!PO_INVOICEABLE.includes(po.status)) assertPoMove(po.status, 'facturada', po.label);
  const { data, error } = await db
    .from('purchase_orders')
    .update({ status: 'facturada', payable_id: payableId, invoiced_at: new Date().toISOString() })
    .eq('id', po.id)
    .eq('status', po.status)
    .select(PO_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new PurchaseOrderStateError(`La orden ${po.label} cambió mientras se facturaba.`);
  const next = adaptPurchaseOrder(data as PurchaseOrderRow, []);
  next.lines = po.lines;
  await syncPoLedger(db, next, { today: opts.today ?? new Date().toISOString().slice(0, 10) });
  return next;
}

// ---------------------------------------------------------------------------
// El libro de plata: lo comprometido
// ---------------------------------------------------------------------------

/**
 * La orden en el libro de plata. Aprobada en adelante y sin factura: un «por
 * pagar» esperado por el total, con vencimiento = llegada + plazo, para que la
 * proyección de caja vea las compras comprometidas. Cancelada o facturada: la
 * misma fila, cancelada (la factura real, de 0181, toma su lugar).
 */
export async function syncPoLedger(
  db: SupabaseClient,
  po: PurchaseOrder,
  opts: { today: string; userId?: string | null },
): Promise<void> {
  const committed = ['aprobada', 'enviada', 'recibida_parcial', 'recibida'].includes(po.status);
  const approvedOn = (po.approvedAt ?? po.createdAt).slice(0, 10);
  if (!committed && !po.approvedAt) return;
  const draft: LedgerDraft = {
    direction: 'out',
    kind: 'payable',
    status: committed ? 'expected' : 'cancelled',
    amount: po.total,
    currency: po.currency,
    date: approvedOn,
    dueDate: expectedPaymentDue({ approvedOn, expectedOn: po.expectedOn, termsDays: po.termsDays }),
    outstanding: committed ? po.total : null,
    counterpartyName: po.supplierName,
    counterpartyTaxId: po.supplierTaxId,
    description: `Orden de compra ${po.label} · ${po.supplierName}`,
    docNumber: po.label,
    category: 'proveedores',
    categorySource: 'rule',
    recordedBy: opts.userId ?? null,
    source: { kind: 'manual', system: PO_LEDGER_SYSTEM, ref: `oc:${po.id}` },
  };
  await upsertMovements(db, [draft], { recordedBy: opts.userId ?? null, skipDedup: true });
}

// ---------------------------------------------------------------------------
// Reposición: sugerencias con lo que ya viene en camino
// ---------------------------------------------------------------------------

export interface ReorderPlan {
  suggestions: ReorderSuggestion[];
  groups: SupplierGroup[];
  currency: string;
}

/** Lo que hay que pedir hoy, ya descontado lo que viene en órdenes abiertas. */
export async function buildReorderPlan(
  db: SupabaseClient,
  opts: { today: string; productIds?: readonly string[] },
): Promise<ReorderPlan> {
  const [overview, open] = await Promise.all([
    loadInventoryOverview(db, { today: opts.today }),
    listPurchaseOrders(db, { statuses: [...PO_INBOUND, 'borrador', 'por_aprobar'], limit: 500 }),
  ]);
  const onOrder = new Map<string, number>();
  const lastCost = new Map<string, number>();
  // Lo pedido en borradores o por aprobar también cuenta: no se sugiere dos veces.
  for (const po of open)
    for (const l of po.lines) {
      if (!l.productId) continue;
      onOrder.set(l.productId, round((onOrder.get(l.productId) ?? 0) + l.pending, 4));
      if (!lastCost.has(l.productId) && l.unitCost > 0) lastCost.set(l.productId, l.unitCost);
    }
  const wanted = opts.productIds ? new Set(opts.productIds) : null;
  const inputs: ReorderInput[] = overview.products
    .filter((p) => !wanted || wanted.has(p.id))
    .map((p) => ({
      productId: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      onHand: p.onHand ?? 0,
      onOrder: onOrder.get(p.id) ?? 0,
      minStock: p.minStock,
      reorderQty: p.reorderQty,
      leadTimeDays: p.leadTimeDays,
      daily: p.dailyUse,
      unitCost: lastCost.get(p.id) ?? p.cost,
      supplierId: p.preferredSupplierId,
      supplierName: p.supplierName,
      trackStock: p.trackStock,
      active: p.active,
    }));
  const suggestions = reorderSuggestions(inputs);
  return {
    suggestions,
    groups: groupBySupplier(suggestions),
    currency: overview.products[0]?.currency ?? 'COP',
  };
}

// ---------------------------------------------------------------------------
// Órdenes: escribir
// ---------------------------------------------------------------------------

export interface PoLineInput {
  productId?: string | null;
  description?: string | null;
  unit?: string | null;
  qty: number;
  unitCost?: number | null;
  taxRate?: number | null;
}

export interface CreatePoInput {
  supplier: SupplierRef;
  lines: readonly PoLineInput[];
  expectedOn?: string | null;
  locationId?: string | null;
  notes?: string | null;
  origin?: PurchaseOrderRow['origin'];
  termsDays?: number | null;
  currency?: string;
  userId?: string | null;
}

async function nextNumber(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('purchase_orders')
    .select('number')
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return ((data as { number: number } | null)?.number ?? 0) + 1;
}

export async function createPurchaseOrder(
  db: SupabaseClient,
  input: CreatePoInput,
): Promise<PurchaseOrder> {
  if (!input.lines.length)
    throw new PurchaseOrderStateError('Una orden de compra necesita al menos una línea.');
  const productIds = input.lines.map((l) => l.productId).filter(Boolean) as string[];
  const products = new Map<
    string,
    { name: string; unit: string; cost: number | null; sku: string | null }
  >();
  for (const ids of chunks([...new Set(productIds)], IN_CHUNK)) {
    const { data, error } = await db
      .from('products')
      .select('id, name, unit, cost, sku')
      .in('id', ids);
    if (error) throw error;
    for (const p of (data ?? []) as Array<{
      id: string;
      name: string;
      unit: string;
      cost: number | string | null;
      sku: string | null;
    }>)
      products.set(p.id, { name: p.name, unit: p.unit, cost: num(p.cost), sku: p.sku });
  }
  const lines = input.lines.map((l, i) => {
    const p = l.productId ? products.get(l.productId) : undefined;
    if (l.productId && !p) throw new PurchaseOrderStateError('Uno de los productos ya no existe.');
    if (!Number.isFinite(l.qty) || l.qty <= 0)
      throw new PurchaseOrderStateError('Cada línea necesita una cantidad mayor que cero.');
    const description = (
      l.description?.trim() || (p ? `${p.sku ? `${p.sku} · ` : ''}${p.name}` : '')
    ).slice(0, 300);
    if (!description)
      throw new PurchaseOrderStateError('Cada línea necesita un producto o una descripción.');
    const unitCost = l.unitCost ?? p?.cost ?? 0;
    if (!Number.isFinite(unitCost) || unitCost < 0)
      throw new PurchaseOrderStateError('El costo de una línea tiene que ser cero o más.');
    return {
      product_id: l.productId ?? null,
      position: i,
      description,
      unit: (l.unit?.trim() || p?.unit || 'und').slice(0, 30),
      qty: round(l.qty, 4),
      unit_cost: round(unitCost, 4),
      tax_rate: Math.min(Math.max(l.taxRate ?? 0, 0), 100),
    };
  });
  const totals = poTotals(
    lines.map((l) => ({ qty: l.qty, unitCost: l.unit_cost, taxRate: l.tax_rate })),
  );
  const location = input.locationId ?? (await ensureDefaultLocation(db, input.userId)).id;

  let row: PurchaseOrderRow | null = null;
  for (let attempt = 0; attempt < 4 && !row; attempt++) {
    const number = await nextNumber(db);
    const { data, error } = await db
      .from('purchase_orders')
      .insert({
        number,
        supplier_id: input.supplier.id,
        supplier_name: input.supplier.name,
        supplier_tax_id: input.supplier.nit,
        supplier_email: input.supplier.email,
        currency: input.currency ?? 'COP',
        subtotal: totals.subtotal,
        tax_total: totals.taxTotal,
        total: totals.total,
        expected_on: input.expectedOn ?? null,
        location_id: location,
        payment_terms_days: Math.min(
          Math.max(input.termsDays ?? input.supplier.termsDays ?? 30, 0),
          365,
        ),
        notes: input.notes?.trim().slice(0, 2000) || null,
        origin: input.origin ?? 'manual',
        requested_by: input.userId ?? null,
      })
      .select(PO_COLUMNS)
      .single();
    if (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    row = data as PurchaseOrderRow;
  }
  if (!row) throw new PurchaseOrderStateError('No pude numerar la orden: inténtalo otra vez.');
  const { data: inserted, error } = await db
    .from('purchase_order_lines')
    .insert(lines.map((l) => ({ ...l, purchase_order_id: row.id })))
    .select(PO_LINE_COLUMNS);
  if (error) {
    await db.from('purchase_orders').delete().eq('id', row.id);
    throw error;
  }
  return adaptPurchaseOrder(row, (inserted ?? []) as PoLineRow[]);
}

export interface FromSuggestionsResult {
  created: PurchaseOrder[];
  /** Lo que no tiene proveedor habitual: hay que elegirlo antes de pedirlo. */
  withoutSupplier: ReorderSuggestion[];
}

/** Una orden por proveedor con lo que hay que reponer (borradores). */
export async function createOrdersFromSuggestions(
  db: SupabaseClient,
  opts: {
    today: string;
    productIds?: readonly string[];
    userId?: string | null;
    origin?: PurchaseOrderRow['origin'];
  },
): Promise<FromSuggestionsResult> {
  const plan = await buildReorderPlan(db, { today: opts.today, productIds: opts.productIds });
  const created: PurchaseOrder[] = [];
  const withoutSupplier: ReorderSuggestion[] = [];
  for (const group of plan.groups) {
    if (!group.supplierId) {
      withoutSupplier.push(...group.lines);
      continue;
    }
    const { supplier } = await resolveSupplier(db, { supplierId: group.supplierId });
    if (!supplier) {
      withoutSupplier.push(...group.lines);
      continue;
    }
    created.push(
      await createPurchaseOrder(db, {
        supplier,
        lines: group.lines.map((s) => ({
          productId: s.productId,
          qty: s.qty,
          unitCost: s.unitCost,
        })),
        expectedOn: group.leadTimeDays !== null ? addDaysIso(opts.today, group.leadTimeDays) : null,
        origin: opts.origin ?? 'sugerencia',
        userId: opts.userId,
      }),
    );
  }
  return { created, withoutSupplier };
}

/** Quién aprueba una orden: el de ese proveedor, quien la pidió si administra, o un administrador. */
export async function approverFor(
  db: SupabaseClient,
  po: Pick<PurchaseOrder, 'supplierId' | 'requestedBy'>,
): Promise<string | null> {
  if (po.supplierId) {
    const { data, error } = await db
      .from('suppliers')
      .select('approver_id')
      .eq('id', po.supplierId)
      .maybeSingle();
    if (error) throw error;
    const approver = (data as { approver_id: string | null } | null)?.approver_id;
    if (approver) return approver;
  }
  if (po.requestedBy && (await isCompanyManager(db, po.requestedBy))) return po.requestedBy;
  const admins = await orgAdmins(db, 1);
  return admins[0] ?? po.requestedBy ?? null;
}

/** El agente al que se atribuye la aprobación (Cortex). */
async function cortexAgentId(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

/** La entrada de la aprobación: el id manda; el resto es lo que la persona lee. */
export function sendPoApprovalInput(po: PurchaseOrder): Record<string, unknown> {
  return {
    purchaseOrderId: po.id,
    label: po.label,
    supplierName: po.supplierName,
    expectedTotal: po.total,
    currency: po.currency,
  };
}

/**
 * Pasa una orden a «por aprobar» y deja su aprobación en la cola. Si quien la
 * pide aprueba él mismo, la aprobación queda a su nombre (un clic en
 * /approvals). Devuelve la orden y el id de la aprobación.
 */
export async function submitPurchaseOrder(
  db: SupabaseClient,
  poRef: string,
  opts: { userId?: string | null } = {},
): Promise<PurchaseOrder> {
  const po = await requirePo(db, poRef);
  if (po.status === 'por_aprobar' && po.approvalId) return po;
  assertPoMove(po.status, 'por_aprobar', po.label);
  if (po.total <= 0)
    throw new PurchaseOrderStateError(`La orden ${po.label} está en cero: ponle costos antes.`);
  const [approver, agentId] = await Promise.all([approverFor(db, po), cortexAgentId(db)]);
  let approvalId: string | null = null;
  if (approver && agentId) {
    const { data, error } = await db
      .from('mcp_pending_actions')
      .insert({
        user_id: approver,
        agent_id: agentId,
        tool_id: 'purchasing.send_po',
        input: sendPoApprovalInput(po),
        expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
        staged_via: 'web',
      })
      .select('id')
      .single();
    if (error) throw error;
    approvalId = (data as { id: string }).id;
  }
  const { data, error } = await db
    .from('purchase_orders')
    .update({
      status: 'por_aprobar',
      approval_id: approvalId,
      requested_by: po.requestedBy ?? opts.userId ?? null,
    })
    .eq('id', po.id)
    .eq('status', po.status)
    .select(PO_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new PurchaseOrderStateError(`La orden ${po.label} cambió mientras se enviaba a aprobar.`);
  return { ...adaptPurchaseOrder(data as PurchaseOrderRow, []), lines: po.lines };
}

export class PurchaseApprovalError extends Error {}

/**
 * Aprobar una orden: sólo quien administra la empresa (o es su dueño), o quien
 * el proveedor tiene como aprobador. Desde aquí la orden compromete plata y el
 * libro la ve como «por pagar» esperado.
 */
export async function approvePurchaseOrder(
  db: SupabaseClient,
  poRef: string,
  opts: { userId: string; today: string; expectedTotal?: number | null },
): Promise<PurchaseOrder> {
  const po = await requirePo(db, poRef);
  if (po.approvedAt && !['borrador', 'por_aprobar'].includes(po.status)) return po;
  assertPoMove(po.status, 'aprobada', po.label);
  if (opts.expectedTotal != null && Math.abs(opts.expectedTotal - po.total) > 0.5)
    throw new PurchaseApprovalError(
      `La orden ${po.label} cambió desde que se pidió la aprobación (ahora suma ${po.total}). Revísala y vuelve a pedirla.`,
    );
  const approver = await approverFor(db, po);
  const allowed = (await isCompanyManager(db, opts.userId)) || approver === opts.userId;
  if (!allowed)
    throw new PurchaseApprovalError(
      'Sólo quien administra la empresa (o quien aprueba las compras de ese proveedor) puede aprobar una orden de compra.',
    );
  const { data, error } = await db
    .from('purchase_orders')
    .update({ status: 'aprobada', approved_by: opts.userId, approved_at: new Date().toISOString() })
    .eq('id', po.id)
    .eq('status', po.status)
    .select(PO_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PurchaseOrderStateError(`La orden ${po.label} cambió mientras se aprobaba.`);
  const next = { ...adaptPurchaseOrder(data as PurchaseOrderRow, []), lines: po.lines };
  await syncPoLedger(db, next, { today: opts.today, userId: opts.userId });
  return next;
}

export async function markPurchaseOrderSent(
  db: SupabaseClient,
  poRef: string,
  opts: { to: string },
): Promise<PurchaseOrder> {
  const po = await requirePo(db, poRef);
  if (po.status === 'enviada') return po;
  // Reenviar una orden ya recibida o facturada no cambia su estado.
  const status = po.status === 'aprobada' ? 'enviada' : po.status;
  if (po.status === 'aprobada') assertPoMove(po.status, 'enviada', po.label);
  else if (!['recibida_parcial', 'recibida', 'facturada'].includes(po.status))
    throw new PurchaseOrderStateError(
      `La orden ${po.label} está «${PO_STATUS_LABEL[po.status]}»: hay que aprobarla antes de enviarla.`,
    );
  const { data, error } = await db
    .from('purchase_orders')
    .update({ status, sent_at: new Date().toISOString(), sent_to: opts.to.slice(0, 400) })
    .eq('id', po.id)
    .select(PO_COLUMNS)
    .single();
  if (error) throw error;
  return { ...adaptPurchaseOrder(data as PurchaseOrderRow, []), lines: po.lines };
}

export interface ReceiveResult {
  po: PurchaseOrder;
  received: Array<{ lineId: string; description: string; qty: number }>;
  movements: number;
}

/**
 * Recibir mercancía: entradas al libro de existencias al costo de la orden
 * (mueven el costo promedio), y la orden pasa a recibida en parte o recibida.
 * Sin cantidades: todo lo pendiente. Reintentar no duplica: cada entrada lleva
 * la llave de su línea y su acumulado.
 */
export async function receivePurchaseOrder(
  db: SupabaseClient,
  poRef: string,
  opts: {
    quantities?: ReadonlyMap<string, number> | null;
    locationId?: string | null;
    userId?: string | null;
    today: string;
    note?: string | null;
  },
): Promise<ReceiveResult> {
  const po = await requirePo(db, poRef);
  if (po.status === 'recibida' || po.status === 'cerrada')
    throw new PurchaseOrderStateError(`La orden ${po.label} ya se recibió completa.`);
  if (!['aprobada', 'enviada', 'recibida_parcial', 'facturada'].includes(po.status))
    throw new PurchaseOrderStateError(
      `La orden ${po.label} está «${PO_STATUS_LABEL[po.status]}»: sólo se recibe una orden aprobada.`,
    );
  const plan = planReceipt(
    po.lines.map((l) => ({ id: l.id, qty: l.qty, qtyReceived: l.qtyReceived })),
    opts.quantities ?? null,
  );
  if (plan.errors.length) throw new PurchaseOrderStateError(plan.errors.join(' '));
  const location =
    opts.locationId ?? po.locationId ?? (await ensureDefaultLocation(db, opts.userId)).id;
  const byId = new Map(po.lines.map((l) => [l.id, l]));
  const drafts: MovementDraft[] = [];
  for (const r of plan.receive) {
    const line = byId.get(r.id);
    if (!line?.productId) continue;
    drafts.push({
      productId: line.productId,
      locationId: location,
      kind: 'entrada',
      qty: r.qty,
      unitCost: line.unitCost,
      referenceKind: 'orden_compra',
      referenceId: po.id,
      referenceLabel: `${po.label} · ${po.supplierName}`,
      purchaseOrderId: po.id,
      note: opts.note ?? null,
      occurredOn: opts.today,
      dedupeKey: `oc:${po.id}:${r.id}:${r.qtyReceived}`,
    });
  }
  const written = await recordMovements(db, drafts, { userId: opts.userId, today: opts.today });
  for (const r of plan.receive) {
    const { error } = await db
      .from('purchase_order_lines')
      .update({ qty_received: r.qtyReceived })
      .eq('id', r.id)
      .eq('purchase_order_id', po.id);
    if (error) throw error;
  }
  const status: PoStatus = po.status === 'facturada' ? 'facturada' : plan.status;
  const { data, error } = await db
    .from('purchase_orders')
    .update({ status, received_at: new Date().toISOString() })
    .eq('id', po.id)
    .select(PO_COLUMNS)
    .single();
  if (error) throw error;
  const fresh = await linesFor(db, [po.id]);
  const next = adaptPurchaseOrder(data as PurchaseOrderRow, fresh.get(po.id) ?? []);
  return {
    po: next,
    received: plan.receive.map((r) => ({
      lineId: r.id,
      description: byId.get(r.id)?.description ?? '',
      qty: r.qty,
    })),
    movements: written.inserted,
  };
}

export async function cancelPurchaseOrder(
  db: SupabaseClient,
  poRef: string,
  opts: { reason?: string | null; today: string; userId?: string | null },
): Promise<PurchaseOrder> {
  const po = await requirePo(db, poRef);
  if (po.status === 'cancelada') return po;
  assertPoMove(po.status, 'cancelada', po.label);
  const { data, error } = await db
    .from('purchase_orders')
    .update({ status: 'cancelada', cancelled_reason: opts.reason?.trim().slice(0, 500) || null })
    .eq('id', po.id)
    .eq('status', po.status)
    .select(PO_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new PurchaseOrderStateError(`La orden ${po.label} cambió mientras se cancelaba.`);
  const next = { ...adaptPurchaseOrder(data as PurchaseOrderRow, []), lines: po.lines };
  // La aprobación pendiente ya no tiene sentido.
  if (po.approvalId) {
    const { error: dropError } = await db
      .from('mcp_pending_actions')
      .delete()
      .eq('id', po.approvalId)
      .is('decision', null);
    if (dropError) throw dropError;
  }
  if (po.approvedAt) await syncPoLedger(db, next, { today: opts.today, userId: opts.userId });
  return next;
}

/** Cambiar cantidades o costos de un borrador (o de una por aprobar, que vuelve a borrador). */
export async function updateDraftLines(
  db: SupabaseClient,
  poRef: string,
  lines: ReadonlyArray<{ id: string; qty?: number; unitCost?: number; remove?: boolean }>,
): Promise<PurchaseOrder> {
  const po = await requirePo(db, poRef);
  if (!['borrador', 'por_aprobar'].includes(po.status))
    throw new PurchaseOrderStateError(`La orden ${po.label} ya está aprobada: no se puede editar.`);
  const known = new Map(po.lines.map((l) => [l.id, l]));
  for (const l of lines) {
    if (!known.has(l.id))
      throw new PurchaseOrderStateError('Una de las líneas no es de esta orden.');
    if (l.remove) {
      const { error } = await db
        .from('purchase_order_lines')
        .delete()
        .eq('id', l.id)
        .eq('purchase_order_id', po.id);
      if (error) throw error;
      known.delete(l.id);
      continue;
    }
    const patch: Record<string, number> = {};
    if (l.qty !== undefined) {
      if (!(l.qty > 0))
        throw new PurchaseOrderStateError('La cantidad tiene que ser mayor que cero.');
      patch.qty = round(l.qty, 4);
    }
    if (l.unitCost !== undefined) {
      if (!(l.unitCost >= 0))
        throw new PurchaseOrderStateError('El costo tiene que ser cero o más.');
      patch.unit_cost = round(l.unitCost, 4);
    }
    if (Object.keys(patch).length) {
      const { error } = await db
        .from('purchase_order_lines')
        .update(patch)
        .eq('id', l.id)
        .eq('purchase_order_id', po.id);
      if (error) throw error;
    }
  }
  const fresh = (await linesFor(db, [po.id])).get(po.id) ?? [];
  if (!fresh.length)
    throw new PurchaseOrderStateError('La orden se quedó sin líneas: mejor cancélala.');
  const totals = poTotals(
    fresh.map((l) => ({
      qty: num(l.qty) ?? 0,
      unitCost: num(l.unit_cost) ?? 0,
      taxRate: num(l.tax_rate) ?? 0,
    })),
  );
  // Editar una orden por aprobar la devuelve a borrador: la aprobación pedida
  // era de otra orden.
  if (po.approvalId) {
    const { error } = await db
      .from('mcp_pending_actions')
      .delete()
      .eq('id', po.approvalId)
      .is('decision', null);
    if (error) throw error;
  }
  const { data, error } = await db
    .from('purchase_orders')
    .update({
      subtotal: totals.subtotal,
      tax_total: totals.taxTotal,
      total: totals.total,
      status: 'borrador',
      approval_id: null,
    })
    .eq('id', po.id)
    .select(PO_COLUMNS)
    .single();
  if (error) throw error;
  return adaptPurchaseOrder(data as PurchaseOrderRow, fresh);
}
