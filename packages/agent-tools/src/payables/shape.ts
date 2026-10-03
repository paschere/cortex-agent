/**
 * CUENTAS POR PAGAR: EL VOCABULARIO (migración 0181). Puro.
 *
 * Estados, transiciones permitidas, la llave que hace que la misma factura
 * llegada por tres caminos sea una sola, y la forma de una fila. Lo importan
 * la base (store.ts), las herramientas y las pantallas (sólo tipos).
 */

export const PAYABLE_STATUSES = [
  'recibida',
  'por_aprobar',
  'aprobada',
  'programada',
  'pagada',
  'rechazada',
] as const;
export type PayableStatus = (typeof PAYABLE_STATUSES)[number];

export const PAYABLE_STATUS_LABEL: Record<PayableStatus, string> = {
  recibida: 'Por revisar',
  por_aprobar: 'Por aprobar',
  aprobada: 'Aprobada',
  programada: 'Programada',
  pagada: 'Pagada',
  rechazada: 'Rechazada',
};

export const PAYABLE_STATUS_TONE: Record<
  PayableStatus,
  'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'
> = {
  recibida: 'amber',
  por_aprobar: 'primary',
  aprobada: 'primary',
  programada: 'emerald',
  pagada: 'neutral',
  rechazada: 'rose',
};

export const PAYABLE_SOURCES = ['correo', 'documento', 'contable', 'manual', 'chat'] as const;
export type PayableSource = (typeof PAYABLE_SOURCES)[number];

export const PAYABLE_SOURCE_LABEL: Record<PayableSource, string> = {
  correo: 'Correo (factura electrónica)',
  documento: 'Bandeja / Cerebro',
  contable: 'Programa contable',
  manual: 'A mano',
  chat: 'Chat',
};

/** Lo que sigue abierto: todavía hay que decidir o pagar. */
export const OPEN_STATUSES: readonly PayableStatus[] = [
  'recibida',
  'por_aprobar',
  'aprobada',
  'programada',
];

/** Lo que espera un visto bueno. */
export const AWAITING_APPROVAL: readonly PayableStatus[] = ['recibida', 'por_aprobar'];

/** De qué estado a cuál se puede pasar. */
const TRANSITIONS: Record<PayableStatus, readonly PayableStatus[]> = {
  recibida: ['por_aprobar', 'aprobada', 'rechazada'],
  por_aprobar: ['aprobada', 'rechazada', 'recibida'],
  aprobada: ['programada', 'pagada', 'rechazada', 'por_aprobar'],
  programada: ['programada', 'aprobada', 'pagada', 'rechazada'],
  // Una pagada sólo se reabre si el pago del banco que la saldó se cae.
  pagada: ['aprobada', 'programada'],
  rechazada: ['por_aprobar'],
};

export function canMove(from: PayableStatus, to: PayableStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class PayableTransitionError extends Error {}

export function assertMove(from: PayableStatus, to: PayableStatus, docNumber?: string): void {
  if (canMove(from, to)) return;
  const what = docNumber ? `La factura ${docNumber}` : 'La factura';
  throw new PayableTransitionError(
    `${what} está ${PAYABLE_STATUS_LABEL[from].toLowerCase()}; no puede pasar a ${PAYABLE_STATUS_LABEL[to].toLowerCase()}.`,
  );
}

// ---------------------------------------------------------------------------
// Revisión automática
// ---------------------------------------------------------------------------

export type CheckSeverity = 'info' | 'warn' | 'block';

export type CheckCode =
  | 'duplicate_suspect'
  | 'wrong_customer_nit'
  | 'invalid_supplier_dv'
  | 'supplier_nit_mismatch'
  | 'price_jump'
  | 'amount_unusual'
  | 'missing_withholding'
  | 'po_mismatch'
  | 'po_missing'
  | 'po_match'
  | 'no_due_date'
  | 'dian_rejected'
  | 'totals_mismatch'
  | 'overdue';

export interface PayableCheck {
  code: CheckCode;
  severity: CheckSeverity;
  message: string;
}

export const CHECK_SEVERITY_LABEL: Record<CheckSeverity, string> = {
  info: 'Nota',
  warn: 'Revisar',
  block: 'Detiene',
};

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

/** Dígitos del NIT, sin puntos ni DV si viene con guion. */
export function cleanNit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const dash = t.match(/^([\d.\s]+)-\s*\d$/);
  const d = (dash ? (dash[1] as string) : t).replace(/\D/g, '');
  return d.length >= 3 && d.length <= 15 ? d : null;
}

