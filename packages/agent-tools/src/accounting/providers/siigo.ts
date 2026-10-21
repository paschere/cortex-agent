import { normalizeNit } from '../../clients/shape';
import { siigoWriter } from '../../close/writeback/siigo';
import { siigoPayrollPage } from '../payroll-provider';
import type {
  AccountingEntity,
  AccountingProvider,
  CatalogEntity,
  NormalizedCreditNote,
  NormalizedCustomer,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedProduct,
  NormalizedRecord,
  ProviderQuery,
  ProviderRuntime,
  ProviderSession,
  QueryPlanInput,
} from '../types';
import { CATALOG_ENTITIES } from '../types';
import { siigoLive } from '../live/siigo-live';
import { siigoInvoicing } from './invoicing';
import { siigoOutbound } from './outbound';
import { type NormalizedPurchase, normalizeSiigoPurchase, siigoPurchasePage } from './purchases';
import { siigoReports } from './reports-siigo';
import {
  normalizeSiigoAccountPayable,
  siigoDocuments,
  stampInfo,
} from './siigo-more';
import {
  CATALOG_PATH,
  DOCUMENT_TYPE_CLASSES,
  PAYMENT_TYPE_CLASSES,
  catalogRows,
  isEgressName,
  normalizeSiigoCatalogItem,
  normalizeSiigoJournalLines,
  normalizeSiigoQuotation,
  normalizeSiigoSupplierPayment,
} from './siigo-extra';
import { SiigoClient, SiigoError, hasMorePages, siigoPartnerId } from './siigo-client';
import { SIIGO_WEBHOOK_TOPICS } from '../webhook';

/**
 * SIIGO NUBE (Colombia), el primer programa contable conectado.
 *
 * Todo lo que es de Siigo vive aquí y en `siigo-client.ts`: rutas, filtros,
 * nombres de campos, y cómo se traduce cada registro a la forma común
 * (`../types.ts`). Los registros de ejemplo de los tests están copiados de la
 * documentación oficial (siigoapi.docs.apiary.io).
 *
 *   clientes  → GET /v1/customers   (created_start, updated_start)
 *   productos → GET /v1/products    (created_start, updated_start)
 *   facturas  → GET /v1/invoices    (date_start, created_start, updated_start)
 *   pagos     → GET /v1/vouchers    (recibos de caja; created_start, updated_start)
 *
 * Fechas: «yyyy-MM-dd» o, en UTC, «yyyy-MM-ddTHH:mm:ssZ».
 *
 * LA MONEDA. Un documento de Siigo sin `currency` está en la moneda de la
 * empresa en Siigo Nube Colombia, que es el peso: así lo define el sistema, no
 * es una suposición sobre un importe sin unidad. Una factura en dólares trae
 * `currency.code = 'USD'` y se queda en dólares.
 */

const LOCAL_CURRENCY = 'COP';
/** El repaso diario mira las facturas de los últimos seis meses. */
const SWEEP_MONTHS = 6;

/** Las cosas que se piden al programa en su propio listado (el resto se arma de otras lecturas). */
const PATHS: Partial<Record<AccountingEntity, string>> = {
  customers: '/v1/customers',
  products: '/v1/products',
  invoices: '/v1/invoices',
  payments: '/v1/vouchers',
  credit_notes: '/v1/credit-notes',
  purchases: '/v1/purchases',
  supplier_payments: '/v1/payment-receipts',
  quotations: '/v1/quotations',
  journal_lines: '/v1/journals',
  accounts_payable: '/v1/accounts-payable',
};

// ---------------------------------------------------------------------------
// Los registros de Siigo (sólo lo que se usa; todo opcional, Siigo omite)
// ---------------------------------------------------------------------------

interface Metadata {
  created?: string | null;
  last_updated?: string | null;
}

export interface SiigoCustomer {
  id: string;
  type?: 'Customer' | 'Supplier' | 'Other';
  person_type?: string;
  identification?: string;
  check_digit?: string;
  name?: string[] | string;
  commercial_name?: string;
  active?: boolean;
  address?: { address?: string; city?: { city_name?: string; state_name?: string } };
  phones?: Array<{ indicative?: string; number?: string; extension?: string }>;
  contacts?: Array<{ first_name?: string; last_name?: string; email?: string }>;
  metadata?: Metadata;
}

