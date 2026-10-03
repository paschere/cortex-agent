import type { GridColumn, GridRow } from '@/components/datagrid/types';
import {
  SALES_EVENT_LABEL,
  SALES_KIND_LABEL,
  SALES_STATUS_LABEL,
  SALES_STATUS_TONE,
  type SalesDocumentDetail,
  type SalesDocumentRow,
  type SalesEinvoiceDraft,
  type SalesKind,
  type SalesStatus,
  canInvoiceSalesDocument,
  isSalesDocumentEditable,
  salesDocumentNumber,
  salesEffectiveStatus,
} from '@cortex/agent-tools';
import type {
  ClientSalesSummary,
  InvoicePreviewView,
  SalesDetailView,
  SalesDocView,
  SalesEventView,
  ToneView,
} from './types';

/**
 * De las filas de la base a lo que pinta una pantalla de ventas (0182).
 *
 * Se arma en el SERVIDOR (páginas, rutas, escaparate) y viaja como datos. Por
 * eso puede leer valores de `@cortex/agent-tools`; ningún componente
 * `'use client'` importa este archivo.
 */

export const SALES_VIEW_SCOPE = 'sales';

export const KIND_SLUG: Record<SalesKind, string> = {
  quote: 'cotizaciones',
  order: 'pedidos',
  invoice: 'facturas',
};

export function kindFromSlug(slug: string | undefined): SalesKind {
  return (
    (Object.entries(KIND_SLUG).find(([, s]) => s === slug)?.[0] as SalesKind | undefined) ?? 'quote'
  );
}

const EVENT_TONE: Record<string, ToneView> = {
  accepted: 'emerald',
  invoice_emitted: 'emerald',
  rejected: 'rose',
  invoice_failed: 'rose',
  expired: 'amber',
  sent: 'primary',
  viewed: 'primary',
  converted: 'primary',
};

export function docView(
  doc: SalesDocumentRow,
  lines: SalesDocumentDetail['lines'],
  today: string,
): SalesDocView {
  const status = salesEffectiveStatus(doc, today) as SalesStatus;
  const w = doc.withholdings ?? {};
  return {
    id: doc.id,
    kind: doc.kind,
    kindLabel: SALES_KIND_LABEL[doc.kind].one,
    number: salesDocumentNumber(doc),
    status,
    statusLabel: SALES_STATUS_LABEL[status],
    statusTone: SALES_STATUS_TONE[status],
    clientId: doc.client_id,
    clientName: doc.client_name,
    clientTaxId: doc.client_tax_id,
    clientEmail: doc.client_email,
    contactName: doc.contact_name,
    issueDate: doc.issue_date,
    validUntil: doc.valid_until,
    dueDate: doc.due_date,
    currency: doc.currency,
    paymentForm: doc.payment_form,
    paymentDays: doc.payment_days,
    notes: doc.notes,
    terms: doc.terms,
    withholdings: {
      retefuentePct: Number(w.retefuente_pct ?? 0) || undefined,
      reteicaPerMil: Number(w.reteica_per_mil ?? 0) || undefined,
      reteivaPct: Number(w.reteiva_pct ?? 0) || undefined,
    },
    totals: {
      subtotal: doc.subtotal,
      discount: doc.discount_total,
      base: doc.tax_base,
      iva: doc.iva_total,
      total: doc.total,
      withholding: doc.withholding_total,
      net: doc.net_total,
    },
    lines: lines.map((l) => ({
      description: l.description,
      productRef: l.product_ref,
      productCode: l.product_code,
      unit: l.unit,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discountPct: l.discount_pct,
      taxRate: l.tax_rate,
      lineTotal: l.line_total,
    })),
    sentAt: doc.sent_at,
    sentTo: doc.sent_to,
    acceptedAt: doc.accepted_at,
    acceptedBy: doc.accepted_by_name,
    rejectedAt: doc.rejected_at,
    rejectionReason: doc.rejection_reason,
    views: doc.share_views,
    provider: doc.provider,
    providerNumber: doc.provider_number,
    cufe: doc.cufe,
    einvoiceStatus: doc.einvoice_status,
    providerUrl: doc.provider_url,
    providerError: doc.provider_error,
    emissionUncertain: doc.emission_uncertain,
    can: {
      edit: isSalesDocumentEditable(doc) && status !== 'vencida',
      send:
        doc.kind === 'quote' &&
        ['borrador', 'enviada', 'aceptada'].includes(doc.status) &&
        status !== 'vencida',
      accept:
        doc.kind === 'quote' &&
        ['borrador', 'enviada'].includes(doc.status) &&
        status !== 'vencida',
      convert: doc.kind === 'quote' && doc.status === 'aceptada',
      invoice: canInvoiceSalesDocument(doc),
      cancel:
        !(doc.kind === 'invoice' && ['emitida', 'emitiendo'].includes(doc.status)) &&
        doc.status !== 'anulada' &&
        doc.status !== 'facturada',
    },
  };
}

