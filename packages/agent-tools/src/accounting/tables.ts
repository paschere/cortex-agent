import type { SystemPaymentRow } from '../payments/import';
import type { TrackerField } from '../trackers/schema';
import type { NormalizedPurchase } from './providers/purchases';
import {
  type AccountingEntity,
  CATALOG_KIND_LABEL,
  type CatalogEntity,
  type NormalizedCatalogItem,
  type NormalizedCreditNote,
  type NormalizedCustomer,
  type NormalizedInvoice,
  type NormalizedJournalLine,
  type NormalizedPayment,
  type NormalizedPayrollCost,
  type NormalizedProduct,
  type NormalizedQuotation,
  type NormalizedRecord,
  type NormalizedStatementLine,
  type NormalizedStockLine,
  type NormalizedSupplierPayment,
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

export const PURCHASE_KINDS = ['Compra', 'Documento soporte'] as const;
export const PURCHASE_STATES = ['Por pagar', 'Vencida', 'Pagada', 'Anulada'] as const;
export const STOCK_STATES = ['Sin existencias', 'Bajo mínimo', 'Con existencias'] as const;

interface BaseSpec {
  slug: string;
  name: string;
  noun: string;
  what: string;
  fields: TrackerField[];
}

/** Un catálogo de referencia: nombre, código y, si aplica, tipo y porcentaje. */
function catalogBase(
  slug: string,
  name: string,
  what: string,
  extra: { kind?: string; percentage?: boolean } = {},
): BaseSpec {
  return {
    slug,
    name,
    noun: name.toLowerCase(),
    what,
    fields: [
      text('nombre', 'Nombre'),
      text('codigo', 'Código'),
      ...(extra.kind ? [text('tipo', extra.kind)] : []),
      ...(extra.percentage ? [number('porcentaje', 'Porcentaje')] : []),
      select('estado', 'Estado', ACTIVE),
    ],
  };
}

const BASE: Record<AccountingEntity, BaseSpec> = {
  customers: {
    slug: 'clientes',
    name: 'Clientes',
    noun: 'clientes',
    what: 'los terceros de la empresa: clientes y proveedores (se filtran por el campo «Relación»)',
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
  credit_notes: {
    slug: 'notas_credito',
    name: 'Notas crédito',
    noun: 'notas crédito',
    what: 'las notas crédito de venta (anulan o rebajan una factura)',
    fields: [
      text('numero', 'Número'),
      text('cliente', 'Cliente'),
      text('nit', 'NIT cliente'),
      date('fecha', 'Fecha'),
      text('factura', 'Factura que afecta'),
      money('valor', 'Valor'),
      text('moneda', 'Moneda'),
      text('observaciones', 'Observaciones'),
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
  purchases: {
    slug: 'compras',
    name: 'Compras',
    noun: 'compras',
    what: 'facturas de compra y documentos soporte (lo que se le debe a proveedores), con su saldo y vencimiento',
    fields: [
      text('numero', 'Número del proveedor'),
      text('documento', 'Documento'),
      select('tipo', 'Tipo', [...PURCHASE_KINDS]),
      text('proveedor', 'Proveedor'),
      text('nit', 'NIT proveedor'),
      date('fecha', 'Fecha'),
      date('vence', 'Vence'),
      money('total', 'Total'),
      money('saldo', 'Saldo por pagar'),
      text('moneda', 'Moneda'),
      select('estado', 'Estado', [...PURCHASE_STATES]),
      text('observaciones', 'Observaciones'),
    ],
  },
  supplier_payments: {
    slug: 'pagos_proveedores',
    name: 'Pagos a proveedores',
    noun: 'pagos a proveedores',
    what: 'los comprobantes de egreso: lo que se le pagó a cada proveedor y qué compras cubre',
    fields: [
      text('numero', 'Número'),
      text('proveedor', 'Proveedor'),
      text('nit', 'NIT proveedor'),
      date('fecha', 'Fecha'),
      money('valor', 'Valor'),
      text('moneda', 'Moneda'),
      text('compras', 'Compras que paga'),
      text('forma_pago', 'Forma de pago'),
      select('estado', 'Estado', ['Registrado', 'Anulado']),
      text('observaciones', 'Observaciones'),
    ],
  },
  journal_lines: {
    slug: 'movimientos_contables',
    name: 'Movimientos contables',
    noun: 'movimientos contables',
    what: 'cada movimiento de los comprobantes contables: cuenta PUC, débito o crédito, tercero y centro de costo (los de nómina van sin tercero)',
    fields: [
      text('comprobante', 'Comprobante'),
      date('fecha', 'Fecha'),
      text('mes', 'Mes (AAAA-MM)'),
      text('cuenta', 'Cuenta PUC'),
      text('nombre_cuenta', 'Nombre de la cuenta'),
      select('movimiento', 'Movimiento', ['Débito', 'Crédito']),
      money('debito', 'Débito'),
      money('credito', 'Crédito'),
      text('nit_tercero', 'NIT del tercero'),
      text('tercero', 'Tercero'),
      text('centro_costo', 'Centro de costo'),
      text('descripcion', 'Descripción'),
    ],
  },
  quotations: {
    slug: 'cotizaciones',
    name: 'Cotizaciones',
    noun: 'cotizaciones',
    what: 'las cotizaciones a clientes, con su valor y vigencia',
    fields: [
      text('numero', 'Número'),
      text('cliente', 'Cliente'),
      text('nit', 'NIT cliente'),
      date('fecha', 'Fecha'),
      date('vigencia', 'Válida hasta'),
      money('total', 'Total'),
      text('moneda', 'Moneda'),
      text('vendedor', 'Vendedor'),
      text('observaciones', 'Observaciones'),
    ],
  },
  stock: {
    slug: 'existencias',
    name: 'Existencias por bodega',
    noun: 'existencias',
    what: 'cuántas unidades de cada producto hay en cada bodega y si están bajo el mínimo',
    fields: [
      text('producto', 'Producto'),
      text('codigo', 'Código'),
      text('bodega', 'Bodega'),
      number('existencias', 'Existencias'),
      number('minimo', 'Mínimo'),
      text('unidad', 'Unidad'),
      select('alerta', 'Alerta', [...STOCK_STATES]),
    ],
  },
  statements: {
    slug: 'estados_financieros',
    name: 'Estados financieros mes a mes',
    noun: 'renglones de estados financieros',
    what: 'estado de resultados y balance general mes a mes, un renglón por mes y rubro contable (del balance de prueba, base causación)',
    fields: [
      text('periodo', 'Mes (AAAA-MM)'),
      date('mes', 'Primer día del mes'),
      select('estado', 'Estado', ['Estado de resultados', 'Balance general']),
      text('seccion', 'Sección'),
      text('codigo', 'Cuenta'),
      text('renglon', 'Renglón'),
      money('valor', 'Valor'),
      select('en_curso', 'Mes en curso', ['Sí', 'No']),
    ],
  },
  payroll_costs: {
    slug: 'costo_nomina',
    name: 'Costo de nómina por mes',
    noun: 'renglones de costo de nómina',
    what: 'costo de personal por mes, área y concepto (totales de la empresa, sin datos de personas)',
    fields: [
      text('periodo', 'Mes (AAAA-MM)'),
      date('mes', 'Primer día del mes'),
      text('area', 'Área'),
      text('grupo', 'Grupo'),
      text('concepto', 'Concepto'),
      money('valor', 'Valor'),
      select('en_curso', 'Mes en curso', ['Sí', 'No']),
    ],
  },
  cost_centers: catalogBase('centros_costo', 'Centros de costo', 'los centros de costo'),
  taxes: catalogBase('impuestos', 'Impuestos y retenciones', 'los impuestos y retenciones', {
    kind: 'Tipo',
    percentage: true,
  }),
  payment_methods: catalogBase('formas_pago', 'Formas de pago', 'las formas de pago', {
    kind: 'Plazo',
  }),
  warehouses: catalogBase('bodegas', 'Bodegas', 'las bodegas'),
  document_types: catalogBase('tipos_documento', 'Tipos de documento', 'los tipos de documento', {
    kind: 'Clase',
  }),
  sellers: catalogBase('vendedores', 'Vendedores', 'los vendedores'),
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
    slug: accountingTableSlug(provider.id, entity),
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
  /** 0234: NIT (sólo dígitos, sin DV) → nombre, para los terceros de los movimientos. */
  nitNames?: Map<string, string>;
  /** 0234: id del centro de costo → nombre (de su catálogo). */
  costCenterNames?: Map<string, string>;
  /** 0234: id del vendedor → nombre (de su catálogo). */
  sellerNames?: Map<string, string>;
  /** 0234: umbral por defecto de «bajo mínimo» cuando el producto no trae mínimo. */
  lowStockDefault?: number;
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

export function creditNoteValues(n: NormalizedCreditNote, ctx: RowContext): Values {
  return compact({
    numero: n.number,
    cliente: nameFor(n, ctx),
    nit: n.customerTaxId,
    fecha: n.date,
    factura: n.invoiceNumber,
    valor: n.total,
    moneda: n.currency,
    observaciones: n.notes,
  });
}


// ---------------------------------------------------------------------------
// 0234: compras, egresos, movimientos, cotizaciones, existencias, estados
// ---------------------------------------------------------------------------

export function purchaseState(
  p: Pick<NormalizedPurchase, 'status' | 'balance' | 'dueDate'>,
  today: string,
): (typeof PURCHASE_STATES)[number] {
  if (p.status === 'annulled') return 'Anulada';
  if (p.status === 'paid' || p.balance <= 0.005) return 'Pagada';
  return p.dueDate && p.dueDate < today ? 'Vencida' : 'Por pagar';
}

export function purchaseValues(p: NormalizedPurchase, ctx: RowContext): Values {
  const supplier =
    p.supplierName ||
    (p.supplierExternalId && ctx.customerNames.get(p.supplierExternalId)) ||
    undefined;
  return compact({
    numero: p.number,
    documento: p.documentNumber,
    tipo: p.kind ?? 'Compra',
    proveedor: supplier,
    nit: p.supplierTaxId?.replace(/\D/g, '') || undefined,
    fecha: p.date,
    vence: p.dueDate ?? undefined,
    total: p.total,
    saldo: p.status === 'annulled' ? 0 : p.balance,
    moneda: p.currency,
    estado: purchaseState(p, ctx.today),
    observaciones: p.notes,
  });
}

export function supplierPaymentValues(p: NormalizedSupplierPayment, ctx: RowContext): Values {
  const purchases = [...new Set(p.applications.map((a) => a.purchaseNumber).filter(Boolean))].join(
    ', ',
  );
  return compact({
    numero: p.number,
    proveedor:
      p.supplierName ||
      (p.supplierExternalId && ctx.customerNames.get(p.supplierExternalId)) ||
      undefined,
    nit: p.supplierTaxId?.replace(/\D/g, '') || undefined,
    fecha: p.date,
    valor: p.amount,
    moneda: p.currency,
    compras: purchases.slice(0, 400),
    forma_pago: p.method,
    estado: p.annulled ? 'Anulado' : 'Registrado',
    observaciones: p.notes,
  });
}

export const CONFIDENTIAL_PARTY_LABEL = 'Nómina (confidencial)';

export function journalLineValues(l: NormalizedJournalLine, ctx: RowContext): Values {
  const debit = l.movement === 'debit';
  const party = l.confidential
    ? CONFIDENTIAL_PARTY_LABEL
    : l.partyName ||
      (l.partyExternalId && ctx.customerNames.get(l.partyExternalId)) ||
      (l.partyTaxId && ctx.nitNames?.get(l.partyTaxId.replace(/\D/g, ''))) ||
      undefined;
  return compact({
    comprobante: l.journalNumber,
    fecha: l.date,
    mes: l.date.slice(0, 7),
    cuenta: l.account,
    nombre_cuenta: l.accountName,
    movimiento: debit ? 'Débito' : 'Crédito',
    debito: debit ? l.value : undefined,
    credito: debit ? undefined : l.value,
    nit_tercero: l.confidential ? undefined : l.partyTaxId,
    tercero: party,
    centro_costo: l.costCenter ? (ctx.costCenterNames?.get(l.costCenter) ?? l.costCenter) : undefined,
    descripcion: l.confidential ? undefined : l.description,
  });
}

export function quotationValues(q: NormalizedQuotation, ctx: RowContext): Values {
  return compact({
    numero: q.number,
    cliente: nameFor(q, ctx),
    nit: q.customerTaxId,
    fecha: q.date,
    vigencia: q.validUntil,
    total: q.total,
    moneda: q.currency,
    vendedor: q.sellerExternalId ? ctx.sellerNames?.get(q.sellerExternalId) : undefined,
    observaciones: q.notes,
  });
}

/** Sin existencias, bajo el mínimo (el del producto, o el de la regla) o con existencias. */
export function stockState(
  quantity: number,
  min: number | undefined,
  fallbackMin = 0,
): (typeof STOCK_STATES)[number] {
  if (quantity <= 0) return 'Sin existencias';
  const floor = min !== undefined && min > 0 ? min : fallbackMin;
  return floor > 0 && quantity <= floor ? 'Bajo mínimo' : 'Con existencias';
}

export function stockValues(s: NormalizedStockLine, ctx: RowContext): Values {
  return compact({
    producto: s.productName,
    codigo: s.productCode,
    bodega: s.warehouseName,
    existencias: s.quantity,
    minimo: s.minStock,
    unidad: s.unit,
    alerta: stockState(s.quantity, s.minStock, ctx.lowStockDefault ?? 0),
  });
}

export function catalogValues(c: NormalizedCatalogItem): Values {
  return compact({
    nombre: c.name,
    codigo: c.code,
    tipo: c.kind,
    porcentaje: c.percentage,
    estado: c.active === false ? 'Inactivo' : 'Activo',
  });
}

export function statementValues(l: NormalizedStatementLine): Values {
  return compact({
    periodo: l.period,
    mes: `${l.period}-01`,
    estado: l.statement,
    seccion: l.section,
    codigo: l.code,
    renglon: l.name,
    valor: l.amount,
    en_curso: l.inProgress ? 'Sí' : 'No',
  });
}

export function payrollCostValues(c: NormalizedPayrollCost): Values {
  return compact({
    periodo: c.period,
    mes: `${c.period}-01`,
    area: c.area,
    grupo: c.group,
    concepto: c.concept,
    valor: c.amount,
    en_curso: c.inProgress ? 'Sí' : 'No',
  });
}

export { CATALOG_KIND_LABEL };
export type { CatalogEntity };

/** El slug de la tabla de una cosa de un programa («siigo_facturas»). */
export function accountingTableSlug(providerId: string, entity: AccountingEntity): string {
  return `${providerId}_${BASE[entity].slug}`.slice(0, 48);
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
    case 'credit_notes':
      return creditNoteValues(record as NormalizedCreditNote, ctx);
    case 'purchases':
      return purchaseValues(record as NormalizedPurchase, ctx);
    case 'supplier_payments':
      return supplierPaymentValues(record as NormalizedSupplierPayment, ctx);
    case 'journal_lines':
      return journalLineValues(record as NormalizedJournalLine, ctx);
    case 'quotations':
      return quotationValues(record as NormalizedQuotation, ctx);
    case 'stock':
      return stockValues(record as NormalizedStockLine, ctx);
    case 'statements':
      return statementValues(record as NormalizedStatementLine);
    case 'payroll_costs':
      return payrollCostValues(record as NormalizedPayrollCost);
    case 'cost_centers':
    case 'taxes':
    case 'payment_methods':
    case 'warehouses':
    case 'document_types':
    case 'sellers':
      return catalogValues(record as NormalizedCatalogItem);
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
