/**
 * LO QUE LA PANTALLA DE INVENTARIO RECIBE (migración 0183).
 *
 * Módulo puro y sin dependencias: lo importan los componentes `'use client'`
 * (components/inventory) y el escaparate de desarrollo. Todo llega ya armado
 * del servidor (lib/inventory/read.ts): cifras como texto listo para leer,
 * tonos como palabras. Ningún componente calcula existencias ni costos.
 */

export type Tone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export type ActionResult =
  | { ok: true; note?: string; href?: string }
  | { ok: false; error: string };

export type InventoryTab = 'productos' | 'reponer' | 'ordenes' | 'bodegas' | 'conteo';

export const INVENTORY_TABS: Array<{ id: InventoryTab; label: string }> = [
  { id: 'productos', label: 'Productos' },
  { id: 'reponer', label: 'Por reponer' },
  { id: 'ordenes', label: 'Órdenes de compra' },
  { id: 'bodegas', label: 'Bodegas' },
  { id: 'conteo', label: 'Conteo' },
];

export function parseTab(raw: unknown): InventoryTab {
  return INVENTORY_TABS.some((t) => t.id === raw) ? (raw as InventoryTab) : 'productos';
}

export interface InventoryTile {
  label: string;
  value: string;
  note: string;
  tone: Tone;
}

export interface ReorderLineView {
  productId: string;
  name: string;
  sku: string | null;
  qty: number;
  unit: string;
  qtyLabel: string;
  why: string;
  onHandLabel: string;
  minLabel: string | null;
  costLabel: string | null;
  totalLabel: string | null;
  urgent: boolean;
}

export interface ReorderGroupView {
  key: string;
  supplierId: string | null;
  supplierName: string | null;
  totalLabel: string;
  missingCost: number;
  leadLabel: string | null;
  lines: ReorderLineView[];
}

export interface PoListItem {
  id: string;
  label: string;
  supplierName: string;
  statusLabel: string;
  tone: Tone;
  totalLabel: string;
  linesLabel: string;
  createdLabel: string;
  expectedLabel: string | null;
  progress: number;
  href: string;
}

export interface LocationView {
  id: string;
  name: string;
  isDefault: boolean;
  products: number;
  units: string;
  valueLabel: string;
  sourceLabel: string | null;
}

export interface CountRowView {
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  /** Lo que dice el libro en esa bodega, por bodega. */
  system: Record<string, number>;
  costLabel: string | null;
}

export interface SupplierOption {
  id: string;
  name: string;
}

export interface MovementView {
  id: string;
  dateLabel: string;
  kindLabel: string;
  tone: Tone;
  qtyLabel: string;
  locationName: string;
  referenceLabel: string;
  href: string | null;
  costLabel: string | null;
  note: string | null;
}

export interface ProductDetailView {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  category: string | null;
  alertLabel: string;
  alertTone: Tone;
  sourceLabel: string;
  supplierName: string | null;
  tiles: InventoryTile[];
  weekly: Array<{ label: string; qty: number }>;
  weeklyMax: number;
  dailyLabel: string;
  byLocation: Array<{ name: string; qtyLabel: string; share: number }>;
  movements: MovementView[];
  locations: Array<{ id: string; name: string }>;
  settings: {
    minStock: number | null;
    reorderQty: number | null;
    leadTimeDays: number | null;
    price: number | null;
  };
  stockFromAccounting: boolean;
}

export interface PoLineView {
  id: string;
  description: string;
  unit: string;
  qty: number;
  qtyLabel: string;
  receivedLabel: string;
  pending: number;
  costLabel: string;
  totalLabel: string;
  productHref: string | null;
  done: boolean;
}

export type PoStep = 'borrador' | 'por_aprobar' | 'aprobada' | 'enviada' | 'recibida' | 'facturada';

export interface PoDetailView {
  id: string;
  label: string;
  status: string;
  statusLabel: string;
  tone: Tone;
  /** Paso alcanzado en la línea borrador → facturada (−1 si cancelada). */
  step: number;
  supplierName: string;
  supplierTaxId: string | null;
  supplierEmail: string | null;
  totals: { subtotal: string; tax: string | null; total: string };
  facts: Array<{ label: string; value: string }>;
  lines: PoLineView[];
  notes: string | null;
  pdfHref: string;
  can: {
    edit: boolean;
    submit: boolean;
    approve: boolean;
    send: boolean;
    receive: boolean;
    cancel: boolean;
  };
  locations: Array<{ id: string; name: string }>;
  defaultLocationId: string | null;
  history: Array<{ label: string; when: string }>;
}

export const PO_STEPS: Array<{ id: PoStep; label: string }> = [
  { id: 'borrador', label: 'Borrador' },
  { id: 'por_aprobar', label: 'Por aprobar' },
  { id: 'aprobada', label: 'Aprobada' },
  { id: 'enviada', label: 'Enviada' },
  { id: 'recibida', label: 'Recibida' },
  { id: 'facturada', label: 'Facturada' },
];