export function detailView(
  detail: SalesDocumentDetail,
  opts: { today: string; people: Map<string, string>; publicUrl: string | null },
): SalesDetailView {
  const events: SalesEventView[] = detail.events.map((e) => ({
    id: e.id,
    label: SALES_EVENT_LABEL[e.kind],
    detail: e.detail,
    who:
      e.actor_label ??
      (e.actor_user_id ? (opts.people.get(e.actor_user_id) ?? 'Alguien del equipo') : null),
    at: e.created_at,
    tone: EVENT_TONE[e.kind] ?? 'neutral',
  }));
  return {
    doc: docView(detail.doc, detail.lines, opts.today),
    events,
    related: detail.related.map((r) => ({
      id: r.id,
      number: salesDocumentNumber(r),
      kindLabel: SALES_KIND_LABEL[r.kind].one,
      statusLabel: SALES_STATUS_LABEL[r.status],
      statusTone: SALES_STATUS_TONE[r.status],
    })),
    publicUrl: opts.publicUrl,
    pdfUrl: `/api/sales/${detail.doc.id}/pdf`,
  };
}

export function previewView(preview: {
  providerName: string | null;
  guidance: string | null;
  draft: SalesEinvoiceDraft | null;
}): InvoicePreviewView {
  return {
    providerName: preview.providerName,
    guidance: preview.guidance,
    problems: preview.draft?.problems ?? [],
    notes: preview.draft?.notes ?? [],
    summary: preview.draft
      ? {
          ...preview.draft.summary,
          lines: preview.draft.summary.lines.map((l) => ({
            description: l.description,
            code: l.code,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            tax: l.tax,
            total: l.total,
          })),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// La grilla
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = (kind: SalesKind): GridColumn['options'] => {
  const byKind: Record<SalesKind, SalesStatus[]> = {
    quote: [
      'borrador',
      'enviada',
      'aceptada',
      'rechazada',
      'vencida',
      'pedido',
      'facturada',
      'anulada',
    ],
    order: ['pedido', 'facturada', 'anulada'],
    invoice: ['borrador', 'emitiendo', 'emitida', 'error', 'anulada'],
  };
  return byKind[kind].map((s) => ({
    value: s,
    label: SALES_STATUS_LABEL[s],
    tone: SALES_STATUS_TONE[s],
  }));
};

export function salesColumns(kind: SalesKind): GridColumn[] {
  const cols: GridColumn[] = [
    { key: 'numero', label: 'Número', type: 'text', pinned: true, primary: true, width: 120 },
    { key: 'cliente', label: 'Cliente', type: 'text', width: 220 },
    { key: 'estado', label: 'Estado', type: 'status', width: 130, options: STATUS_OPTIONS(kind) },
    { key: 'fecha', label: 'Fecha', type: 'date', width: 120 },
  ];
  if (kind === 'quote')
    cols.push(
      { key: 'valida', label: 'Válida hasta', type: 'date', width: 130 },
      { key: 'enviada', label: 'Enviada', type: 'datetime', width: 150 },
      {
        key: 'vistas',
        label: 'Veces abierta',
        type: 'number',
        width: 120,
        description: 'Cuántas veces el cliente abrió el enlace.',
      },
    );
  if (kind === 'invoice')
    cols.push(
      {
        key: 'factura',
        label: 'Número legal',
        type: 'text',
        width: 130,
        description: 'El número que puso Siigo o Alegra.',
      },
      {
        key: 'dian',
        label: 'DIAN',
        type: 'select',
        width: 120,
        options: [
          { value: 'Aceptada', tone: 'emerald' },
          { value: 'Pendiente', tone: 'amber' },
          { value: 'Rechazada', tone: 'rose' },
          { value: 'Sin enviar', tone: 'neutral' },
        ],
      },
      { key: 'vence', label: 'Vence', type: 'date', width: 120 },
    );
  cols.push(
    { key: 'iva', label: 'IVA', type: 'money', width: 130 },
    { key: 'total', label: 'Total', type: 'money', width: 150 },
    {
      key: 'neto',
      label: 'Neto estimado',
      type: 'money',
      width: 150,
      description: 'Total menos las retenciones que practica el cliente.',
    },
  );
  return cols;
}

export function salesGridRow(doc: SalesDocumentRow, today: string): GridRow {
  const status = salesEffectiveStatus(doc, today);
  return {
    id: doc.id,
    href: `/ventas/${doc.id}`,
    values: {
      numero: salesDocumentNumber({ kind: doc.kind, number: doc.number }),
      cliente: doc.client_name,
      estado: status,
      fecha: doc.issue_date,
      valida: doc.valid_until,
      enviada: doc.sent_at,
      vistas: doc.share_views,
      factura: doc.provider_number,
      dian: doc.einvoice_status,
      vence: doc.due_date,
      iva: doc.iva_total,
      total: doc.total,
      neto: doc.net_total,
    },
  };
}

export function clientSalesSummary(
  docs: SalesDocumentRow[] | null,
  today: string,
  error?: string,
): ClientSalesSummary {
  if (!docs)
    return { docs: [], openQuotesTotal: 0, error: error ?? 'No se pudieron leer las ventas.' };
  return {
    docs: docs.slice(0, 8).map((d) => {
      const status = salesEffectiveStatus(d, today);
      return {
        id: d.id,
        number: salesDocumentNumber(d),
        kindLabel: SALES_KIND_LABEL[d.kind].one,
        statusLabel: SALES_STATUS_LABEL[status],
        statusTone: SALES_STATUS_TONE[status],
        total: d.total,
        currency: d.currency,
        date: d.issue_date,
      };
    }),
    openQuotesTotal: docs
      .filter(
        (d) =>
          d.kind === 'quote' && ['enviada', 'aceptada'].includes(salesEffectiveStatus(d, today)),
      )
      .reduce((s, d) => s + d.total, 0),
    error: null,
  };
}