export interface SiigoProduct {
  id: string;
  code?: string;
  name?: string;
  type?: string;
  active?: boolean;
  account_group?: { id?: number; name?: string };
  prices?: Array<{
    currency_code?: string;
    price_list?: Array<{ position?: number; name?: string; value?: number }>;
  }>;
  unit?: { code?: string; name?: string };
  unit_label?: string;
  reference?: string;
  available_quantity?: number;
  /** Si el producto controla inventario en Siigo. */
  stock_control?: boolean;
  /** Existencias por bodega (0183). */
  warehouses?: Array<{ id?: number | string; name?: string; quantity?: number }>;
  metadata?: Metadata;
}

export interface SiigoInvoice {
  id: string;
  name?: string;
  number?: number;
  date?: string;
  customer?: { id?: string; identification?: string; branch_office?: number };
  currency?: { code?: string; exchange_rate?: number } | null;
  total?: number;
  balance?: number;
  annulled?: boolean;
  observations?: string;
  payments?: Array<{ id?: number; name?: string; value?: number; due_date?: string }>;
  stamp?: { status?: string; cufe?: string; cude?: string; observations?: string; errors?: unknown } | null;
  public_url?: string;
  metadata?: Metadata;
}

export interface SiigoVoucher {
  id: string;
  name?: string;
  number?: number;
  date?: string;
  type?: string;
  customer?: { id?: string; identification?: string; branch_office?: number };
  currency?: { code?: string } | null;
  items?: Array<{
    due?: { prefix?: string; consecutive?: number; quote?: number };
    value?: number;
  }>;
  payment?: { id?: number; name?: string; value?: number } | null;
  observations?: string;
  metadata?: Metadata;
}

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

function clip(value: unknown, max = 400): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

function day(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

function amount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
}

function currencyOf(doc: { currency?: { code?: string } | null }): string {
  const code = doc.currency?.code?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : LOCAL_CURRENCY;
}

function monthsAgo(now: Date, months: number): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** «2026-10-01T12:00:00.123Z» → «2026-10-01T12:00:00Z», la forma que pide Siigo. */
export function siigoDateTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------
// Siigo → forma común
// ---------------------------------------------------------------------------

export function siigoCustomerName(
  c: Pick<SiigoCustomer, 'name' | 'commercial_name'>,
): string | undefined {
  const raw = Array.isArray(c.name) ? c.name.filter(Boolean).join(' ') : c.name;
  return clip(raw, 200) ?? clip(c.commercial_name, 200);
}

export function normalizeSiigoCustomer(c: SiigoCustomer): NormalizedCustomer {
  const id = clip(c.identification, 40);
  const phone = c.phones?.find((p) => p.number);
  const contact = c.contacts?.find((x) => x.email);
  const city = c.address?.city;
  return {
    externalId: String(c.id),
    name: siigoCustomerName(c),
    relationship: c.type === 'Supplier' ? 'Proveedor' : c.type === 'Other' ? 'Otro' : 'Cliente',
    taxId: normalizeNit(c.identification) || undefined,
    taxIdDisplay: id ? (c.check_digit ? `${id}-${c.check_digit}` : id) : undefined,
    kind:
      c.person_type === 'Company' ? 'Empresa' : c.person_type === 'Person' ? 'Persona' : undefined,
    city: clip([city?.city_name, city?.state_name].filter(Boolean).join(', '), 120),
    address: clip(c.address?.address, 200),
    phone: clip(
      phone ? [phone.indicative ? `+${phone.indicative}` : '', phone.number].join(' ') : undefined,
      40,
    ),
    email: clip(contact?.email, 200),
    active: c.active !== false,
    createdOn: day(c.metadata?.created),
  };
}

/** Una lista vacía es «no lo dijo» (0183). */
function nonEmpty<T>(list: T[]): T[] | undefined {
  return list.length ? list : undefined;
}

