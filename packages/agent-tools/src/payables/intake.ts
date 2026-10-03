import {
  type PayableEvidence,
  type PayableLine,
  type PayableSource,
  cleanNit,
  payableDedupeKey,
  round2,
} from './shape';
import { UblError, type UblInvoice, looksLikeUbl, parseUblInvoice, withholdingTotals } from './ubl';
import { ZipError, baseName, isZip, readZip } from './zip';

/**
 * DE CADA CAMINO A UNA FACTURA DE PROVEEDOR: LOS TRADUCTORES PUROS.
 *
 *   correo     el adjunto (ZIP de la DIAN o XML suelto) → UBL → borrador
 *   documento  una lectura confirmada como «por pagar» (0076 + 0143)
 *   contable   una compra de Siigo/Alegra/QuickBooks
 *   manual     lo que una persona dicta (chat o formulario)
 *
 * Todos terminan en `PayableDraft`, que store.ts guarda con dedupe por CUFE y
 * por proveedor + número.
 */

export interface PayableDraft {
  source: PayableSource;
  sourceSystem: string;
  sourceRef: string;
  cufe: string | null;
  docNumber: string;
  supplierNit: string | null;
  supplierDv: string | null;
  supplierName: string;
  customerNit: string | null;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  subtotal: number | null;
  iva: number;
  otherTaxes: number;
  total: number;
  /** Retenciones que la factura ya informa (si las informa). */
  withholdings: { retefuente: number; reteiva: number; reteica: number } | null;
  lines: PayableLine[];
  orderReference: string | null;
  evidence: PayableEvidence;
  dianValidated: boolean | null;
  extractionId?: string | null;
  /** Para lo que llega del documento: su fila en el libro ya existe. */
  ledgerMovementId?: string | null;
}

export function dedupeKeyOf(d: Pick<PayableDraft, 'supplierNit' | 'supplierName' | 'docNumber'>) {
  return payableDedupeKey(d);
}

// ---------------------------------------------------------------------------
// Correo: el adjunto
// ---------------------------------------------------------------------------

export interface AttachmentInvoices {
  invoices: Array<{ invoice: UblInvoice; files: string[] }>;
  /** Notas crédito/débito y otros XML que no son factura: se dicen, no se pagan. */
  notes: Array<{ kind: string; number: string | null; file: string }>;
  errors: string[];
}

const XML_RE = /\.xml$/i;

/** ¿Vale la pena bajar este adjunto? Por nombre y tipo, sin bajarlo. */
export function isInvoiceAttachmentName(filename: string, mime?: string | null): boolean {
  const n = filename.toLowerCase();
  const m = (mime ?? '').toLowerCase();
  return (
    n.endsWith('.zip') ||
    n.endsWith('.xml') ||
    m === 'application/zip' ||
    m === 'application/x-zip-compressed' ||
    m === 'application/xml' ||
    m === 'text/xml'
  );
}

/**
 * Las facturas de un adjunto. Un ZIP de la DIAN trae un XML (la factura en su
 * AttachedDocument) y el PDF; un correo puede traer el XML suelto. Nunca
 * lanza: lo que no se pudo leer va en `errors`.
 */
export function invoicesFromAttachment(filename: string, data: Buffer): AttachmentInvoices {
  const out: AttachmentInvoices = { invoices: [], notes: [], errors: [] };
  let xmls: Array<{ name: string; text: string }> = [];
  let files: string[] = [baseName(filename)];
  if (isZip(data)) {
    try {
      const entries = readZip(data, (name) => /\.(xml|pdf)$/i.test(name));
      files = entries.map((e) => baseName(e.name));
      xmls = entries
        .filter((e) => XML_RE.test(e.name))
        .map((e) => ({ name: baseName(e.name), text: e.data.toString('utf8') }));
    } catch (err) {
      out.errors.push(err instanceof ZipError ? err.message : 'No se pudo abrir el ZIP.');
      return out;
    }
  } else if (XML_RE.test(filename) || data.subarray(0, 200).toString('utf8').includes('<')) {
    xmls = [{ name: baseName(filename), text: data.toString('utf8') }];
  } else {
    out.errors.push(`${filename} no es ni ZIP ni XML.`);
    return out;
  }
  for (const x of xmls) {
    if (!looksLikeUbl(x.text)) continue;
    try {
      const invoice = parseUblInvoice(x.text);
      if (invoice.kind !== 'invoice') {
        out.notes.push({ kind: invoice.kind, number: invoice.number, file: x.name });
        continue;
      }
      if (out.invoices.some((i) => i.invoice.number === invoice.number)) continue;
      out.invoices.push({ invoice, files });
    } catch (err) {
      out.errors.push(
        `${x.name}: ${err instanceof UblError ? err.message : 'no se pudo leer la factura.'}`,
      );
    }
  }
  return out;
}

