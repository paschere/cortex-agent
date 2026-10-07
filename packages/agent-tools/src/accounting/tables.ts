import type { SystemPaymentRow } from '../payments/import';
import type { TrackerField } from '../trackers/schema';
import type {
  AccountingEntity,
  NormalizedCustomer,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedProduct,
  NormalizedRecord,
} from './types';

/**
 * DE LA FORMA COMÚN A LAS TABLAS DE LA EMPRESA, PURO.
 *
 * Cada cosa que se trae tiene su tabla —«Facturas (Siigo)», «Clientes
 * (Alegra)»— con los mismos campos sea cual sea el programa: una vista armada
 * sobre las facturas de Siigo sirve igual el día que la empresa se pasa a
 * Alegra. El slug lleva el programa adelante (`siigo_facturas`) para que dos
 * programas conectados a la vez no se pisen.
 *
 * Nada de este archivo habla con un programa ni con la base.
 */

export interface AccountingTableSpec {
  entity: AccountingEntity;
  slug: string;
  name: string;
  description: string;
  /** Plural en español, para frases: «12 facturas nuevas». */
  noun: string;
  fields: TrackerField[];
}

const text = (key: string, label: string): TrackerField => ({
  key,
  label,
  type: 'text',
  required: false,
});
const date = (key: string, label: string): TrackerField => ({
  key,
  label,
  type: 'date',
  required: false,
});
const money = (key: string, label: string): TrackerField => ({
  key,
  label,
  type: 'money',
  required: false,
});
const number = (key: string, label: string): TrackerField => ({
  key,
  label,
  type: 'number',
  required: false,
});
const select = (key: string, label: string, options: string[]): TrackerField => ({
  key,
  label,
  type: 'select',
  required: false,
  options,
});

const ACTIVE = ['Activo', 'Inactivo'];
export const INVOICE_STATES = ['Por cobrar', 'Vencida', 'Pagada', 'Anulada'] as const;
const PAYMENT_KINDS = ['Abono a factura', 'Anticipo', 'Detallado', 'Otro'];
const EINVOICE_STATES = ['Aceptada', 'Rechazada', 'Pendiente', 'Sin enviar', 'Otro'];

const BASE: Record<
  AccountingEntity,
  { slug: string; name: string; noun: string; what: string; fields: TrackerField[] }
> = {
  customers: {
    slug: 'clientes',
    name: 'Clientes',
    noun: 'clientes',
    what: 'los clientes (terceros) de la empresa',
    fields: [
      text('nombre', 'Nombre'),
      text('nit', 'NIT / Documento'),
      select('relacion', 'Relación', ['Cliente', 'Proveedor', 'Otro']),
      select('tipo', 'Tipo', ['Empresa', 'Persona']),
      text('ciudad', 'Ciudad'),
      text('direccion', 'Dirección'),
      text('telefono', 'Teléfono'),
      text('correo', 'Correo'),
      select('estado', 'Estado', ACTIVE),
      date('creado', 'Creado'),
    ],
  },
  products: {
    slug: 'productos',
    name: 'Productos',
    noun: 'productos',
    what: 'productos y servicios, con precio y existencias',
    fields: [
      text('nombre', 'Nombre'),
      text('codigo', 'Código'),
      select('tipo', 'Tipo', ['Producto', 'Servicio', 'Combo']),
      text('grupo', 'Grupo'),
      money('precio', 'Precio de venta'),
      number('existencias', 'Existencias'),
      text('unidad', 'Unidad'),
      text('referencia', 'Referencia'),
      select('estado', 'Estado', ACTIVE),
    ],
  },
  invoices: {
    slug: 'facturas',
    name: 'Facturas',
    noun: 'facturas',
    what: 'facturas de venta con su saldo y vencimiento; las que tienen saldo entran a la cartera',
    fields: [
      text('numero', 'Número'),
      text('cliente', 'Cliente'),
      text('nit', 'NIT cliente'),
      date('fecha', 'Fecha'),
      date('vence', 'Vence'),
      money('total', 'Total'),
      money('saldo', 'Saldo'),
      text('moneda', 'Moneda'),
      select('estado', 'Estado', [...INVOICE_STATES]),
      select('factura_electronica', 'Factura electrónica', EINVOICE_STATES),
      text('observaciones', 'Observaciones'),
      text('enlace', 'Ver en el programa'),
    ],
  },
  payments: {
    slug: 'pagos',
    name: 'Pagos recibidos',
    noun: 'pagos',
    what: 'los pagos de clientes y a qué facturas abonan',
    fields: [
      text('numero', 'Número'),
      text('cliente', 'Cliente'),
      text('nit', 'NIT cliente'),
      date('fecha', 'Fecha'),
      select('tipo', 'Tipo', PAYMENT_KINDS),
      money('valor', 'Valor'),
      text('moneda', 'Moneda'),
      text('facturas', 'Facturas que paga'),
      text('forma_pago', 'Forma de pago'),
      text('observaciones', 'Observaciones'),
    ],
  },
};