export function normalizeSiigoProduct(p: SiigoProduct): NormalizedProduct {
  const firstPrice = p.prices?.[0]?.price_list?.find((x) => typeof x.value === 'number');
  return {
    externalId: String(p.id),
    name: clip(p.name, 200),
    code: clip(p.code, 60),
    kind:
      p.type === 'Service'
        ? 'Servicio'
        : p.type === 'Combo'
          ? 'Combo'
          : p.type
            ? 'Producto'
            : undefined,
    group: clip(p.account_group?.name, 120),
    price: amount(firstPrice?.value),
    stock: p.stock_control === false ? undefined : amount(p.available_quantity),
    unit: clip(p.unit_label ?? p.unit?.name, 60),
    reference: clip(p.reference, 120),
    active: p.active !== false,
    warehouses:
      p.stock_control === false
        ? undefined
        : nonEmpty(
            (p.warehouses ?? [])
              .filter((w) => w.id !== undefined && amount(w.quantity) !== undefined)
              .map((w) => ({
                externalId: String(w.id),
                name: clip(w.name, 100) ?? 'Bodega',
                quantity: amount(w.quantity) as number,
              })),
          ),
    priceLists: nonEmpty(
      (p.prices ?? []).flatMap((pr) =>
        (pr.price_list ?? [])
          .filter((l) => typeof l.position === 'number' && amount(l.value) !== undefined)
          .map((l) => ({
            position: l.position as number,
            name: clip(l.name, 100),
            currency: currencyOf({ currency: { code: pr.currency_code } }),
            value: amount(l.value) as number,
          })),
      ),
    ),
  };
}

/** El vencimiento: la última cuota con fecha; sin cuotas a crédito, la fecha de la factura. */
function invoiceDueOn(inv: SiigoInvoice): string | undefined {
  const dues = (inv.payments ?? [])
    .map((p) => day(p.due_date))
    .filter((d): d is string => Boolean(d))
    .sort();
  return dues[dues.length - 1] ?? day(inv.date);
}

function einvoiceStatus(status: string | undefined): NormalizedInvoice['einvoiceStatus'] {
  if (!status) return undefined;
  const s = status.toLowerCase();
  if (s === 'accepted') return 'Aceptada';
  if (s === 'rejected') return 'Rechazada';
  if (s === 'pending' || s === 'sent' || s === 'inprocess') return 'Pendiente';
  if (s === 'draft' || s === 'notsent' || s === 'unsent') return 'Sin enviar';
  return 'Otro';
}

/**
 * Una factura de Siigo en la forma común. `null` si le falta lo que hace falta
 * para contarla (id, número, fecha o total): mejor fuera que a medias.
 */
export function normalizeSiigoInvoice(inv: SiigoInvoice): NormalizedInvoice | null {
  const number = clip(inv.name ?? inv.number, 120);
  const date = day(inv.date);
  const total = amount(inv.total);
  if (!inv.id || !number || !date || total === undefined || total < 0) return null;
  const rawBalance = inv.annulled ? 0 : (amount(inv.balance) ?? 0);
  const balance = Math.min(Math.max(rawBalance, 0), total);
  const url = clip(inv.public_url, 1000);
  const stamp = stampInfo(inv.stamp);
  return {
    externalId: String(inv.id),
    number,
    date,
    dueDate: invoiceDueOn(inv),
    customerExternalId: inv.customer?.id ?? undefined,
    customerTaxId: normalizeNit(inv.customer?.identification) || undefined,
    total,
    balance,
    currency: currencyOf(inv),
    status: inv.annulled ? 'annulled' : balance <= 0.005 ? 'paid' : 'open',
    einvoiceStatus: stamp.status ?? einvoiceStatus(inv.stamp?.status ?? undefined),
    cufe: stamp.cufe,
    dianMessage: stamp.status === 'Aceptada' ? undefined : stamp.message,
    notes: clip(inv.observations, 400),
    url,
  };
}

/** «FV-1-68»: el mismo nombre que Siigo le da a la factura (`name`). */
export function siigoDueName(due: { prefix?: string; consecutive?: number } | undefined) {
  if (!due?.prefix || due.consecutive === undefined || due.consecutive === null) return null;
  return `${due.prefix}-${due.consecutive}`;
}

function voucherKind(type: string | undefined): NormalizedPayment['kind'] {
  if (!type) return undefined;
  if (type === 'DebtPayment') return 'Abono a factura';
  if (type === 'AdvancePayment') return 'Anticipo';
  if (type === 'Detailed') return 'Detallado';
  return 'Otro';
}

