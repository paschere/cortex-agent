import {
  type MovementDraft,
  invoiceLinkKey,
  normalizeTaxId,
  normalizeText,
  num,
  paymentLinkKey,
  round2,
} from './shape';
import type { LedgerSourceKind } from './types';

/**
 * DE CADA FUENTE AL LIBRO: LOS TRADUCTORES PUROS.
 *
 * Una función por fuente, de su fila a uno o más `MovementDraft`. Ninguna toca
 * la base: reciben lo que el sincronizador (sync.ts) o el importador del
 * extracto ya leyeron, y devuelven borradores con su identidad en la fuente
 * (`source.ref`) — la que hace que traer lo mismo dos veces no duplique — y,
 * cuando la hay, la llave del hecho real (`linkKey`) que deja enlazar el
 * recibo de Siigo con el abono del banco del mismo pago (dedup.ts).
 *
 * LAS REFERENCIAS, POR FUENTE (con `source_system` delante, son únicas):
 *
 *   accounting  invoice:<id en el programa>        la factura (por cobrar)
 *               paid:<id>:<centavos cobrados>       lo cobrado inferido del saldo
 *               receipt:<ref del recibo>            un pago que trajo el programa
 *   bank        <ref del abono en el extracto>      la MISMA que su payment_report
 *               d:<huella de la salida>             una salida del extracto
 *   payment     report:<id del reporte>             un pago a mano o de comprobante
 *   document    extraction:<id>                      una factura leída y confirmada
 */

// ---------------------------------------------------------------------------
// Programa contable: facturas
// ---------------------------------------------------------------------------

export interface AccountingInvoiceSource {
  id: string;
  source_system: string;
  source_ref: string;
  doc_number: string;
  client_nit: string | null;
  counterparty_name: string | null;
  currency: string;
  total: number | string;
  balance: number | string;
  issued_on: string;
  due_on: string | null;
  annulled: boolean;
  synced_at?: string | null;
}

export interface AccountingInvoiceOptions {
  /** La conexión trae los pagos (entonces lo cobrado ya entra como recibo). */
  bringsPayments: boolean;
  /** Lo ya inferido como cobrado antes de esta corrida (suma de `paid:` previos). */
  priorPaid: number;
  today: string;
  /** El nombre del cliente cuando la factura sólo trae el NIT. */
  clientName?: string | null;
}

/**
 * Una factura del programa contable es una cuenta por cobrar con el saldo que
 * dice el programa. Si la conexión NO trae los pagos, lo cobrado (total menos
 * saldo) se infiere como un ingreso: una fila por cada vez que se ve subir lo
 * cobrado, con el valor de esa subida. La primera vez, fechada en el
 * vencimiento (o la emisión) sin pasar de hoy; las siguientes, el día en que se
 * vio. La fecha es aproximada y la descripción lo dice.
 */
export function accountingInvoiceDrafts(
  inv: AccountingInvoiceSource,
  opts: AccountingInvoiceOptions,
): MovementDraft[] {
  const total = num(inv.total) ?? 0;
  const balance = Math.max(0, num(inv.balance) ?? 0);
  const who = inv.counterparty_name?.trim() || opts.clientName?.trim() || null;
  const system = inv.source_system;
  const out: MovementDraft[] = [
    {
      direction: 'in',
      kind: 'receivable',
      status: inv.annulled ? 'cancelled' : balance <= 0.004 ? 'settled' : 'expected',
      amount: total,
      currency: inv.currency,
      date: inv.issued_on,
      dueDate: inv.due_on,
      settledAt: null,
      outstanding: inv.annulled ? 0 : balance,
      counterpartyName: who,
      counterpartyTaxId: normalizeTaxId(inv.client_nit),
      description: [`Factura ${inv.doc_number}`, who].filter(Boolean).join(' · '),
      docNumber: inv.doc_number,
      linkKey: invoiceLinkKey({ direction: 'in', docNumber: inv.doc_number }),
      source: { kind: 'accounting', system, ref: `invoice:${inv.source_ref}` },
    },
  ];
  if (opts.bringsPayments || inv.annulled) return out;
  const paid = round2(Math.max(0, total - balance));
  const delta = round2(paid - opts.priorPaid);
  if (delta <= 0.004) return out;
  const firstSeen = opts.priorPaid <= 0.004;
  const anchor = inv.due_on ?? inv.issued_on;
  const date = firstSeen ? (anchor < opts.today ? anchor : opts.today) : opts.today;
  out.push({
    direction: 'in',
    kind: 'income',
    status: 'settled',
    amount: delta,
    currency: inv.currency,
    date,
    settledAt: date,
    counterpartyName: who,
    counterpartyTaxId: normalizeTaxId(inv.client_nit),
    description: `Cobro de la factura ${inv.doc_number}${who ? ` · ${who}` : ''} (inferido de la baja del saldo en ${system}; fecha aproximada)`,
    docNumber: inv.doc_number,
    source: {
      kind: 'accounting',
      system,
      ref: `paid:${inv.source_ref}:${Math.round(paid * 100)}`,
    },
  });
  return out;
}

