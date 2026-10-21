import { ACCOUNTING_PROVIDER_IDS, type AccountingEntity, type AccountingProviderId } from './types';
import { accountingTableSlug } from './tables';

/**
 * SUCESOS CONTABLES, EN LAS PALABRAS DE QUIEN LOS USA (0232). Puro.
 *
 * Siigo NO avisa cuando se crea una factura o entra un recibo (sus webhooks sólo
 * cubren productos y existencias), así que los sucesos se DERIVAN de lo que ya
 * hace la sincronización: cada vez que escribe una fila de «Facturas (Siigo)»,
 * «Recibos de caja (Siigo)», «Clientes (Siigo)» o «Notas crédito (Siigo)», compara
 * la fila de antes con la de después y de ahí sale «una factura queda pagada».
 * No hay un segundo camino de eventos: es el mismo punto de `emit.ts`, con una
 * regla cuyo disparador se llama distinto para que nadie tenga que saber cómo
 * se llama la tabla ni su campo «estado».
 *
 * Sirve igual para Alegra y QuickBooks: las tablas tienen los mismos campos.
 */

export const ACCOUNTING_EVENTS = [
  'invoice_created',
  'invoice_paid',
  'invoice_overdue',
  'invoice_annulled',
  'receipt_created',
  'credit_note_created',
  'customer_created',
  // 0234
  'purchase_created',
  'supplier_payment_created',
  'stock_low',
  'quotation_created',
] as const;
export type AccountingEventId = (typeof ACCOUNTING_EVENTS)[number];

export const ACCOUNTING_EVENT_LABEL: Record<AccountingEventId, string> = {
  invoice_created: 'Se crea una factura en el programa contable',
  invoice_paid: 'Una factura queda pagada',
  invoice_overdue: 'Una factura se vence',
  invoice_annulled: 'Se anula una factura',
  receipt_created: 'Entra un recibo de caja (pago de un cliente)',
  credit_note_created: 'Se crea una nota crédito',
  customer_created: 'Hay un cliente nuevo en el programa contable',
  purchase_created: 'Entra una compra (factura de proveedor o documento soporte)',
  supplier_payment_created: 'Se registra un pago a un proveedor (egreso)',
  stock_low: 'Un producto queda bajo de existencias en una bodega',
  quotation_created: 'Se crea una cotización',
};

export const ACCOUNTING_EVENT_ENTITY: Record<AccountingEventId, AccountingEntity> = {
  invoice_created: 'invoices',
  invoice_paid: 'invoices',
  invoice_overdue: 'invoices',
  invoice_annulled: 'invoices',
  receipt_created: 'payments',
  credit_note_created: 'credit_notes',
  customer_created: 'customers',
  purchase_created: 'purchases',
  supplier_payment_created: 'supplier_payments',
  stock_low: 'stock',
  quotation_created: 'quotations',
};

/** Con qué tarda en salir cada uno, para decírselo a la persona sin prometer de más. */
export const ACCOUNTING_EVENT_DELAY: Record<AccountingEventId, string> = {
  invoice_created: 'a los pocos minutos de crearse (cada vez que Cortex sincroniza)',
  invoice_paid: 'a los pocos minutos de entrar el recibo de caja; un pago que Siigo no registra como recibo sale en el repaso diario',
  invoice_overdue: 'cuando pasa la fecha de vencimiento, en el repaso diario',
  invoice_annulled: 'a los pocos minutos o, a más tardar, en el repaso diario',
  receipt_created: 'a los pocos minutos de entrar',
  credit_note_created: 'a los pocos minutos de crearse',
  customer_created: 'a los pocos minutos de crearse',
  purchase_created: 'a los pocos minutos de registrarse en el programa (cada vez que Cortex sincroniza)',
  supplier_payment_created: 'a los pocos minutos de registrarse el egreso',
  stock_low: 'cuando cambian las existencias de la bodega: a los pocos minutos si el programa avisa del movimiento, o en la siguiente sincronización',
  quotation_created: 'a los pocos minutos de crearse',
};