/**
 * Un recibo de caja en la forma común. Un abono a varias facturas son varias
 * líneas, cada una con su factura, para que Pagos sepa a qué iba. En un recibo
 * «Detallado» las líneas son movimientos contables (débito y crédito por el
 * mismo valor): no abonan a facturas y sumarlas daría el doble, así que ahí
 * cuenta sólo el valor del pago.
 */
export function normalizeSiigoVoucher(v: SiigoVoucher): NormalizedPayment | null {
  const date = day(v.date);
  if (!v.id || !date) return null;
  const lines = (v.items ?? [])
    .map((item, i) => ({ item, i, value: amount(item.value) }))
    .filter(
      (l): l is { item: (typeof l)['item']; i: number; value: number } =>
        Boolean(l.item.due) && l.value !== undefined && l.value > 0,
    );
  const linesTotal = lines.reduce((sum, l) => sum + l.value, 0);
  const total = amount(v.payment?.value) ?? (lines.length ? amount(linesTotal) : undefined);
  if (total === undefined || total <= 0) return null;
  return {
    externalId: String(v.id),
    number: clip(v.name ?? v.number, 120),
    date,
    customerExternalId: v.customer?.id ?? undefined,
    customerTaxId: normalizeNit(v.customer?.identification) || undefined,
    amount: total,
    currency: currencyOf(v),
    kind: voucherKind(v.type),
    method: clip(v.payment?.name, 120),
    notes: clip(v.observations, 400),
    applications: lines.length
      ? lines.map((l) => ({
          ref: `${v.id}:${l.i}`,
          invoiceNumber: siigoDueName(l.item.due),
          amount: l.value,
        }))
      : [{ ref: String(v.id), invoiceNumber: null, amount: total }],
  };
}

export interface SiigoCreditNote {
  id: string;
  name?: string;
  number?: number;
  date?: string;
  invoice?: { id?: string; name?: string } | null;
  customer?: { id?: string; identification?: string };
  currency?: { code?: string } | null;
  total?: number;
  observations?: string;
  stamp?: SiigoInvoice['stamp'];
  metadata?: Metadata;
}

/** Una nota crédito de Siigo (0232). `null` si le falta id, número, fecha o total. */
export function normalizeSiigoCreditNote(n: SiigoCreditNote): NormalizedCreditNote | null {
  const number = clip(n.name ?? n.number, 120);
  const date = day(n.date);
  const total = amount(n.total);
  if (!n.id || !number || !date || total === undefined || total < 0) return null;
  const creditStamp = stampInfo(n.stamp);
  return {
    externalId: String(n.id),
    number,
    date,
    customerExternalId: n.customer?.id ?? undefined,
    customerTaxId: normalizeNit(n.customer?.identification) || undefined,
    invoiceNumber: clip(n.invoice?.name, 120),
    total,
    currency: currencyOf(n),
    einvoiceStatus: creditStamp.status,
    cufe: creditStamp.cufe,
    dianMessage: creditStamp.status === 'Aceptada' ? undefined : creditStamp.message,
    notes: clip(n.observations, 400),
  };
}