// ---------------------------------------------------------------------------
// Pagos reportados (0098): a mano, de comprobante, de un sistema o del banco
// ---------------------------------------------------------------------------

export interface PaymentReportSource {
  id: string;
  payment_id: string | null;
  kind: 'payment' | 'reversal' | 'adjustment';
  amount: number | string;
  currency: string;
  paid_on: string;
  client_nit: string | null;
  invoice_number: string | null;
  reference: string | null;
  note: string | null;
  source_kind: 'manual' | 'system' | 'document';
  source_system: string | null;
  source_ref: string | null;
}

export interface PaymentReportOptions {
  /** Estado del pago al que contribuye ('reported', 'confirmed', 'disputed', 'discarded'). */
  paymentState: string | null;
  clientName?: string | null;
  /** ¿Este sistema es un programa contable? ('siigo', 'alegra', 'quickbooks'). */
  isAccountingSystem: (system: string) => boolean;
  /** ¿Este sistema es un extracto? ('extracto · <cuenta>'). */
  isBankSystem: (system: string) => boolean;
  /** La cuenta de caja del extracto, si ya existe. */
  accountId?: string | null;
}

/**
 * Lo que una fuente dijo de un pago, como ingreso que ya pasó. Una devolución
 * (reversal) es plata que sale. Un pago descartado por una persona queda
 * anulado; uno en disputa queda excluido de toda suma, como en Pagos. Un
 * reporte todavía sin pago (a la espera) no ha movido ninguna cifra en Pagos y
 * tampoco aquí — salvo el del banco, que es plata que de verdad entró.
 */
export function paymentReportDraft(
  r: PaymentReportSource,
  opts: PaymentReportOptions,
): MovementDraft | null {
  const system = r.source_system ?? '';
  const bank = r.source_kind === 'system' && opts.isBankSystem(system);
  if (!r.payment_id && !bank) return null;
  const accounting = r.source_kind === 'system' && !bank && opts.isAccountingSystem(system);
  let kind: LedgerSourceKind;
  let sourceSystem: string;
  let ref: string;
  if (bank) {
    kind = 'bank';
    sourceSystem = system;
    ref = r.source_ref ?? `report:${r.id}`;
  } else if (accounting) {
    kind = 'accounting';
    sourceSystem = system;
    ref = `receipt:${r.source_ref ?? r.id}`;
  } else {
    kind = 'payment';
    sourceSystem = r.source_kind === 'system' ? system : r.source_kind;
    ref = `report:${r.id}`;
  }
  const amount = num(r.amount) ?? 0;
  const who = opts.clientName?.trim() || null;
  const description =
    [r.note, r.reference].map((t) => t?.trim()).find(Boolean) ??
    (r.kind === 'reversal' ? 'Devolución de un pago' : 'Pago recibido');
  return {
    direction: r.kind === 'reversal' ? 'out' : 'in',
    kind: 'income',
    status: opts.paymentState === 'discarded' ? 'cancelled' : 'settled',
    amount,
    currency: r.currency,
    date: r.paid_on,
    settledAt: r.paid_on,
    counterpartyName: who,
    counterpartyTaxId: normalizeTaxId(r.client_nit),
    description: r.invoice_number ? `${description} · factura ${r.invoice_number}` : description,
    docNumber: r.invoice_number,
    accountId: bank ? (opts.accountId ?? null) : null,
    linkKey: paymentLinkKey(r.payment_id),
    excludedReason: opts.paymentState === 'disputed' ? 'disputed' : null,
    source: { kind, system: sourceSystem, ref },
  };
}

// ---------------------------------------------------------------------------
// El extracto del banco: abonos Y salidas
// ---------------------------------------------------------------------------

export interface BankLineSource {
  date: string;
  amount: number;
  direction: 'credit' | 'debit';
  description: string;
  reference: string | null;
  nit: string | null;
  counterparty: string | null;
  /** La referencia del abono (la misma de su payment_report) o la huella de la salida. */
  sourceRef: string;
}

