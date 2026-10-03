/**
 * VENTAS COMO LAS VE UNA PANTALLA (migración 0182).
 *
 * Formas planas que viajan del servidor al navegador: el documento ya con su
 * número, su estado efectivo y sus etiquetas en español. Sin dependencias —lo
 * importan componentes `'use client'`, el enlace público y el escaparate— y
 * sin nada que el navegador no deba ver (ni el payload del programa contable ni
 * el token de otra cotización).
 */

export type SalesKindView = 'quote' | 'order' | 'invoice';
export type TaxRateView = 'iva_19' | 'iva_5' | 'iva_0' | 'excluido';
export type ToneView = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export interface SalesLineView {
  description: string;
  productRef: string | null;
  productCode: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: TaxRateView;
  lineTotal: number;
}

export interface SalesDocView {
  id: string;
  kind: SalesKindView;
  kindLabel: string;
  number: string;
  status: string;
  statusLabel: string;
  statusTone: ToneView;
  clientId: string | null;
  clientName: string;
  clientTaxId: string | null;
  clientEmail: string | null;
  contactName: string | null;
  issueDate: string;
  validUntil: string | null;
  dueDate: string | null;
  currency: string;
  paymentForm: 'contado' | 'credito';
  paymentDays: number;
  notes: string | null;
  terms: string | null;
  withholdings: { retefuentePct?: number; reteicaPerMil?: number; reteivaPct?: number };
  totals: {
    subtotal: number;
    discount: number;
    base: number;
    iva: number;
    total: number;
    withholding: number;
    net: number;
  };
  lines: SalesLineView[];
  sentAt: string | null;
  sentTo: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  views: number;
  /** Factura electrónica. */
  provider: 'siigo' | 'alegra' | null;
  providerNumber: string | null;
  cufe: string | null;
  einvoiceStatus: string | null;
  providerUrl: string | null;
  providerError: string | null;
  emissionUncertain: boolean;
  /** Qué se puede hacer con él ahora. */
  can: {
    edit: boolean;
    send: boolean;
    accept: boolean;
    convert: boolean;
    invoice: boolean;
    cancel: boolean;
  };
}

export interface SalesEventView {
  id: string;
  label: string;
  detail: string | null;
  who: string | null;
  at: string;
  tone: ToneView;
}

export interface SalesRelatedView {
  id: string;
  number: string;
  kindLabel: string;
  statusLabel: string;
  statusTone: ToneView;
}

export interface SalesDetailView {
  doc: SalesDocView;
  events: SalesEventView[];
  related: SalesRelatedView[];
  /** El enlace público de la cotización, si ya existe. */
  publicUrl: string | null;
  pdfUrl: string;
}

export interface InvoicePreviewView {
  providerName: string | null;
  guidance: string | null;
  problems: string[];
  notes: string[];
  summary: {
    documentType: string | null;
    seller: string | null;
    payment: string;
    date: string;
    dueDate: string;
    customer: string;
    lines: Array<{
      description: string;
      code: string | null;
      quantity: number;
      unitPrice: number;
      tax: string;
      total: number;
    }>;
    subtotal: number;
    iva: number;
    total: number;
  } | null;
}

export interface ClientOption {
  id: string;
  name: string;
  nit: string | null;
  email: string | null;
  contact: string | null;
  paymentDays: number | null;
}

export interface ProductOption {
  ref: string;
  code: string | null;
  name: string;
  price: number | null;
  unit: string | null;
  provider: 'siigo' | 'alegra';
}

export interface SalesActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  note?: string;
  data?: T;
}

/** Lo que el editor manda a guardar. Los totales NO viajan: se calculan en el servidor. */
export interface SalesEditorInput {
  clientId: string | null;
  clientName: string;
  clientTaxId: string | null;
  clientEmail: string | null;
  contactName: string | null;
  validUntil: string | null;
  paymentForm: 'contado' | 'credito';
  paymentDays: number;
  notes: string | null;
  terms: string | null;
  withholdings: { retefuentePct?: number; reteicaPerMil?: number; reteivaPct?: number };
  lines: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    discountPct: number;
    taxRate: TaxRateView;
    productRef: string | null;
    productCode: string | null;
    unit: string | null;
  }>;
}

export interface ClientSalesSummary {
  docs: Array<{
    id: string;
    number: string;
    kindLabel: string;
    statusLabel: string;
    statusTone: ToneView;
    total: number;
    currency: string;
    date: string;
  }>;
  openQuotesTotal: number;
  error: string | null;
}