function normalize(entity: AccountingEntity, record: unknown): NormalizedRecord[] {
  const one = (r: NormalizedRecord | null): NormalizedRecord[] => (r ? [r] : []);
  switch (entity) {
    case 'customers':
      return one(normalizeSiigoCustomer(record as SiigoCustomer));
    case 'products':
      return one(normalizeSiigoProduct(record as SiigoProduct));
    case 'invoices':
      return one(normalizeSiigoInvoice(record as SiigoInvoice));
    case 'payments':
      return one(normalizeSiigoVoucher(record as SiigoVoucher));
    case 'credit_notes':
      return one(normalizeSiigoCreditNote(record as SiigoCreditNote));
    case 'purchases':
      return one(normalizeSiigoPurchase(record as Record<string, unknown>));
    case 'supplier_payments':
      return one(normalizeSiigoSupplierPayment(record as Record<string, unknown>));
    case 'quotations':
      return one(normalizeSiigoQuotation(record as Record<string, unknown>));
    case 'journal_lines':
      return normalizeSiigoJournalLines(record as Record<string, unknown>);
    case 'accounts_payable':
      return one(normalizeSiigoAccountPayable(record as Record<string, unknown>));
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// El programa
// ---------------------------------------------------------------------------

/** Cuánta historia de movimientos contables trae la primera carga (el volumen sube rápido). */
export const JOURNAL_HISTORY_MONTHS = 12;

/** Los meses de la ventana de movimientos, de AAAA-MM-01 a fin de mes (UTC). */
export function journalWindows(now: Date, months = JOURNAL_HISTORY_MONTHS): ProviderQuery[] {
  const out: ProviderQuery[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    out.push({
      date_start: start.toISOString().slice(0, 10),
      date_end: end.toISOString().slice(0, 10),
    });
  }
  return out;
}

/** Catálogos: una consulta, o una por clase de documento cuando Siigo lo exige. */
function catalogQueries(entity: AccountingEntity): ProviderQuery[] {
  if (entity === 'payment_methods') return PAYMENT_TYPE_CLASSES.map((c) => ({ document_type: c }));
  if (entity === 'document_types') return DOCUMENT_TYPE_CLASSES.map((c) => ({ type: c }));
  return [{}];
}

export function siigoQueries(entity: AccountingEntity, input: QueryPlanInput): ProviderQuery[] {
  if ((CATALOG_ENTITIES as readonly string[]).includes(entity)) return catalogQueries(entity);
  if (entity === 'journal_lines') {
    if (input.mode === 'incremental' && input.since) {
      const since = siigoDateTime(input.since);
      return [{ created_start: since }, { updated_start: since }];
    }
    return journalWindows(input.now);
  }
  if (
    entity === 'stock' ||
    entity === 'statements' ||
    entity === 'payroll_costs' ||
    entity === 'party_balances' ||
    entity === 'product_prices'
  )
    return [];
  // Reporte oficial de cuentas por pagar: siempre completo (un vencimiento
  // saldado desaparece del reporte, no se «modifica»).
  if (entity === 'accounts_payable') return [{}];
  if (entity === 'customers' || entity === 'products') {
    // Siigo defaults to active Customers. Enumerate every third-party kind
    // and activity state; products default to active Products without stock
    // control, so services and stocked items need explicit filters too.
    const scopes =
      entity === 'customers'
        ? ['Customer', 'Supplier', 'Other'].flatMap((type) =>
            ['true', 'false'].map((active) => ({ type, active })),
          )
        : ['Product', 'Service', 'Consumer Good'].flatMap((type) =>
            ['true', 'false'].flatMap((active) =>
              ['true', 'false'].map((stock_control) => ({ type, active, stock_control })),
            ),
          );
    if (input.mode === 'incremental' && input.since) {
      const since = siigoDateTime(input.since);
      return scopes.flatMap((scope) => [
        { ...scope, created_start: since },
        { ...scope, updated_start: since },
      ]);
    }
    return scopes;
  }
  if (input.mode === 'incremental' && input.since) {
    const since = siigoDateTime(input.since);
    // Lo nuevo y lo cambiado son dos listados: un registro recién creado puede
    // traer `last_updated` vacío y no salir en el filtro de modificados.
    // Los recibos de caja: `created_start`/`updated_start` no los trajeron
    // (2026-10-19: Siigo tenía 11 y la tabla 4, cada corrida «+0»). Además se
    // pide siempre una ventana por fecha del documento, que es el filtro con
    // el que `accounting.query` sí los ve; son pocas páginas.
    if (entity === 'payments' || entity === 'supplier_payments')
      return [
        { created_start: since },
        { updated_start: since },
        { date_start: monthsAgo(input.now, 3) },
      ];
    return [{ created_start: since }, { updated_start: since }];
  }
  // The first load has no date cutoff. The sync engine paginates and resumes
  // across runs, so an old unpaid invoice or its receipt cannot be omitted.
  if (entity === 'credit_notes' && input.mode === 'sweep')
    return [{ created_start: monthsAgo(input.now, SWEEP_MONTHS) }];
  // Compras y egresos: un pago baja el saldo de la compra sin «modificarla».
  if (entity === 'purchases' && input.mode === 'sweep')
    return [{ date_start: monthsAgo(input.now, SWEEP_MONTHS) }];
  if (
    (entity === 'invoices' || entity === 'payments' || entity === 'supplier_payments') &&
    input.mode === 'sweep'
  )
    return [
      { date_start: monthsAgo(input.now, entity === 'invoices' ? SWEEP_MONTHS : 12) },
    ];
  return [{}];
}

/**
 * Filtros que se sueltan, en este orden, cuando Siigo responde
 * `parameters_exclusive` (400): no documenta qué combinaciones de `type`,
 * `active` y `stock_control` acepta juntas, y un solo 400 detenía la carga de
 * productos y con ella las de facturas y recibos (2026-10-07). Soltar un
 * filtro trae MÁS registros, nunca menos; los repetidos entre consultas no
 * importan porque cada registro se identifica por su id de Siigo. El orden es
 * fijo, así que cada página de la misma consulta pide lo mismo.
 */
const RELAXABLE = ['stock_control', 'type', 'active'] as const;

export async function pageRelaxing(
  client: Pick<SiigoClient, 'page'>,
  path: string,
  query: Parameters<SiigoClient['page']>[1],
  page: number,
): Promise<Awaited<ReturnType<SiigoClient['page']>>> {
  let current: Record<string, unknown> = { ...query };
  for (;;) {
    try {
      return await client.page<unknown>(path, current as typeof query, page);
    } catch (err) {
      const drop = RELAXABLE.find((k) => current[k] !== undefined);
      if (!(err instanceof SiigoError) || err.code !== 'parameters_exclusive' || !drop) throw err;
      const { [drop]: _dropped, ...rest } = current;
      current = rest;
    }
  }
}

export const siigoProvider: AccountingProvider = {
  id: 'siigo',
  name: 'Siigo',
  credentialsHelp:
    'En Siigo Nube: menú Alianzas → «Mi credencial API». Copia el usuario API y la access key.',
  credentialFields: [
    { key: 'username', label: 'Usuario API', secret: false, placeholder: 'usuario@empresa.com' },
    { key: 'access_key', label: 'Access key', secret: true, placeholder: 'Pega la access key' },
  ],
  accountLabelField: 'username',
  entities: [
    'customers',
    'products',
    'invoices',
    'payments',
    'credit_notes',
    'purchases',
    'supplier_payments',
    'journal_lines',
    'quotations',
    'stock',
    'statements',
    'payroll_costs',
    'cost_centers',
    'taxes',
    'payment_methods',
    'warehouses',
    'document_types',
    'sellers',
    'accounts_payable',
    'party_balances',
    'product_prices',
    'fixed_assets',
    'price_lists',
    'account_groups',
    'expense_concepts',
    'cities',
  ],
  options: ['payroll'],
  paymentsLabel: 'Recibos de caja',
  queries: siigoQueries,
  open(credentials, runtime: ProviderRuntime = {}): ProviderSession {
    const client = new SiigoClient({
      username: credentials.username ?? '',
      accessKey: credentials.access_key ?? '',
      fetch: runtime.fetch,
      sleep: runtime.sleep,
      now: runtime.now,
      tokenStore: runtime.tokenStore,
      minIntervalMs: runtime.minIntervalMs,
    });
    return {
      get requests() {
        return client.requests;
      },
      verify: () => client.verify(),
      invoicing: siigoInvoicing(client),
      outbound: siigoOutbound(client),
      listPurchases: (since, page) => siigoPurchasePage(client, since, page),
      listPayroll: (since, page) => siigoPayrollPage(client, since, page),
      reports: siigoReports(client, { fetch: runtime.fetch }),
      documents: siigoDocuments(client),
      live: (req) => siigoLive(client, req),
      writer: siigoWriter(client),
      webhooks: {
        async subscribe(url) {
          const topics: string[] = [];
          const failed: string[] = [];
          for (const topic of SIIGO_WEBHOOK_TOPICS) {
            try {
              await client.post('/v1/webhooks', { application_id: siigoPartnerId(), topic, url }, {
                noun: 'el aviso de Siigo',
              });
              topics.push(topic);
            } catch {
              failed.push(topic);
            }
          }
          return { topics, failed };
        },
      },
      async refreshInvoices(numbers) {
        const out: NormalizedInvoice[] = [];
        for (const name of [...new Set(numbers)].slice(0, 25)) {
          const result = await client.page<unknown>(PATHS.invoices as string, { name }, 1, 5);
          for (const r of result.results) {
            const inv = normalizeSiigoInvoice(r as SiigoInvoice);
            if (inv) out.push(inv);
          }
        }
        return out;
      },
      async refreshPurchases(numbers) {
        const out: NormalizedPurchase[] = [];
        for (const name of [...new Set(numbers)].slice(0, 25)) {
          const result = await client.page<unknown>(PATHS.purchases as string, { name }, 1, 5);
          for (const r of result.results) {
            const p = normalizeSiigoPurchase(r as Record<string, unknown>);
            if (p) out.push(p);
          }
        }
        return out;
      },
      async remoteTotal(entity) {
        // Sólo las que se piden sin filtros: clientes y productos se piden por
        // alcance (tipo, activo), así que su total no es una sola cifra. Los
        // movimientos son líneas de comprobantes en una ventana: no se auditan.
        if (!REMOTE_TOTAL.has(entity)) return null;
        const path = PATHS[entity];
        if (!path) return null;
        const result = await client.page<unknown>(path, {}, 1, 1);
        return result.total > 0 ? result.total : result.results.length;
      },
      async listPage(entity, query, page) {
        if ((CATALOG_ENTITIES as readonly string[]).includes(entity)) {
          // Los catálogos no se paginan: una respuesta con todo.
          if (page > 1) return { records: [], hasMore: false };
          const catalog = entity as CatalogEntity;
          const body = await client.get<unknown>(CATALOG_PATH[catalog], query);
          const hint = query.document_type ?? query.type;
          const raw = catalogRows(body);
          const records: NormalizedRecord[] = [];
          for (const r of raw) {
            const item = normalizeSiigoCatalogItem(catalog, r, hint);
            if (item) records.push(item);
          }
          return { records, hasMore: false, total: raw.length, skipped: raw.length - records.length };
        }
        const path = PATHS[entity];
        if (!path) return { records: [], hasMore: false };
        const fetched = await pageForEntity(client, entity, path, query, page);
        let skipped = 0;
        const records: NormalizedRecord[] = [];
        for (const r of fetched.results) {
          if (entity === 'supplier_payments' && fetched.usedVouchers) {
            const name = (r as { name?: string }).name;
            if (!isEgressName(name)) continue;
          }
          const normalized = normalize(entity, r);
          if (!normalized.length) skipped += 1;
          records.push(...normalized);
        }
        return {
          records,
          hasMore: hasMorePages(fetched),
          total: fetched.total,
          skipped,
        };
      },
    };
  },
};

/** Las que tienen un total de verdad en su listado sin filtros. */
const REMOTE_TOTAL = new Set<AccountingEntity>([
  'invoices',
  'payments',
  'credit_notes',
  'purchases',
  'quotations',
]);

/**
 * Una página de un listado, con dos salidas ante lo que Siigo no documenta:
 *   - filtros `created_start`/`updated_start` que un listado no acepta (400):
 *     se pide por fecha del documento, que todos los listados conocen;
 *   - egresos: si `/v1/payment-receipts` no se puede listar (404), se leen los
 *     «CE» del listado de recibos de caja.
 */
async function pageForEntity(
  client: SiigoClient,
  entity: AccountingEntity,
  path: string,
  query: ProviderQuery,
  page: number,
): Promise<Awaited<ReturnType<SiigoClient['page']>> & { usedVouchers?: boolean }> {
  const attempt = async (p: string, q: ProviderQuery) => {
    try {
      return await pageRelaxing(client, p, q, page);
    } catch (err) {
      const since = q.created_start ?? q.updated_start;
      if (err instanceof SiigoError && err.status === 400 && since && !q.date_start)
        return pageRelaxing(
          client,
          p,
          { date_start: since.slice(0, 10), ...(q.date_end ? { date_end: q.date_end } : {}) },
          page,
        );
      throw err;
    }
  };
  if (entity !== 'supplier_payments') return attempt(path, query);
  try {
    return await attempt(path, query);
  } catch (err) {
    if (!(err instanceof SiigoError) || (err.status !== 404 && err.status !== 405)) throw err;
    return { ...(await attempt('/v1/vouchers', query)), usedVouchers: true };
  }
}
