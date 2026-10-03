import { normalizeNit } from '../../clients/shape';
import type {
  AccountingEntity,
  AccountingProvider,
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
import { siigoInvoicing } from './invoicing';
import { siigoPurchasePage } from './purchases';
import { SiigoClient, hasMorePages } from './siigo-client';

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
/** La primera carga trae los documentos del último año. */
const INITIAL_MONTHS = 12;
/** El repaso diario mira las facturas de los últimos seis meses. */
const SWEEP_MONTHS = 6;

const PATHS: Record<AccountingEntity, string> = {
  customers: '/v1/customers',
  products: '/v1/products',
  invoices: '/v1/invoices',
  payments: '/v1/vouchers',
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
    price_list?: Array<{ position?: number; value?: number }>;
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
  stamp?: { status?: string } | null;
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
    einvoiceStatus: einvoiceStatus(inv.stamp?.status ?? undefined),
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

function normalize(entity: AccountingEntity, record: unknown): NormalizedRecord | null {
  switch (entity) {
    case 'customers':
      return normalizeSiigoCustomer(record as SiigoCustomer);
    case 'products':
      return normalizeSiigoProduct(record as SiigoProduct);
    case 'invoices':
      return normalizeSiigoInvoice(record as SiigoInvoice);
    case 'payments':
      return normalizeSiigoVoucher(record as SiigoVoucher);
  }
}

// ---------------------------------------------------------------------------
// El programa
// ---------------------------------------------------------------------------

export function siigoQueries(entity: AccountingEntity, input: QueryPlanInput): ProviderQuery[] {
  if (input.mode === 'incremental' && input.since) {
    const since = siigoDateTime(input.since);
    // Lo nuevo y lo cambiado son dos listados: un registro recién creado puede
    // traer `last_updated` vacío y no salir en el filtro de modificados.
    return [{ created_start: since }, { updated_start: since }];
  }
  if (entity === 'invoices')
    return [
      { date_start: monthsAgo(input.now, input.mode === 'sweep' ? SWEEP_MONTHS : INITIAL_MONTHS) },
    ];
  if (entity === 'payments') return [{ created_start: monthsAgo(input.now, INITIAL_MONTHS) }];
  return [{}];
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
  entities: ['customers', 'products', 'invoices', 'payments'],
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
      listPurchases: (since, page) => siigoPurchasePage(client, since, page),
      async listPage(entity, query, page) {
        const result = await client.page<unknown>(PATHS[entity], query, page);
        const records = result.results
          .map((r) => normalize(entity, r))
          .filter((r): r is NormalizedRecord => r !== null);
        return {
          records,
          hasMore: hasMorePages(result),
          total: result.total,
          skipped: result.results.length - records.length,
        };
      },
    };
  },
};