/**
 * La tabla de una cosa de un programa. `paymentsLabel` deja que cada programa
 * diga cómo llama a sus pagos («Recibos de caja» en Siigo).
 */
export function accountingTableSpec(
  provider: { id: string; name: string; paymentsLabel?: string },
  entity: AccountingEntity,
): AccountingTableSpec {
  const base = BASE[entity];
  const label =
    entity === 'payments' && provider.paymentsLabel ? provider.paymentsLabel : base.name;
  return {
    entity,
    slug: `${provider.id}_${base.slug}`.slice(0, 48),
    name: `${label} (${provider.name})`.slice(0, 80),
    description: `Se llena sola desde ${provider.name}: ${base.what}.`.slice(0, 500),
    noun: base.noun,
    fields: base.fields.map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) })),
  };
}

// ---------------------------------------------------------------------------
// Forma común → fila
// ---------------------------------------------------------------------------

type Values = Record<string, string | number>;

function compact(values: Record<string, string | number | undefined | null>): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(values))
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

export interface RowContext {
  /** Hoy en Bogotá, AAAA-MM-DD: decide «Vencida». */
  today: string;
  /** id del cliente en el programa → nombre (de la tabla de clientes). */
  customerNames: Map<string, string>;
}

export function invoiceState(
  inv: NormalizedInvoice,
  today: string,
): (typeof INVOICE_STATES)[number] {
  if (inv.status === 'annulled') return 'Anulada';
  if (inv.status === 'paid' || inv.balance <= 0.005) return 'Pagada';
  return inv.dueDate && inv.dueDate < today ? 'Vencida' : 'Por cobrar';
}

function nameFor(
  record: { customerName?: string; customerExternalId?: string },
  ctx: RowContext,
): string | undefined {
  return (
    record.customerName ||
    (record.customerExternalId && ctx.customerNames.get(record.customerExternalId)) ||
    undefined
  );
}

export function customerValues(c: NormalizedCustomer): Values {
  return compact({
    nombre: c.name,
    nit: c.taxIdDisplay ?? c.taxId,
    relacion: c.relationship,
    tipo: c.kind,
    ciudad: c.city,
    direccion: c.address,
    telefono: c.phone,
    correo: c.email,
    estado: c.active === false ? 'Inactivo' : 'Activo',
    creado: c.createdOn,
  });
}

export function productValues(p: NormalizedProduct): Values {
  return compact({
    nombre: p.name,
    codigo: p.code,
    tipo: p.kind,
    grupo: p.group,
    precio: p.price,
    existencias: p.stock,
    unidad: p.unit,
    referencia: p.reference,
    estado: p.active === false ? 'Inactivo' : 'Activo',
  });
}