export function accountingEventTableSlug(
  provider: AccountingProviderId,
  event: AccountingEventId,
): string {
  return accountingTableSlug(provider, ACCOUNTING_EVENT_ENTITY[event]);
}

/** «siigo_facturas» → { provider: 'siigo', entity: 'invoices' }; otra tabla → null. */
export function accountingSlugParts(
  slug: string | null | undefined,
): { provider: AccountingProviderId; entity: AccountingEntity } | null {
  if (!slug) return null;
  for (const provider of ACCOUNTING_PROVIDER_IDS)
    for (const entity of [
      'invoices',
      'payments',
      'credit_notes',
      'customers',
      'purchases',
      'supplier_payments',
      'quotations',
      'stock',
    ] as const)
      if (accountingTableSlug(provider, entity) === slug) return { provider, entity };
  return null;
}

type Values = Record<string, string | number | undefined> | null | undefined;

const eq = (a: unknown, b: string) =>
  String(a ?? '')
    .trim()
    .toLowerCase() === b.toLowerCase();

/**
 * Los sucesos que una fila escrita por la sincronización representa. Una fila
 * NUEVA nunca «cambió de estado» a partir de nada: nace en su estado, y eso
 * cuenta como llegar a él (una factura de contado nace Pagada). Una fila
 * cambiada sin su «antes» no dice nada: mejor callar que repetir.
 */
export function detectAccountingEvents(
  entity: AccountingEntity,
  kind: 'row_created' | 'row_updated',
  before: Values,
  after: Values,
  options: { threshold?: number } = {},
): AccountingEventId[] {
  const out: AccountingEventId[] = [];
  const created = kind === 'row_created';
  if (!created && !before) return out;
  switch (entity) {
    case 'customers':
      if (created) out.push('customer_created');
      break;
    case 'payments':
      if (created) out.push('receipt_created');
      break;
    case 'credit_notes':
      if (created) out.push('credit_note_created');
      break;
    case 'purchases':
      if (created) out.push('purchase_created');
      break;
    case 'supplier_payments':
      if (created) out.push('supplier_payment_created');
      break;
    case 'quotations':
      if (created) out.push('quotation_created');
      break;
    case 'stock':
      if (stockBecameLow(created, before, after, options.threshold)) out.push('stock_low');
      break;
    case 'invoices': {
      if (created) out.push('invoice_created');
      const reached = (state: string) =>
        eq(after?.estado, state) && (created || !eq(before?.estado, state));
      if (reached('Pagada')) out.push('invoice_paid');
      if (reached('Vencida')) out.push('invoice_overdue');
      if (reached('Anulada')) out.push('invoice_annulled');
      break;
    }
  }
  return out;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const LOW_ALERTS = ['bajo mínimo', 'sin existencias'];

/**
 * «Un producto queda bajo de existencias»: cruza hacia abajo, no repite mientras
 * siga bajo. Con umbral (el de la regla): existencias ≤ umbral. Sin umbral: la
 * alerta de la fila («Bajo mínimo» o «Sin existencias», contra el mínimo del
 * producto). Una fila nueva ya baja cuenta como llegar.
 */
export function stockBecameLow(
  created: boolean,
  before: Values,
  after: Values,
  threshold?: number,
): boolean {
  if (threshold !== undefined) {
    const now = num(after?.existencias);
    if (now === null || now > threshold) return false;
    if (created) return true;
    const was = num(before?.existencias);
    return was === null || was > threshold;
  }
  const low = (v: Values) => LOW_ALERTS.includes(String(v?.alerta ?? '').trim().toLowerCase());
  return low(after) && (created || !low(before));
}

/** Los sucesos de un tipo, para el editor y las instrucciones del chat. */
export function describeAccountingEvent(event: AccountingEventId, providerName: string): string {
  return `${ACCOUNTING_EVENT_LABEL[event]} (${providerName}): ${ACCOUNTING_EVENT_DELAY[event]}.`;
}
