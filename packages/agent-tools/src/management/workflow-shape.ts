import { z } from 'zod';
export const workflowStartSchema = z.object({
  caseId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  recipient: z.string().trim().email().max(320),
});
export type WorkflowState = 'ready' | 'approval' | 'waiting' | 'review' | 'blocked' | 'cancelled';
export const workflowLabels: Record<WorkflowState, string> = {
  ready: 'Preparar cobro',
  approval: 'Esperando aprobación',
  waiting: 'Siguiendo el resultado',
  review: 'Pago verificado en los registros',
  blocked: 'Necesita intervención',
  cancelled: 'Seguimiento detenido',
};
export interface CollectionWorkflow {
  id: string;
  case_id: string;
  user_id: string;
  invoice_id: string;
  recipient: string;
  state: WorkflowState;
  detail: string;
  action_id: string | null;
  draft_balance: number | string | null;
  evidence: PaymentProof | null;
  revision: number;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface CollectionInvoice {
  id: string;
  doc_number: string | null;
  counterparty_name: string | null;
  client_id: string | null;
  total_amount: number | string | null;
  currency: string | null;
  due_on: string | null;
  review_state: string;
  doc_type: string;
}
export interface CollectionPayment {
  id: string;
  extraction_id: string | null;
  state: string;
  currency: string;
  kind: string;
  amount: number | string;
  paid_on: string;
}
export interface PaymentProof {
  invoiceId: string;
  invoiceNumber: string | null;
  currency: string;
  invoiceTotal: number;
  confirmedPaid: number;
  balance: number;
  paymentIds: string[];
  checkedAt: string;
  method: string;
}
/** Exact two-decimal conversion; never rounds a value to make the invoice look paid. */
function cents(value: number | string | null): number {
  const raw = String(value ?? '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw))
    throw new Error('El importe requiere revisión: usa hasta dos decimales.');
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace('-', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount))
    throw new Error('El importe está fuera del rango verificable.');
  return negative ? -amount : amount;
}
export function verifyCollectionBalance(
  invoice: CollectionInvoice,
  payments: CollectionPayment[],
  now = new Date(),
): PaymentProof {
  if (invoice.review_state !== 'confirmed' || invoice.doc_type !== 'invoice')
    throw new Error('La factura ya no está confirmada.');
  if (!invoice.currency || !/^[A-Z]{3}$/.test(invoice.currency))
    throw new Error('La factura no tiene una moneda válida.');
  const total = cents(invoice.total_amount);
  if (total <= 0) throw new Error('Revisa el total de la factura.');
  let sum = 0;
  const paymentIds: string[] = [];
  for (const p of payments) {
    if (p.extraction_id !== invoice.id)
      throw new Error('Un pago no está vinculado exactamente a esta factura.');
    if (p.state === 'discarded') continue;
    if (p.state !== 'confirmed')
      throw new Error('Hay pagos reportados o en disputa. Revisa la conciliación antes de cobrar.');
    if (p.currency !== invoice.currency)
      throw new Error('La moneda de un pago no coincide con la factura.');
    if (!['payment', 'reversal', 'adjustment'].includes(p.kind))
      throw new Error('Movimiento de pago no reconocido.');
    const amount = cents(p.amount);
    if (p.kind !== 'adjustment' && amount < 0)
      throw new Error('El signo del pago requiere revisión.');
    sum += p.kind === 'reversal' ? -amount : amount;
    if (!Number.isSafeInteger(sum)) throw new Error('La suma está fuera del rango verificable.');
    paymentIds.push(p.id);
  }
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.doc_number,
    currency: invoice.currency,
    invoiceTotal: total / 100,
    confirmedPaid: sum / 100,
    balance: Math.max(0, total - sum) / 100,
    paymentIds,
    checkedAt: now.toISOString(),
    method:
      'Total confirmado menos movimientos confirmados vinculados por ID de factura; anulaciones restadas. No se emparejan pagos por nombre ni por similitud.',
  };
}
