import { createHash } from 'node:crypto';
import type { AccountMap, ResolvedAccount } from './mapping';

/**
 * ESCRIBIR EN EL PROGRAMA CONTABLE: LA FORMA COMÚN (migración 0192). Puro.
 *
 * Tres escrituras, las que un contador hace cada mes a mano:
 *
 *   compra          causar la factura de un proveedor ya aprobada
 *                   (Siigo: compra FC; Alegra: bill; QuickBooks: Bill).
 *   recibo          registrar el pago de un cliente que entró al banco contra
 *                   su factura (Siigo: recibo de caja RC; Alegra: payment
 *                   «in»; QuickBooks: Payment).
 *   pago_proveedor  registrar que el banco pagó una factura de proveedor ya
 *                   causada (Siigo: comprobante contable; Alegra: payment
 *                   «out»; QuickBooks: BillPayment).
 *
 * Cada programa tiene su archivo (siigo.ts, alegra.ts, quickbooks.ts) que
 * traduce ESTA forma a su JSON. Aquí vive lo que no depende del programa: los
 * documentos de origen, la partida en débitos y créditos que ve la persona
 * antes de aprobar, y la llave de idempotencia.
 */

export const WRITEBACK_KINDS = ['compra', 'recibo', 'pago_proveedor'] as const;
export type WritebackKind = (typeof WRITEBACK_KINDS)[number];

export const WRITEBACK_KIND_LABEL: Record<WritebackKind, string> = {
  compra: 'Causar factura de compra',
  recibo: 'Registrar recibo de caja',
  pago_proveedor: 'Registrar pago a proveedor',
};

export const WRITEBACK_STATUSES = [
  'pendiente',
  'enviando',
  'registrada',
  'error',
  'incierta',
  'descartada',
] as const;
export type WritebackStatus = (typeof WRITEBACK_STATUSES)[number];

export const WRITEBACK_STATUS_LABEL: Record<WritebackStatus, string> = {
  pendiente: 'Por registrar',
  enviando: 'Enviando',
  registrada: 'Registrada',
  error: 'Con error',
  incierta: 'Revisar en el programa',
  descartada: 'Descartada',
};

export type WritebackProvider = 'siigo' | 'alegra' | 'quickbooks';

export const PROVIDER_LABEL: Record<WritebackProvider, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

// ---------------------------------------------------------------------------
// Los documentos de origen, ya leídos de Cortex
// ---------------------------------------------------------------------------

export interface PurchaseSource {
  kind: 'compra';
  id: string;
  supplierId: string | null;
  supplierName: string;
  /** Sólo dígitos, sin DV. */
  supplierNit: string | null;
  supplierDv: string | null;
  /** El número de la factura DEL PROVEEDOR («FEPA-451»). */
  docNumber: string;
  cufe: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  iva: number;
  otherTaxes: number;
  total: number;
  withholdings: { retefuente: number; reteiva: number; reteica: number };
  lines: Array<{
    description: string;
    amount: number;
    quantity: number | null;
    unitPrice: number | null;
  }>;
  /** Categoría del libro (del movimiento que la refleja), si la tiene. */
  category: string | null;
}

export interface ReceiptSource {
  kind: 'recibo';
  /** `payments.id`. */
  id: string;
  date: string;
  amount: number;
  currency: string;
  customerName: string | null;
  customerNit: string | null;
  invoiceNumber: string;
  /** La factura en el programa (accounting_invoices.source_ref) y su saldo allá. */
  invoiceExternalId: string;
  invoiceBalance: number;
  invoiceDate: string | null;
  bankAccount: string | null;
  reference: string | null;
}

export interface SupplierPaymentSource {
  kind: 'pago_proveedor';
  /** `payable_invoices.id`. */
  id: string;
  date: string;
  amount: number;
  currency: string;
  supplierId: string | null;
  supplierName: string;
  supplierNit: string | null;
  docNumber: string;
  /** La compra en el programa: la causada por Cortex o la que vino de él. */
  purchaseExternalId: string;
  purchaseNumber: string | null;
  bankAccount: string | null;
  reference: string | null;
}

export type WritebackSource = PurchaseSource | ReceiptSource | SupplierPaymentSource;