export function draftFromUbl(
  inv: UblInvoice,
  opts: { sourceRef: string; sourceSystem?: string; evidence: PayableEvidence },
): PayableDraft {
  const w = withholdingTotals(inv);
  const otherTaxes = round2(
    inv.taxes.filter((t) => t.code !== '01').reduce((s, t) => s + t.amount, 0),
  );
  const informed = w.retefuente + w.reteiva + w.reteica > 0;
  return {
    source: 'correo',
    sourceSystem: opts.sourceSystem ?? '',
    sourceRef: opts.sourceRef,
    cufe: inv.cufe,
    docNumber: inv.number,
    supplierNit: inv.supplier.nit,
    supplierDv: inv.supplier.dv,
    supplierName: inv.supplier.name ?? `NIT ${inv.supplier.nit}`,
    customerNit: inv.customer.nit,
    currency: inv.currency,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    subtotal: inv.subtotal,
    iva: inv.iva,
    otherTaxes,
    total: inv.total,
    withholdings: informed ? w : null,
    lines: inv.lines,
    orderReference: inv.orderReference,
    evidence: opts.evidence,
    dianValidated: inv.dianValidation?.accepted ?? null,
  };
}

// ---------------------------------------------------------------------------
// Documento confirmado (Bandeja / Cerebro)
// ---------------------------------------------------------------------------

export interface ExtractionSource {
  id: string;
  document_id: string;
  doc_number: string | null;
  counterparty_nit: string | null;
  counterparty_name: string | null;
  total_amount: number | string | null;
  tax_amount: number | string | null;
  currency: string | null;
  issued_on: string | null;
  due_on: string | null;
  created_at: string;
}

/** Null si la lectura no alcanza para una factura (sin número, valor o moneda). */
export function draftFromExtraction(
  ext: ExtractionSource,
  opts: { ledgerMovementId?: string | null; title?: string | null },
): PayableDraft | null {
  const total = ext.total_amount == null ? null : Number(ext.total_amount);
  if (!ext.doc_number || total == null || !Number.isFinite(total) || !ext.currency) return null;
  const tax = ext.tax_amount == null ? 0 : Number(ext.tax_amount) || 0;
  const nit = cleanNit(ext.counterparty_nit);
  return {
    source: 'documento',
    sourceSystem: '',
    sourceRef: `extraction:${ext.id}`,
    cufe: null,
    docNumber: ext.doc_number,
    supplierNit: nit,
    supplierDv: null,
    supplierName: ext.counterparty_name?.trim() || (nit ? `NIT ${nit}` : 'Proveedor sin nombre'),
    customerNit: null,
    currency: ext.currency,
    issueDate: ext.issued_on ?? ext.created_at.slice(0, 10),
    dueDate: ext.due_on,
    subtotal: tax > 0 ? round2(total - tax) : null,
    iva: round2(tax),
    otherTaxes: 0,
    total: round2(total),
    withholdings: null,
    lines: [],
    orderReference: null,
    evidence: { documentId: ext.document_id, note: opts.title ?? null },
    dianValidated: null,
    extractionId: ext.id,
    ledgerMovementId: opts.ledgerMovementId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Programa contable: compras
// ---------------------------------------------------------------------------

export interface AccountingPurchase {
  externalId: string;
  number: string;
  date: string;
  dueDate?: string | null;
  supplierName?: string | null;
  supplierTaxId?: string | null;
  total: number;
  balance: number;
  currency: string;
  status: 'open' | 'paid' | 'annulled';
}

export function draftFromAccountingPurchase(p: AccountingPurchase, system: string): PayableDraft {
  const nit = cleanNit(p.supplierTaxId);
  return {
    source: 'contable',
    sourceSystem: system,
    sourceRef: `purchase:${p.externalId}`,
    cufe: null,
    docNumber: p.number,
    supplierNit: nit,
    supplierDv: null,
    supplierName: p.supplierName?.trim() || (nit ? `NIT ${nit}` : 'Proveedor sin nombre'),
    customerNit: null,
    currency: p.currency,
    issueDate: p.date,
    dueDate: p.dueDate ?? null,
    subtotal: null,
    iva: 0,
    otherTaxes: 0,
    total: round2(p.total),
    withholdings: null,
    lines: [],
    orderReference: null,
    evidence: { note: `Compra registrada en ${system}` },
    dianValidated: null,
  };
}

// ---------------------------------------------------------------------------
// A mano / chat
// ---------------------------------------------------------------------------

export interface ManualPayable {
  supplierName: string;
  supplierNit?: string | null;
  docNumber: string;
  issueDate: string;
  dueDate?: string | null;
  total: number;
  iva?: number | null;
  currency?: string | null;
  orderReference?: string | null;
  note?: string | null;
}

export function draftFromManual(
  m: ManualPayable,
  opts: { source: 'manual' | 'chat'; ref: string },
): PayableDraft {
  const nit = cleanNit(m.supplierNit);
  const iva = round2(m.iva ?? 0);
  return {
    source: opts.source,
    sourceSystem: '',
    sourceRef: opts.ref,
    cufe: null,
    docNumber: m.docNumber.trim(),
    supplierNit: nit,
    supplierDv: m.supplierNit?.match(/-\s*(\d)\s*$/)?.[1] ?? null,
    supplierName: m.supplierName.trim(),
    customerNit: null,
    currency: (m.currency ?? 'COP').toUpperCase(),
    issueDate: m.issueDate,
    dueDate: m.dueDate ?? null,
    subtotal: iva > 0 ? round2(m.total - iva) : null,
    iva,
    otherTaxes: 0,
    total: round2(m.total),
    withholdings: null,
    lines: [],
    orderReference: m.orderReference ?? null,
    evidence: { note: m.note ?? null },
    dianValidated: null,
  };
}