export function invoiceValues(inv: NormalizedInvoice, ctx: RowContext): Values {
  return compact({
    numero: inv.number,
    cliente: nameFor(inv, ctx),
    nit: inv.customerTaxId,
    fecha: inv.date,
    vence: inv.dueDate,
    total: inv.total,
    saldo: inv.balance,
    moneda: inv.currency,
    estado: invoiceState(inv, ctx.today),
    factura_electronica: inv.einvoiceStatus,
    observaciones: inv.notes,
    // Un enlace cortado no abre nada: si no cabe, no se guarda.
    enlace: inv.url && inv.url.length <= 400 ? inv.url : undefined,
  });
}

export function paymentValues(p: NormalizedPayment, ctx: RowContext): Values {
  const invoices = [...new Set(p.applications.map((a) => a.invoiceNumber).filter(Boolean))].join(
    ', ',
  );
  return compact({
    numero: p.number,
    cliente: nameFor(p, ctx),
    nit: p.customerTaxId,
    fecha: p.date,
    tipo: p.kind,
    valor: p.amount,
    moneda: p.currency,
    facturas: invoices.slice(0, 400),
    forma_pago: p.method,
    observaciones: p.notes,
  });
}

export function valuesFor(
  entity: AccountingEntity,
  record: NormalizedRecord,
  ctx: RowContext,
): Values {
  switch (entity) {
    case 'customers':
      return customerValues(record as NormalizedCustomer);
    case 'products':
      return productValues(record as NormalizedProduct);
    case 'invoices':
      return invoiceValues(record as NormalizedInvoice, ctx);
    case 'payments':
      return paymentValues(record as NormalizedPayment, ctx);
  }
}

// ---------------------------------------------------------------------------
// Factura → cartera; pago → Pagos
// ---------------------------------------------------------------------------

export interface AccountingInvoiceInput {
  source_system: string;
  source_ref: string;
  doc_number: string;
  client_nit: string | null;
  client_id: string | null;
  counterparty_name: string | null;
  currency: string;
  total: number;
  balance: number;
  issued_on: string;
  due_on: string | null;
  annulled: boolean;
  public_url: string | null;
  synced_at: string;
  updated_at: string;
}

/** La factura como la ve la cartera (`accounting_invoices`). */
export function receivableFor(
  provider: string,
  inv: NormalizedInvoice,
  ctx: RowContext & { clientIdByNit: Map<string, string>; now: string },
): AccountingInvoiceInput {
  const nit = inv.customerTaxId?.replace(/\D/g, '').slice(0, 20) || null;
  return {
    source_system: provider,
    source_ref: inv.externalId.slice(0, 200),
    doc_number: inv.number.slice(0, 120),
    client_nit: nit,
    client_id: (nit && ctx.clientIdByNit.get(nit)) || null,
    counterparty_name: nameFor(inv, ctx)?.slice(0, 200) ?? null,
    currency: inv.currency,
    total: inv.total,
    balance: inv.status === 'annulled' ? 0 : inv.balance,
    issued_on: inv.date,
    due_on: inv.dueDate ?? null,
    annulled: inv.status === 'annulled',
    public_url: inv.url?.slice(0, 1000) ?? null,
    synced_at: ctx.now,
    updated_at: ctx.now,
  };
}

/**
 * Un pago del programa como filas del importador de sistema
 * (payments/import.ts): una por factura a la que abona, con su referencia
 * estable. Reimportar no duplica (`payment_reports_source_once_idx`).
 */
export function paymentRowsFor(p: NormalizedPayment, providerName: string): SystemPaymentRow[] {
  return p.applications
    .filter((a) => a.amount > 0 && a.ref)
    .map((a) => ({
      sourceRef: a.ref.slice(0, 200),
      amount: a.amount,
      currency: p.currency,
      paidOn: p.date,
      clientNit: p.customerTaxId ?? null,
      invoiceNumber: a.invoiceNumber,
      reference: p.number ?? null,
      note: a.invoiceNumber
        ? `Pago traído de ${providerName}.`
        : `Pago traído de ${providerName} (sin factura asociada).`,
    }));
}