const TRANSFER_PATTERNS = [
  'traslado entre cuentas',
  'traslado de fondos',
  'traslado fondos',
  'transferencia entre cuentas',
  'entre cuentas propias',
  'cuenta propia',
  'cuentas propias',
  'traslado a cuenta',
  'traslado desde cuenta',
].map(normalizeText);

/** ¿El extracto dice que es plata entre cuentas propias? */
export function looksLikeTransfer(text: string): boolean {
  const t = ` ${normalizeText(text)} `;
  return TRANSFER_PATTERNS.some((p) => t.includes(` ${p} `));
}

export function bankLineDraft(
  line: BankLineSource,
  opts: { system: string; currency: string; accountId: string | null; paymentId?: string | null },
): MovementDraft {
  const text = [line.description, line.reference].filter(Boolean).join(' · ');
  const transfer = looksLikeTransfer(`${line.description} ${line.reference ?? ''}`);
  const credit = line.direction === 'credit';
  return {
    direction: credit ? 'in' : 'out',
    kind: transfer ? 'transfer' : credit ? 'income' : 'expense',
    status: 'settled',
    amount: round2(line.amount),
    currency: opts.currency,
    date: line.date,
    settledAt: line.date,
    counterpartyName: line.counterparty?.trim() || null,
    counterpartyTaxId: normalizeTaxId(line.nit),
    description: text || (credit ? 'Abono en el banco' : 'Salida del banco'),
    accountId: opts.accountId,
    linkKey: credit ? paymentLinkKey(opts.paymentId ?? null) : null,
    source: {
      kind: 'bank',
      system: opts.system,
      // Los abonos llevan la MISMA referencia que su payment_report, para que la
      // ingesta desde Pagos y la del extracto caigan en la misma fila.
      ref: credit ? line.sourceRef : `d:${line.sourceRef}`.slice(0, 200),
    },
  };
}

// ---------------------------------------------------------------------------
// Documentos confirmados: facturas por cobrar y por pagar (0076 + 0143)
// ---------------------------------------------------------------------------

export interface DocumentInvoiceSource {
  id: string;
  doc_type: string | null;
  review_state: string;
  financial_role: string | null;
  doc_number: string | null;
  counterparty_nit: string | null;
  counterparty_name: string | null;
  total_amount: number | string | null;
  currency: string | null;
  issued_on: string | null;
  due_on: string | null;
  created_at: string;
}

/** La referencia de un documento en el libro: la misma pase lo que pase con él. */
export function documentRef(extractionId: string): string {
  return `extraction:${extractionId}`;
}

/**
 * Una factura leída que una persona confirmó y clasificó (0143) como por
 * cobrar o por pagar. Lo cobrado de una por cobrar son los pagos que cuentan
 * atados a ella (`applied`), como en la cartera. Una por pagar entra abierta;
 * la salida del banco que la pague la salda después (payables.ts, 0173), y
 * traerla otra vez abierta no deshace eso.
 *
 * Devuelve null cuando el documento no califica (sin confirmar, sin rol, sin
 * valor o sin moneda): quien llama anula la fila que existiera.
 */
export function documentDraft(
  ext: DocumentInvoiceSource,
  opts: { applied?: number; today: string },
): MovementDraft | null {
  if (ext.review_state !== 'confirmed') return null;
  const role = ext.financial_role;
  if (role !== 'receivable' && role !== 'payable') return null;
  const total = num(ext.total_amount);
  if (total == null || !ext.currency) return null;
  const receivable = role === 'receivable';
  const outstanding = receivable ? round2(Math.max(0, total - (opts.applied ?? 0))) : total;
  const who = ext.counterparty_name?.trim() || null;
  const date = ext.issued_on ?? ext.created_at.slice(0, 10);
  const label = receivable ? 'Factura' : 'Factura de compra';
  return {
    direction: receivable ? 'in' : 'out',
    kind: receivable ? 'receivable' : 'payable',
    status: outstanding <= 0.004 ? 'settled' : 'expected',
    amount: total,
    currency: ext.currency,
    date,
    dueDate: ext.due_on,
    settledAt: null,
    outstanding,
    counterpartyName: who,
    counterpartyTaxId: normalizeTaxId(ext.counterparty_nit),
    description: [`${label}${ext.doc_number ? ` ${ext.doc_number}` : ''}`, who]
      .filter(Boolean)
      .join(' · '),
    docNumber: ext.doc_number,
    linkKey: invoiceLinkKey({
      direction: receivable ? 'in' : 'out',
      docNumber: ext.doc_number,
      counterpartyTaxId: ext.counterparty_nit,
      counterpartyName: who,
    }),
    source: { kind: 'document', system: '', ref: documentRef(ext.id) },
  };
}
