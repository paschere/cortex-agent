import {
  type CreditNoteItem,
  type CreditNotePayload,
  type CustomerPayload,
  type OpenInvoice,
  type ReceiptPayload,
  allocatePayment,
  buildCustomerPayload,
  creditNoteProblems,
  customerProblems,
  receiptProblems,
  resolveTaxId,
  round2,
} from '../../accounting/outbound/shape';
import { OUTBOX_KIND_LABEL, type OutboxKind } from '../../accounting/outbound/shape';
import { type TemplateContext, renderTemplate } from './engine';
import { evalAmount } from './invoice-draft';
import type { AutomationAction } from './spec';

/**
 * ARMAR LOS BORRADORES DE CLIENTE, RECIBO DE CAJA Y NOTA CRÉDITO (0232). Puro:
 * sin base, sin reloj, sin red. Lo que necesita de afuera (las facturas con
 * saldo del cliente, la fecha de hoy) entra por parámetro.
 *
 * Lo que no se puede calcular no se inventa: una cantidad ilegible o un NIT
 * inválido detienen el armado con la razón en español; lo que falta pero se
 * corrige a mano (la ciudad, el teléfono, la forma de pago) deja el borrador
 * armado con sus `problems` a la vista para quien revisa.
 */

type Customer = Extract<AutomationAction, { type: 'accounting_draft_receipt' }>['customer'];

const money = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

export function renderField(spec: string | undefined, ctx: TemplateContext): string {
  return spec ? renderTemplate(spec, ctx).trim() : '';
}

/** Número de factura tal como se escribe: «fv-1-68» → «FV-1-68». */
export function cleanInvoiceNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase();
}

export function splitInvoiceList(raw: string): string[] {
  return [...new Set(raw.split(/[,;\n]+/).map(cleanInvoiceNumber).filter(Boolean))];
}