/** El número de factura comparable: «FE-0012», «fe 12» y «FE12» son la misma. */
export function numberKey(raw: string | null | undefined): string {
  const t = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Quitar ceros a la izquierda de la parte numérica final.
  return t.replace(/^([A-Z]*)0+(\d)/, '$1$2');
}

/** Nombre para comparar: sin tildes, sin signos, sin sufijos societarios. */
export function supplierNameKey(raw: string | null | undefined): string {
  const words = (raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const SUFFIX = new Set(['sas', 's', 'a', 'sa', 'ltda', 'limitada', 'eu', 'cia', 'y', 'bic']);
  while (words.length > 1 && SUFFIX.has(words[words.length - 1] as string)) words.pop();
  return words.join('').slice(0, 200) || 'sin-nombre';
}

/**
 * La llave de dedupe: el NIT (9 primeros dígitos, como el libro) o el nombre,
 * y el número. Dos «Factura 1» de dos proveedores no son la misma.
 */
export function payableDedupeKey(input: {
  supplierNit?: string | null;
  supplierName?: string | null;
  docNumber: string;
}): string {
  const nit = cleanNit(input.supplierNit);
  const who = nit ? nit.slice(0, 9) : `n:${supplierNameKey(input.supplierName).slice(0, 60)}`;
  return `${who}:${numberKey(input.docNumber) || input.docNumber.trim()}`.slice(0, 200);
}

// ---------------------------------------------------------------------------
// La fila
// ---------------------------------------------------------------------------

export interface PayableLine {
  position: number;
  description: string;
  code: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number;
}

export interface PayableEvidence {
  provider?: 'google' | 'microsoft' | null;
  messageId?: string | null;
  subject?: string | null;
  from?: string | null;
  files?: string[];
  documentId?: string | null;
  note?: string | null;
}

export interface PaidEvidence {
  /** bank: una salida del extracto; accounting: el programa la trae pagada; manual: una persona. */
  kind: 'bank' | 'accounting' | 'manual';
  movementId?: string | null;
  reference?: string | null;
  note?: string | null;
  documentId?: string | null;
}

export interface PayableInvoiceRow {
  id: string;
  organization_id?: string;
  supplier_id: string | null;
  source: PayableSource;
  source_system: string;
  source_ref: string;
  cufe: string | null;
  doc_number: string;
  dedupe_key: string;
  supplier_nit: string | null;
  supplier_dv: string | null;
  supplier_name: string;
  customer_nit: string | null;
  currency: string;
  issue_date: string;
  due_date: string | null;
  subtotal: number | string | null;
  iva: number | string;
  other_taxes: number | string;
  total: number | string;
  retefuente: number | string;
  reteiva: number | string;
  reteica: number | string;
  withholding_source: 'factura' | 'proveedor' | 'persona' | null;
  net_amount: number | string;
  lines: PayableLine[];
  order_reference: string | null;
  purchase_order_id: string | null;
  status: PayableStatus;
  checks: PayableCheck[];
  checked_at: string | null;
  approver_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  scheduled_pay_date: string | null;
  scheduled_by: string | null;
  schedule_note: string | null;
  paid_at: string | null;
  paid_by: string | null;
  paid_evidence: PaidEvidence | null;
  ledger_movement_id: string | null;
  extraction_id: string | null;
  evidence: PayableEvidence;
  dian_validated: boolean | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const PAYABLE_COLUMNS =
  'id, supplier_id, source, source_system, source_ref, cufe, doc_number, dedupe_key, supplier_nit, supplier_dv, supplier_name, customer_nit, currency, issue_date, due_date, subtotal, iva, other_taxes, total, retefuente, reteiva, reteica, withholding_source, net_amount, lines, order_reference, purchase_order_id, status, checks, checked_at, approver_id, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, scheduled_pay_date, scheduled_by, schedule_note, paid_at, paid_by, paid_evidence, ledger_movement_id, extraction_id, evidence, dian_validated, created_by, created_at, updated_at';

export interface SupplierRow {
  id: string;
  nit: string | null;
  name: string;
  name_key: string;
  email: string | null;
  payment_terms_days: number | null;
  approver_id: string | null;
  retefuente_rate: number | string | null;
  reteiva_rate: number | string | null;
  reteica_rate: number | string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const SUPPLIER_COLUMNS =
  'id, nit, name, name_key, email, payment_terms_days, approver_id, retefuente_rate, reteiva_rate, reteica_rate, notes, created_at, updated_at';

export function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** La factura, en camelCase y con números de verdad: lo que ven tools y pantallas. */
export interface PayableInvoice {
  id: string;
  supplierId: string | null;
  supplierName: string;
  supplierNit: string | null;
  source: PayableSource;
  cufe: string | null;
  docNumber: string;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  subtotal: number | null;
  iva: number;
  total: number;
  withholdings: { retefuente: number; reteiva: number; reteica: number };
  netAmount: number;
  status: PayableStatus;
  checks: PayableCheck[];
  approverId: string | null;
  approvedAt: string | null;
  scheduledPayDate: string | null;
  paidAt: string | null;
  rejectionReason: string | null;
  orderReference: string | null;
  purchaseOrderId: string | null;
  lineCount: number;
  ledgerMovementId: string | null;
  evidence: PayableEvidence;
  paidEvidence: PaidEvidence | null;
  dianValidated: boolean | null;
  createdAt: string;
}

export function adaptPayable(row: PayableInvoiceRow): PayableInvoice {
  const total = num(row.total) ?? 0;
  const w = {
    retefuente: num(row.retefuente) ?? 0,
    reteiva: num(row.reteiva) ?? 0,
    reteica: num(row.reteica) ?? 0,
  };
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierNit: row.supplier_nit,
    source: row.source,
    cufe: row.cufe,
    docNumber: row.doc_number,
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    subtotal: num(row.subtotal),
    iva: num(row.iva) ?? 0,
    total,
    withholdings: w,
    netAmount:
      num(row.net_amount) ?? round2(Math.max(0, total - w.retefuente - w.reteiva - w.reteica)),
    status: row.status,
    checks: Array.isArray(row.checks) ? row.checks : [],
    approverId: row.approver_id,
    approvedAt: row.approved_at,
    scheduledPayDate: row.scheduled_pay_date,
    paidAt: row.paid_at,
    rejectionReason: row.rejection_reason,
    orderReference: row.order_reference,
    purchaseOrderId: row.purchase_order_id,
    lineCount: Array.isArray(row.lines) ? row.lines.length : 0,
    ledgerMovementId: row.ledger_movement_id,
    evidence: row.evidence ?? {},
    paidEvidence: row.paid_evidence,
    dianValidated: row.dian_validated,
    createdAt: row.created_at,
  };
}

/** Lo que sale del banco: neto de retenciones. */
export function netOf(inv: Pick<PayableInvoice, 'netAmount'>): number {
  return inv.netAmount;
}

/** Cuándo vence de verdad: la fecha de la factura, o emisión + plazo, o emisión + 30. */
export function effectiveDueDate(input: {
  issueDate: string;
  dueDate: string | null;
  termsDays?: number | null;
}): string {
  if (input.dueDate) return input.dueDate;
  const days = input.termsDays ?? 30;
  const t = Date.parse(`${input.issueDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function moneyCop(n: number, currency = 'COP'): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'COP' ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «3 nov». */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`.trim();
}
