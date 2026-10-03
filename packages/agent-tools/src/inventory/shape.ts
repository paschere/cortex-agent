/**
 * EL VOCABULARIO DEL INVENTARIO Y LAS COMPRAS (migración 0183).
 *
 * Tipos, estados, etiquetas y columnas. Nada de base de datos, nada de reloj:
 * lo importan el motor puro (math.ts), los almacenes, las herramientas y —sólo
 * como `import type`— la pantalla /inventario.
 */

export const MOVEMENT_KINDS = ['entrada', 'salida', 'ajuste', 'traslado'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  entrada: 'Entrada',
  salida: 'Salida',
  ajuste: 'Ajuste',
  traslado: 'Traslado',
};

export const REFERENCE_KINDS = [
  'orden_compra',
  'venta',
  'factura',
  'manual',
  'conteo',
  'sincronizacion',
  'importacion',
  'traslado',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const REFERENCE_KIND_LABEL: Record<ReferenceKind, string> = {
  orden_compra: 'Orden de compra',
  venta: 'Venta',
  factura: 'Factura',
  manual: 'A mano',
  conteo: 'Conteo',
  sincronizacion: 'Programa contable',
  importacion: 'Importación',
  traslado: 'Traslado',
};

export const PO_STATUSES = [
  'borrador',
  'por_aprobar',
  'aprobada',
  'enviada',
  'recibida_parcial',
  'recibida',
  'facturada',
  'cerrada',
  'cancelada',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  borrador: 'Borrador',
  por_aprobar: 'Por aprobar',
  aprobada: 'Aprobada',
  enviada: 'Enviada',
  recibida_parcial: 'Recibida en parte',
  recibida: 'Recibida',
  facturada: 'Facturada',
  cerrada: 'Cerrada',
  cancelada: 'Cancelada',
};

export const PO_STATUS_TONE: Record<
  PoStatus,
  'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'
> = {
  borrador: 'neutral',
  por_aprobar: 'amber',
  aprobada: 'primary',
  enviada: 'primary',
  recibida_parcial: 'amber',
  recibida: 'emerald',
  facturada: 'emerald',
  cerrada: 'neutral',
  cancelada: 'rose',
};

/** Las que todavía esperan mercancía: cuentan como «pedido en camino». */
export const PO_INBOUND: readonly PoStatus[] = ['aprobada', 'enviada', 'recibida_parcial'];
/** Las que comprometen plata (el libro de plata las ve como «por pagar» esperado). */
export const PO_COMMITTED: readonly PoStatus[] = [
  'aprobada',
  'enviada',
  'recibida_parcial',
  'recibida',
];
/** Las que la factura del proveedor puede cubrir. */
export const PO_INVOICEABLE: readonly PoStatus[] = [
  'aprobada',
  'enviada',
  'recibida_parcial',
  'recibida',
];

/** Qué estado puede seguir a cuál. Cancelar sólo antes de recibir. */
const TRANSITIONS: Record<PoStatus, readonly PoStatus[]> = {
  borrador: ['por_aprobar', 'aprobada', 'cancelada'],
  por_aprobar: ['borrador', 'aprobada', 'cancelada'],
  aprobada: ['enviada', 'recibida_parcial', 'recibida', 'facturada', 'cancelada'],
  enviada: ['recibida_parcial', 'recibida', 'facturada', 'cancelada'],
  recibida_parcial: ['recibida_parcial', 'recibida', 'facturada', 'cerrada'],
  recibida: ['facturada', 'cerrada'],
  facturada: ['cerrada'],
  cerrada: [],
  cancelada: [],
};

export function canMovePo(from: PoStatus, to: PoStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class PurchaseOrderStateError extends Error {}

export function assertPoMove(from: PoStatus, to: PoStatus, label: string): void {
  if (!canMovePo(from, to))
    throw new PurchaseOrderStateError(
      `La orden ${label} está «${PO_STATUS_LABEL[from]}» y no puede pasar a «${PO_STATUS_LABEL[to]}».`,
    );
}

export function poLabel(number: number): string {
  return `OC-${String(number).padStart(4, '0')}`;
}

/** «OC-0007», «oc 7», «7» → 7. */
export function parsePoNumber(raw: string): number | null {
  const m = raw.trim().match(/^(?:oc[\s-]*)?0*(\d{1,9})$/i);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Alertas de un producto
// ---------------------------------------------------------------------------

export const STOCK_ALERTS = ['agotado', 'bajo_minimo', 'se_agota', 'sin_movimiento', 'ok'] as const;
export type StockAlert = (typeof STOCK_ALERTS)[number];

export const STOCK_ALERT_LABEL: Record<StockAlert, string> = {
  agotado: 'Agotado',
  bajo_minimo: 'Bajo el mínimo',
  se_agota: 'Se agota antes de reponer',
  sin_movimiento: 'Sin movimiento',
  ok: 'Al día',
};

export const STOCK_ALERT_TONE: Record<
  StockAlert,
  'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'
> = {
  agotado: 'rose',
  bajo_minimo: 'amber',
  se_agota: 'amber',
  sin_movimiento: 'neutral',
  ok: 'emerald',
};

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

export interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  unit: string;
  category: string | null;
  track_stock: boolean;
  currency: string;
  cost: number | string | null;
  price: number | string | null;
  min_stock: number | string | null;
  reorder_qty: number | string | null;
  lead_time_days: number | null;
  preferred_supplier_id: string | null;
  source: 'manual' | 'sheet' | 'accounting';
  source_system: string | null;
  source_ref: string | null;
  stock_from: 'cortex' | 'accounting';
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const PRODUCT_COLUMNS =
  'id, sku, name, unit, category, track_stock, currency, cost, price, min_stock, reorder_qty, lead_time_days, preferred_supplier_id, source, source_system, source_ref, stock_from, active, notes, created_at, updated_at';

export interface LocationRow {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  is_default: boolean;
  active: boolean;
  source_system: string | null;
  source_ref: string | null;
}

export const LOCATION_COLUMNS =
  'id, name, code, address, is_default, active, source_system, source_ref';

export interface MovementRow {
  id: string;
  product_id: string;
  location_id: string;
  kind: MovementKind;
  qty: number | string;
  unit_cost: number | string | null;
  reference_kind: ReferenceKind;
  reference_id: string | null;
  reference_label: string | null;
  purchase_order_id: string | null;
  transfer_id: string | null;
  note: string | null;
  occurred_on: string;
  created_by: string | null;
  created_at: string;
}

export const MOVEMENT_COLUMNS =
  'id, product_id, location_id, kind, qty, unit_cost, reference_kind, reference_id, reference_label, purchase_order_id, transfer_id, note, occurred_on, created_by, created_at';

export interface PurchaseOrderRow {
  id: string;
  number: number;
  supplier_id: string | null;
  supplier_name: string;
  supplier_tax_id: string | null;
  supplier_email: string | null;
  status: PoStatus;
  currency: string;
  subtotal: number | string;
  tax_total: number | string;
  total: number | string;
  expected_on: string | null;
  location_id: string | null;
  payment_terms_days: number;
  notes: string | null;
  origin: 'manual' | 'sugerencia' | 'chat' | 'piloto';
  approval_id: string | null;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  sent_to: string | null;
  received_at: string | null;
  invoiced_at: string | null;
  payable_id: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
}

export const PO_COLUMNS =
  'id, number, supplier_id, supplier_name, supplier_tax_id, supplier_email, status, currency, subtotal, tax_total, total, expected_on, location_id, payment_terms_days, notes, origin, approval_id, requested_by, approved_by, approved_at, sent_at, sent_to, received_at, invoiced_at, payable_id, cancelled_reason, created_at, updated_at';

export interface PoLineRow {
  id: string;
  purchase_order_id: string;
  product_id: string | null;
  position: number;
  description: string;
  unit: string;
  qty: number | string;
  unit_cost: number | string;
  tax_rate: number | string;
  qty_received: number | string;
}

export const PO_LINE_COLUMNS =
  'id, purchase_order_id, product_id, position, description, unit, qty, unit_cost, tax_rate, qty_received';

/** numeric de Postgres llega como texto: a número, o null. */
export function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function formatQty(n: number): string {
  return n.toLocaleString('es-CO', { maximumFractionDigits: 2 });
}

export function formatMoneyCop(n: number, currency = 'COP'): string {
  const c = (currency || 'COP').toUpperCase();
  if (c === 'COP') return `$ ${Math.round(n).toLocaleString('es-CO')}`;
  return `${n.toLocaleString('es-CO', { maximumFractionDigits: 2 })} ${c}`;
}