export function resolveCustomer(
  customer: Customer,
  ctx: TemplateContext,
  customerCtx?: TemplateContext,
): { taxId: string; digits: string; name: string } | { error: string } {
  const c = customerCtx ?? ctx;
  const rawTax = renderField(customer.taxId, c);
  if (!rawTax) return { error: 'El NIT del cliente está vacío en la fila.' };
  const nit = resolveTaxId(rawTax);
  if ('error' in nit) return { error: nit.error };
  return { taxId: rawTax, digits: nit.digits, name: renderField(customer.name, c) };
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export type CustomerAction = Extract<AutomationAction, { type: 'accounting_upsert_customer' }>;

export function buildCustomerDraft(input: {
  action: CustomerAction;
  ctx: TemplateContext;
  customerCtx?: TemplateContext;
}): { ok: true; payload: CustomerPayload; problems: string[] } | { ok: false; reason: string } {
  const c = input.customerCtx ?? input.ctx;
  const a = input.action;
  const built = buildCustomerPayload({
    taxId: renderField(a.taxId, c),
    name: renderField(a.name, c),
    email: renderField(a.email, c) || undefined,
    phone: renderField(a.phone, c) || undefined,
    address: renderField(a.address, c) || undefined,
    city: renderField(a.city, c) || undefined,
    personType: a.personType,
    regime: a.regime,
  });
  if (!built.payload) return { ok: false, reason: built.problems.join(' ') };
  return { ok: true, payload: built.payload, problems: [...built.problems, ...customerProblems(built.payload)] };
}

// ---------------------------------------------------------------------------
// Recibo de caja
// ---------------------------------------------------------------------------

export type ReceiptAction = Extract<AutomationAction, { type: 'accounting_draft_receipt' }>;

export function buildReceiptDraft(input: {
  action: ReceiptAction;
  ctx: TemplateContext;
  customerCtx?: TemplateContext;
  today: string;
  /** Facturas con saldo del cliente (o las nombradas en `invoices`). */
  open: readonly OpenInvoice[];
  /** Números pedidos a mano; los que no se encontraron salen como problema. */
  requested: readonly string[];
}):
  | { ok: true; payload: ReceiptPayload; problems: string[]; unapplied: number }
  | { ok: false; reason: string } {
  const a = input.action;
  const who = resolveCustomer(a.customer, input.ctx, input.customerCtx);
  if ('error' in who) return { ok: false, reason: who.error };
  const value = evalAmount(a.amount, input.ctx);
  if (!Number.isFinite(value) || value <= 0)
    return { ok: false, reason: `El valor del pago no es un número mayor que cero (${String(a.amount)}).` };
  const date = renderField(a.date, input.ctx) || input.today;
  const alloc = allocatePayment(value, input.open);
  const problems: string[] = [];
  const found = new Set(input.open.map((i) => i.number.toUpperCase()));
  for (const n of input.requested)
    if (!found.has(n)) problems.push(`No encontré la factura ${n} con saldo en Siigo (¿ya está pagada o todavía no se sincroniza?).`);
  if (alloc.unapplied > 0.005 && alloc.applications.length)
    problems.push(
      `Sobran ${money(alloc.unapplied)} después de cruzar las facturas: quedaría como anticipo; ajusta el valor o apruébalo por lo cruzado.`,
    );
  const payload: ReceiptPayload = {
    customerTaxId: who.digits,
    customerName: who.name,
    date,
    amount: round2(alloc.applications.reduce((s, x) => s + x.amount, 0)) || round2(value),
    applications: alloc.applications,
    bankAccount: renderField(a.bankAccount, input.ctx) || null,
    reference: renderField(a.reference, input.ctx) || null,
  };
  problems.push(...receiptProblems(payload));
  return { ok: true, payload, problems: [...new Set(problems)], unapplied: alloc.unapplied };
}

// ---------------------------------------------------------------------------
// Nota crédito
// ---------------------------------------------------------------------------

export type CreditNoteAction = Extract<AutomationAction, { type: 'accounting_draft_credit_note' }>;

export function buildCreditNoteDraft(input: {
  action: CreditNoteAction;
  ctx: TemplateContext;
  today: string;
  invoice: { externalId: string; customerTaxId: string | null } | null;
}): { ok: true; payload: CreditNotePayload; problems: string[] } | { ok: false; reason: string } {
  const a = input.action;
  const number = cleanInvoiceNumber(renderField(a.invoice, input.ctx));
  if (!number) return { ok: false, reason: 'El número de la factura a afectar está vacío en la fila.' };
  const items: CreditNoteItem[] = [];
  const problems: string[] = [];
  if (a.mode === 'items') {
    for (const [i, it] of (a.items ?? []).entries()) {
      const quantity = evalAmount(it.quantity, input.ctx);
      const unitPrice = evalAmount(it.unitPrice, input.ctx);
      if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice))
        return { ok: false, reason: `La línea ${i + 1} no tiene cantidad o precio que se puedan leer.` };
      if (quantity <= 0) continue;
      items.push({
        description: renderField(it.description, input.ctx) || `Línea ${i + 1}`,
        productCode: renderField(it.productCode, input.ctx) || null,
        quantity,
        unitPrice: round2(unitPrice),
        taxRate: it.taxRate,
      });
    }
  }
  const payload: CreditNotePayload = {
    invoiceNumber: number,
    invoiceExternalId: input.invoice?.externalId ?? null,
    customerTaxId: input.invoice?.customerTaxId ?? null,
    date: renderField(a.date, input.ctx) || input.today,
    reason: a.reason as CreditNotePayload['reason'],
    observations: renderField(a.observations, input.ctx) || `Nota crédito a la factura ${number} (Cortex).`,
    mode: a.mode,
    items,
  };
  problems.push(...creditNoteProblems(payload));
  return { ok: true, payload, problems: [...new Set(problems)] };
}

// ---------------------------------------------------------------------------
// Para mostrar
// ---------------------------------------------------------------------------

/** Una línea legible de un borrador que no es factura: «Recibo de caja · $1.200.000 a FV-1-68 y FV-1-70». */
export function describeOutbox(kind: OutboxKind, payload: Record<string, unknown>): string {
  if (kind === 'receipt') {
    const p = payload as unknown as ReceiptPayload;
    const apps = (p.applications ?? []).map((x) => `${x.invoiceNumber} (${money(x.amount)})`);
    return `Recibo de caja de ${money(p.amount ?? 0)} contra ${apps.length ? apps.join(', ') : 'ninguna factura'}`;
  }
  if (kind === 'credit_note') {
    const p = payload as unknown as CreditNotePayload;
    return `Nota crédito a la factura ${p.invoiceNumber ?? '?'} (${p.mode === 'total' ? 'toda la factura' : `${(p.items ?? []).length} línea(s)`})`;
  }
  if (kind === 'customer') {
    const p = payload as unknown as CustomerPayload;
    return `Crear el cliente ${p.name || '?'} (${p.idType === '31' ? 'NIT' : 'CC'} ${p.taxId}${p.dv ? `-${p.dv}` : ''})`;
  }
  return OUTBOX_KIND_LABEL.invoice;
}

/** Problemas que se ven ANTES de aprobar un borrador que no es factura. */
export function outboxPayloadProblems(kind: OutboxKind, payload: Record<string, unknown>): string[] {
  if (kind === 'receipt') return receiptProblems(payload as unknown as ReceiptPayload);
  if (kind === 'credit_note') return creditNoteProblems(payload as unknown as CreditNotePayload);
  if (kind === 'customer') return customerProblems(payload as unknown as CustomerPayload);
  return [];
}
