/**
 * EL VOCABULARIO DE VENTAS (migración 0182): clases de documento, estados,
 * etiquetas en español, el número para mostrar y las filas como salen de la
 * base. Módulo puro (no importa nada): lo usan las herramientas, la pantalla
 * /ventas, el enlace público y el PDF.
 */

import type { TaxRate } from './totals';

export type SalesKind = 'quote' | 'order' | 'invoice';
export const SALES_KINDS: readonly SalesKind[] = ['quote', 'order', 'invoice'] as const;

export type QuoteStatus =
  | 'borrador'
  | 'enviada'
  | 'aceptada'
  | 'rechazada'
  | 'vencida'
  | 'pedido'
  | 'facturada'
  | 'anulada';
export type OrderStatus = 'pedido' | 'facturada' | 'anulada';
export type InvoiceStatus = 'borrador' | 'emitiendo' | 'emitida' | 'error' | 'anulada';
export type SalesStatus = QuoteStatus | OrderStatus | InvoiceStatus;

export const KIND_PREFIX: Record<SalesKind, string> = {
  quote: 'COT',
  order: 'PED',
  invoice: 'FAC',
};

export const KIND_LABEL: Record<SalesKind, { one: string; many: string }> = {
  quote: { one: 'Cotización', many: 'Cotizaciones' },
  order: { one: 'Pedido', many: 'Pedidos' },
  invoice: { one: 'Factura', many: 'Facturas' },
};

export const STATUS_LABEL: Record<SalesStatus, string> = {
  borrador: 'Borrador',
  enviada: 'Enviada',
  aceptada: 'Aceptada',
  rechazada: 'Rechazada',
  vencida: 'Vencida',
  pedido: 'Pedido',
  facturada: 'Facturada',
  anulada: 'Anulada',
  emitiendo: 'Emitiendo',
  emitida: 'Emitida',
  error: 'Con error',
};

export type StatusTone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export const STATUS_TONE: Record<SalesStatus, StatusTone> = {
  borrador: 'neutral',
  enviada: 'primary',
  aceptada: 'emerald',
  rechazada: 'rose',
  vencida: 'amber',
  pedido: 'primary',
  facturada: 'emerald',
  anulada: 'neutral',
  emitiendo: 'amber',
  emitida: 'emerald',
  error: 'rose',
};

/** «COT-0012». La factura emitida se muestra con su número legal (FV-2-22). */
export function documentNumber(doc: {
  kind: SalesKind;
  number: number;
  provider_number?: string | null;
}): string {
  if (doc.kind === 'invoice' && doc.provider_number) return doc.provider_number;
  return `${KIND_PREFIX[doc.kind]}-${String(doc.number).padStart(4, '0')}`;
}

/** «COT-12», «cot 12», «COT-0012» → { kind, number }. */
export function parseDocumentNumber(raw: string): { kind: SalesKind; number: number } | null {
  const m = /^\s*(cot|ped|fac)[\s-]*0*(\d{1,9})\s*$/i.exec(raw);
  if (!m) return null;
  const prefix = (m[1] as string).toUpperCase();
  const kind = (Object.keys(KIND_PREFIX) as SalesKind[]).find((k) => KIND_PREFIX[k] === prefix);
  return kind ? { kind, number: Number(m[2]) } : null;
}

export interface SalesWithholdingsJson {
  retefuente_pct?: number;
  reteica_per_mil?: number;
  reteiva_pct?: number;
}

export interface SalesDocumentRow {
  id: string;
  organization_id: string;
  kind: SalesKind;
  number: number;
  status: SalesStatus;
  source_id: string | null;
  client_id: string | null;
  client_name: string;
  client_tax_id: string | null;
  client_email: string | null;
  contact_name: string | null;
  issue_date: string;
  valid_until: string | null;
  due_date: string | null;
  currency: string;
  payment_form: 'contado' | 'credito';
  payment_days: number;
  notes: string | null;
  terms: string | null;
  withholdings: SalesWithholdingsJson;
  subtotal: number;
  discount_total: number;
  tax_base: number;
  iva_total: number;
  total: number;
  withholding_total: number;
  net_total: number;
  share_token: string | null;
  share_views: number;
  sent_at: string | null;
  sent_to: string | null;
  accepted_at: string | null;
  accepted_by_name: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  provider: 'siigo' | 'alegra' | null;
  provider_invoice_id: string | null;
  provider_number: string | null;
  cufe: string | null;
  einvoice_status: string | null;
  provider_url: string | null;
  provider_error: string | null;
  emission_uncertain: boolean;
  emission_attempted_at: string | null;
  emitted_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SalesLineRow {
  id: string;
  document_id: string;
  position: number;
  description: string;
  product_ref: string | null;
  product_code: string | null;
  unit: string | null;
  quantity: number;
  unit_price: number;
  discount_pct: number;
  tax_rate: TaxRate;
  gross: number;
  discount: number;
  base: number;
  iva: number;
  line_total: number;
}

export type SalesEventKind =
  | 'created'
  | 'updated'
  | 'sent'
  | 'viewed'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'converted'
  | 'invoice_prepared'
  | 'invoice_emitted'
  | 'invoice_failed'
  | 'cancelled';

export interface SalesEventRow {
  id: string;
  document_id: string;
  kind: SalesEventKind;
  detail: string | null;
  actor_user_id: string | null;
  actor_label: string | null;
  created_at: string;
}

export const EVENT_LABEL: Record<SalesEventKind, string> = {
  created: 'Creada',
  updated: 'Editada',
  sent: 'Enviada al cliente',
  viewed: 'El cliente la abrió',
  accepted: 'Aceptada',
  rejected: 'Rechazada',
  expired: 'Venció',
  converted: 'Convertida',
  invoice_prepared: 'Factura preparada',
  invoice_emitted: 'Factura electrónica emitida',
  invoice_failed: 'El programa contable no la aceptó',
  cancelled: 'Anulada',
};

/** ¿Se puede editar? Sólo lo que todavía no salió de la empresa. */
export function isEditable(doc: Pick<SalesDocumentRow, 'kind' | 'status'>): boolean {
  if (doc.kind === 'quote') return doc.status === 'borrador' || doc.status === 'enviada';
  if (doc.kind === 'order') return doc.status === 'pedido';
  return doc.status === 'borrador' || doc.status === 'error';
}

/** ¿Se puede facturar desde aquí? */
export function canInvoice(doc: Pick<SalesDocumentRow, 'kind' | 'status'>): boolean {
  if (doc.kind === 'quote') return doc.status === 'aceptada' || doc.status === 'pedido';
  if (doc.kind === 'order') return doc.status === 'pedido';
  return doc.status === 'borrador' || doc.status === 'error';
}

/** ¿Venció la cotización? Fecha AAAA-MM-DD de Bogotá. */
export function isExpired(
  doc: Pick<SalesDocumentRow, 'kind' | 'status' | 'valid_until'>,
  today: string,
): boolean {
  return (
    doc.kind === 'quote' &&
    (doc.status === 'borrador' || doc.status === 'enviada') &&
    Boolean(doc.valid_until) &&
    (doc.valid_until as string) < today
  );
}

/** El estado que se muestra: una enviada con la fecha pasada se ve «Vencida». */
export function effectiveStatus(
  doc: Pick<SalesDocumentRow, 'kind' | 'status' | 'valid_until'>,
  today: string,
): SalesStatus {
  return isExpired(doc, today) ? 'vencida' : doc.status;
}