// ---------------------------------------------------------------------------
// La partida: lo que ve la persona antes de aprobar
// ---------------------------------------------------------------------------

export interface EntryLine {
  account: string;
  accountName: string;
  /** De dónde salió la cuenta: «defecto de Cortex», «categoría», «proveedor». */
  accountSource: ResolvedAccount['source'];
  costCenter: string | null;
  description: string;
  debit: number;
  credit: number;
}

export interface WritebackPreview {
  kind: WritebackKind;
  provider: WritebackProvider;
  /** «Factura FEPA-451 de Papelería El Cóndor». */
  label: string;
  date: string;
  amount: number;
  currency: string;
  counterparty: string;
  entries: EntryLine[];
  /** Lo que impide mandarla, en español. Con uno, no se manda nada. */
  problems: string[];
  /** Lo que conviene mirar sin impedir (una cuenta por defecto, un redondeo). */
  warnings: string[];
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function entry(
  acc: ResolvedAccount,
  description: string,
  debit: number,
  credit: number,
): EntryLine {
  return {
    account: acc.code,
    accountName: acc.name,
    accountSource: acc.source,
    costCenter: acc.costCenter,
    description,
    debit: round2(debit),
    credit: round2(credit),
  };
}

export function balanced(entries: readonly EntryLine[]): boolean {
  const d = entries.reduce((s, e) => s + e.debit, 0);
  const c = entries.reduce((s, e) => s + e.credit, 0);
  return Math.abs(d - c) < 0.015;
}

/**
 * La partida de una compra causada:
 *   Db gasto (subtotal + otros impuestos)   Db IVA descontable
 *   Cr retenciones (fuente, IVA, ICA)       Cr proveedores (lo que se le debe)
 */
export function purchaseEntries(src: PurchaseSource, map: AccountMap): EntryLine[] {
  const expense = map.expense({ supplierId: src.supplierId, category: src.category });
  const w = src.withholdings;
  const base = round2(src.subtotal + src.otherTaxes);
  const payable = round2(src.total - w.retefuente - w.reteiva - w.reteica);
  const what = `${src.supplierName} ${src.docNumber}`;
  const out: EntryLine[] = [entry(expense, `Compra ${what}`, base, 0)];
  if (src.iva > 0) out.push(entry(map.role('iva_descontable'), `IVA ${what}`, src.iva, 0));
  if (w.retefuente > 0)
    out.push(
      entry(map.role(map.withholdingRole(src.category)), `Retefuente ${what}`, 0, w.retefuente),
    );
  if (w.reteiva > 0) out.push(entry(map.role('reteiva'), `ReteIVA ${what}`, 0, w.reteiva));
  if (w.reteica > 0) out.push(entry(map.role('reteica'), `ReteICA ${what}`, 0, w.reteica));
  out.push(entry(map.role('proveedores'), `Por pagar ${what}`, 0, payable));
  return out;
}

/** Recibo de caja: Db banco / Cr clientes. */
export function receiptEntries(src: ReceiptSource, map: AccountMap): EntryLine[] {
  const what = `${src.customerName ?? 'Cliente'} factura ${src.invoiceNumber}`;
  return [
    entry(map.bank(src.bankAccount), `Abono ${what}`, src.amount, 0),
    entry(map.role('clientes'), `Pago ${what}`, 0, src.amount),
  ];
}

/** Pago a proveedor: Db proveedores / Cr banco. */
export function supplierPaymentEntries(src: SupplierPaymentSource, map: AccountMap): EntryLine[] {
  const what = `${src.supplierName} ${src.docNumber}`;
  return [
    entry(map.role('proveedores'), `Pago ${what}`, src.amount, 0),
    entry(map.bank(src.bankAccount), `Salida banco ${what}`, 0, src.amount),
  ];
}

export function entriesFor(src: WritebackSource, map: AccountMap): EntryLine[] {
  if (src.kind === 'compra') return purchaseEntries(src, map);
  if (src.kind === 'recibo') return receiptEntries(src, map);
  return supplierPaymentEntries(src, map);
}

export function sourceLabel(src: WritebackSource): string {
  if (src.kind === 'compra') return `Factura ${src.docNumber} de ${src.supplierName}`;
  if (src.kind === 'recibo')
    return `Pago de ${src.customerName ?? 'cliente'} a la factura ${src.invoiceNumber}`;
  return `Pago a ${src.supplierName} de la factura ${src.docNumber}`;
}

export function sourceDate(src: WritebackSource): string {
  return src.kind === 'compra' ? src.issueDate : src.date;
}

export function sourceAmount(src: WritebackSource): number {
  return src.kind === 'compra' ? src.total : src.amount;
}

export function sourceCounterparty(src: WritebackSource): string {
  if (src.kind === 'recibo') return src.customerName ?? 'Cliente';
  return src.supplierName;
}

/**
 * Lo que impide escribir sin importar el programa: sin NIT no hay tercero, una
 * partida que no cuadra no sale, un importe en cero no es nada.
 */
export function commonProblems(src: WritebackSource, entries: readonly EntryLine[]): string[] {
  const out: string[] = [];
  if (sourceAmount(src) <= 0) out.push('El valor es cero.');
  if (src.kind === 'compra') {
    if (!src.supplierNit)
      out.push(`${src.supplierName} no tiene NIT en Cortex: agrégalo en Por pagar → Proveedores.`);
    const sum = round2(src.subtotal + src.otherTaxes + src.iva);
    if (Math.abs(sum - src.total) > 1)
      out.push(
        `Subtotal + impuestos (${sum.toLocaleString('es-CO')}) no da el total de la factura (${src.total.toLocaleString('es-CO')}): revisa la factura antes de causarla.`,
      );
  }
  if (src.kind === 'recibo' && src.amount - src.invoiceBalance > 1)
    out.push(
      `El pago (${src.amount.toLocaleString('es-CO')}) es mayor que lo que falta de la factura en el programa (${src.invoiceBalance.toLocaleString('es-CO')}).`,
    );
  if (!balanced(entries)) out.push('La partida no cuadra (débitos distintos de créditos).');
  return out;
}

export function defaultAccountWarnings(entries: readonly EntryLine[]): string[] {
  const defaults = entries.filter((e) => e.accountSource === 'defecto');
  if (!defaults.length) return [];
  return [
    `${defaults.length === 1 ? 'Una cuenta usa' : `${defaults.length} cuentas usan`} el defecto de Cortex (${[...new Set(defaults.map((e) => e.account))].join(', ')}): confírmalas con tu plan de cuentas en /cierre → Cuentas.`,
  ];
}

// ---------------------------------------------------------------------------
// Idempotencia
// ---------------------------------------------------------------------------

/**
 * La llave de (empresa, clase, origen). La misma siempre: si la red se corta y
 * se repite, Siigo (cabecera `Idempotency-Key`, alfanumérica, ≤ 30) y
 * QuickBooks (`?requestid=`, ≤ 50) devuelven lo mismo en vez de duplicar.
 */
export function writebackIdempotencyKey(
  organizationId: string,
  kind: WritebackKind,
  sourceId: string,
): string {
  const hex = createHash('sha256')
    .update(`writeback:${organizationId}:${kind}:${sourceId}`)
    .digest('hex');
  return `CXW${hex.slice(0, 27)}`;
}

// ---------------------------------------------------------------------------
// Lo que devuelve el programa
// ---------------------------------------------------------------------------

export interface WrittenDocument {
  id: string;
  number: string | null;
  status?: string | null;
}

/** La sesión de escritura de un programa: lo que cada archivo de proveedor implementa. */
export interface ProviderWriter {
  provider: WritebackProvider;
  /** Lo que sabe registrar este programa. */
  supports: Record<WritebackKind, boolean>;
  /** Arma lo que se mandaría y dice qué falta. No escribe nada. */
  prepare(
    src: WritebackSource,
    entries: EntryLine[],
    map: AccountMap,
  ): Promise<{ payload: unknown; problems: string[]; warnings: string[] }>;
  /** POST. Nunca reintenta solo algo que pudo haber llegado. */
  send(
    src: WritebackSource,
    payload: unknown,
    opts: { idempotencyKey: string },
  ): Promise<WrittenDocument>;
  /** Busca si ya existe (tras una escritura incierta). null si no se puede saber. */
  find?(src: WritebackSource): Promise<WrittenDocument | null>;
}
