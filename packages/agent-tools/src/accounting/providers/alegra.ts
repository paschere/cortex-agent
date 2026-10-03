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
import { AlegraClient, alegraHasMore } from './alegra-client';
import { amount, bogotaDay, clip, currencyCode, day, daysBefore, monthsAgo } from './common';
import { alegraInvoicing } from './invoicing';
import { alegraBillPage } from './purchases';

/**
 * ALEGRA (Colombia y el resto de Latinoamérica), con la misma forma que Siigo.
 *
 * Todo lo que es de Alegra vive aquí y en `alegra-client.ts`. Los registros de
 * ejemplo de los tests están copiados de la documentación oficial
 * (developer.alegra.com).
 *
 *   clientes  → GET /contacts?type=client
 *   productos → GET /items
 *   facturas  → GET /invoices   (date_afterOrNow, AAAA-MM-DD)
 *   pagos     → GET /payments?type=in  (ingresos; sin filtro de fecha)
 *
 * LO QUE ALEGRA NO TIENE: un filtro de «cambiado desde». Así que:
 *   - facturas: lo incremental pide las de fecha reciente (con tres días de
 *     margen, por las que se fechan hacia atrás) y el repaso diario del motor
 *     (seis meses) trae los saldos que cambiaron por un abono;
 *   - pagos: no hay filtro de fecha, así que se piden del más reciente al más
 *     viejo (`order_field=date`) y se deja de pedir al pasar la fecha de corte.
 *     La fecha de corte (`_desde`) es de Cortex, no se manda a Alegra;
 *   - clientes y productos: se vuelven a leer completos una vez al día (la
 *     primera corrida de cada día en Bogotá). Las facturas traen el nombre del
 *     cliente, así que un cliente nuevo no espera a ese repaso para verse.
 *
 * LA MONEDA. Un documento sin `currency` está en la moneda de la empresa en
 * Alegra (`GET /company`, `currency.code`); se pregunta una vez por sesión y
 * sólo si hace falta.
 */

/** La primera carga trae los documentos del último año. */
const INITIAL_MONTHS = 12;
/** El repaso diario mira las facturas de los últimos seis meses. */
const SWEEP_MONTHS = 6;
/** Margen de lo incremental: facturas y pagos que se fechan hacia atrás. */
const INVOICE_LOOKBACK_DAYS = 3;
const PAYMENT_LOOKBACK_DAYS = 7;
/** Si `/company` no dice la moneda (no debería pasar), la de Alegra Colombia. */
const FALLBACK_CURRENCY = 'COP';
/** Los filtros que empiezan con «_» son de Cortex y no viajan a Alegra. */
const SINCE_KEY = '_desde';

const PATHS: Record<AccountingEntity, string> = {
  customers: '/contacts',
  products: '/items',
  invoices: '/invoices',
  payments: '/payments',
};

// ---------------------------------------------------------------------------
// Los registros de Alegra (sólo lo que se usa; todo opcional)
// ---------------------------------------------------------------------------

type Id = string | number;

export interface AlegraContact {
  id: Id;
  name?: string | { firstName?: string; secondName?: string; lastName?: string };
  identification?: string | null;
  identificationObject?: { type?: string; number?: string; dv?: string | number | null } | null;
  kindOfPerson?: string | null;
  email?: string | null;
  phonePrimary?: string | null;
  mobile?: string | null;
  address?: { address?: string | null; city?: string | null; department?: string | null } | null;
  type?: string[] | string;
  status?: string;
}

export interface AlegraItem {
  id: Id;
  name?: string;
  reference?: string | { reference?: string; type?: string } | null;
  description?: string | null;
  status?: string;
  type?: string;
  category?: { id?: Id; name?: string } | null;
  itemCategory?: { id?: Id; name?: string } | null;
  price?: Array<{ idPriceList?: Id; name?: string; price?: number | string }>;
  inventory?: {
    unit?: string;
    availableQuantity?: number | string;
    unitCost?: number | string;
    /** Existencias por bodega (0183). */
    warehouses?: Array<{
      id?: Id;
      name?: string;
      availableQuantity?: number | string;
      minQuantity?: number | string | null;
    }>;
  } | null;
}

export interface AlegraInvoice {
  id: Id;
  date?: string;
  dueDate?: string | null;
  datetime?: string;
  status?: string;
  total?: number | string;
  totalPaid?: number | string;
  balance?: number | string;
  observations?: string | null;
  anotation?: string | null;
  client?: { id?: Id; name?: string; identification?: string | null } | null;
  numberTemplate?: {
    id?: Id;
    prefix?: string | null;
    number?: string | number;
    fullNumber?: string | null;
  } | null;
  currency?: { code?: string; exchangeRate?: number | string } | null;
  stamp?: { legalStatus?: string | null } | null;
}

export interface AlegraPayment {
  id: Id;
  date?: string;
  number?: string | number | null;
  numberTemplate?: { prefix?: string | null; number?: string | number; fullNumber?: string } | null;
  amount?: number | string;
  type?: string;
  status?: string;
  paymentMethod?: string | null;
  observations?: string | null;
  client?: { id?: Id; name?: string; identification?: string | null } | null;
  bankAccount?: { id?: Id; name?: string } | null;
  invoices?: Array<{ id?: Id; number?: string | null; amount?: number | string }>;
  currency?: { code?: string } | null;
}

// ---------------------------------------------------------------------------
// Alegra → forma común
// ---------------------------------------------------------------------------

/** El número de identificación sin dígito de verificación: «900123456-7» → «900123456». */
function taxDigits(raw: string | null | undefined): string | undefined {
  const head = (raw ?? '').split('-')[0];
  return normalizeNit(head) || undefined;
}

function contactName(c: Pick<AlegraContact, 'name'>): string | undefined {
  if (typeof c.name === 'string') return clip(c.name, 200);
  if (c.name && typeof c.name === 'object')
    return clip(
      [c.name.firstName, c.name.secondName, c.name.lastName].filter(Boolean).join(' '),
      200,
    );
  return undefined;
}

export function normalizeAlegraContact(c: AlegraContact): NormalizedCustomer {
  const number = c.identificationObject?.number ?? undefined;
  const dv = c.identificationObject?.dv;
  const display = clip(number ?? c.identification, 40);
  return {
    externalId: String(c.id),
    name: contactName(c),
    taxId: taxDigits(number ?? c.identification),
    taxIdDisplay:
      display && number && dv !== undefined && dv !== null && dv !== ''
        ? `${display}-${dv}`
        : display,
    kind:
      c.kindOfPerson === 'LEGAL_ENTITY'
        ? 'Empresa'
        : c.kindOfPerson === 'PERSON_ENTITY'
          ? 'Persona'
          : undefined,
    city: clip([c.address?.city, c.address?.department].filter(Boolean).join(', '), 120),
    address: clip(c.address?.address, 200),
    phone: clip(c.phonePrimary ?? c.mobile, 40),
    email: clip(c.email, 200),
    active: c.status !== 'inactive',
  };
}

export function normalizeAlegraItem(i: AlegraItem): NormalizedProduct {
  const reference = typeof i.reference === 'object' ? i.reference?.reference : i.reference;
  const price = (i.price ?? []).find((p) => amount(p.price) !== undefined);
  return {
    externalId: String(i.id),
    name: clip(i.name, 200),
    code: clip(reference, 60),
    // Alegra no distingue producto de servicio en el listado: un ítem con
    // inventario es un producto; un kit, un combo; lo demás no se adivina.
    kind: i.type === 'kit' ? 'Combo' : i.inventory ? 'Producto' : undefined,
    group: clip(i.itemCategory?.name ?? i.category?.name, 120),
    price: amount(price?.price),
    stock: amount(i.inventory?.availableQuantity),
    unit: clip(i.inventory?.unit, 60),
    active: i.status !== 'inactive',
    cost: amount(i.inventory?.unitCost),
    minStock: (() => {
      // El mínimo de Alegra es por bodega: el de la empresa es la suma.
      const mins = (i.inventory?.warehouses ?? [])
        .map((w) => amount(w.minQuantity))
        .filter((n): n is number => n !== undefined);
      return mins.length ? mins.reduce((a, b) => a + b, 0) : undefined;
    })(),
    warehouses: (() => {
      const list = (i.inventory?.warehouses ?? [])
        .filter((w) => w.id !== undefined && amount(w.availableQuantity) !== undefined)
        .map((w) => ({
          externalId: String(w.id),
          name: clip(w.name, 100) ?? 'Bodega',
          quantity: amount(w.availableQuantity) as number,
        }));
      return list.length ? list : undefined;
    })(),
  };
}

/** «FE1234»: el número completo que muestra Alegra; si no viene, prefijo + consecutivo. */
export function alegraInvoiceNumber(inv: Pick<AlegraInvoice, 'id' | 'numberTemplate'>): string {
  const t = inv.numberTemplate;
  return (
    clip(t?.fullNumber, 120) ??
    (t?.number !== undefined && t?.number !== null && String(t.number) !== ''
      ? clip(`${t.prefix ?? ''}${t.number}`, 120)
      : undefined) ??
    String(inv.id)
  );
}

function einvoiceStatus(stamp: AlegraInvoice['stamp']): NormalizedInvoice['einvoiceStatus'] {
  const s = stamp?.legalStatus?.toUpperCase();
  if (!s) return undefined;
  if (s.includes('ACCEPTED')) return 'Aceptada';
  if (s.includes('REJECTED')) return 'Rechazada';
  if (s.includes('WAITING') || s.includes('PENDING') || s.includes('PROCESS')) return 'Pendiente';
  return 'Otro';
}

/**
 * Una factura de Alegra en la forma común. `null` si le falta lo que hace falta
 * para contarla (id, fecha o total). `status`: open → por cobrar, closed →
 * pagada, void → anulada. Los borradores no llegan aquí (`ignore`).
 */
export function normalizeAlegraInvoice(
  inv: AlegraInvoice,
  localCurrency = FALLBACK_CURRENCY,
): NormalizedInvoice | null {
  const date = day(inv.date);
  const total = amount(inv.total);
  if (!inv.id || !date || total === undefined || total < 0) return null;
  const annulled = inv.status === 'void';
  const rawBalance = annulled
    ? 0
    : (amount(inv.balance) ?? (inv.status === 'closed' ? 0 : total - (amount(inv.totalPaid) ?? 0)));
  const balance = Math.min(Math.max(rawBalance, 0), total);
  return {
    externalId: String(inv.id),
    number: alegraInvoiceNumber(inv),
    date,
    dueDate: day(inv.dueDate) ?? date,
    customerExternalId: inv.client?.id !== undefined ? String(inv.client.id) : undefined,
    customerName: clip(inv.client?.name, 200),
    customerTaxId: taxDigits(inv.client?.identification),
    total,
    balance,
    currency: currencyCode(inv.currency?.code) ?? localCurrency,
    status: annulled ? 'annulled' : inv.status === 'closed' || balance <= 0.005 ? 'paid' : 'open',
    einvoiceStatus: einvoiceStatus(inv.stamp),
    notes: clip(inv.observations || inv.anotation, 400),
  };
}

const METHOD: Record<string, string> = {
  cash: 'Efectivo',
  'debit-card': 'Tarjeta débito',
  'credit-card': 'Tarjeta crédito',
  transfer: 'Transferencia',
  check: 'Cheque',
  deposit: 'Consignación',
};

/**
 * Un pago recibido en la forma común: una línea por factura que abona, con el
 * valor que le aplica. Si Alegra no dice cuánto va a cada una y es una sola,
 * va todo a ésa; si son varias sin valor, no se reparte a ciegas: va como un
 * pago sin factura. Sin facturas, es un anticipo.
 */
export function normalizeAlegraPayment(
  p: AlegraPayment,
  localCurrency = FALLBACK_CURRENCY,
): NormalizedPayment | null {
  const date = day(p.date);
  if (!p.id || !date) return null;
  const invoices = p.invoices ?? [];
  const lines = invoices
    .map((inv, i) => ({ inv, i, value: amount(inv.amount) }))
    .filter(
      (l): l is { inv: (typeof l)['inv']; i: number; value: number } =>
        l.value !== undefined && l.value > 0,
    );
  const linesTotal = lines.reduce((sum, l) => sum + l.value, 0);
  const total = amount(p.amount) ?? (lines.length ? amount(linesTotal) : undefined);
  if (total === undefined || total <= 0) return null;
  const id = String(p.id);
  const only = invoices.length === 1 ? invoices[0] : undefined;
  const applications: NormalizedPayment['applications'] = lines.length
    ? lines.map((l) => ({
        ref: `${id}:${l.i}`,
        invoiceNumber: clip(l.inv.number, 120) ?? null,
        amount: l.value,
      }))
    : [{ ref: id, invoiceNumber: clip(only?.number, 120) ?? null, amount: total }];
  const number =
    clip(p.numberTemplate?.fullNumber, 120) ??
    (p.number !== undefined && p.number !== null
      ? clip(`${p.numberTemplate?.prefix ?? ''}${p.number}`, 120)
      : undefined);
  return {
    externalId: id,
    number,
    date,
    customerExternalId: p.client?.id !== undefined ? String(p.client.id) : undefined,
    customerName: clip(p.client?.name, 200),
    customerTaxId: taxDigits(p.client?.identification),
    amount: total,
    currency: currencyCode(p.currency?.code) ?? localCurrency,
    kind: invoices.length ? 'Abono a factura' : 'Anticipo',
    method: clip(
      [p.paymentMethod ? (METHOD[p.paymentMethod] ?? p.paymentMethod) : '', p.bankAccount?.name]
        .filter(Boolean)
        .join(' · '),
      120,
    ),
    notes: clip(p.observations, 400),
    applications,
  };
}

/** Lo que Alegra lista pero no es de nadie: borradores y documentos anulados que no mueven plata. */
function ignore(entity: AccountingEntity, record: unknown): boolean {
  const status = (record as { status?: string } | null)?.status;
  if (entity === 'invoices') return status === 'draft';
  if (entity === 'payments') return status === 'void';
  return false;
}

// ---------------------------------------------------------------------------
// El programa
// ---------------------------------------------------------------------------

const BY_ID = { order_field: 'id', order_direction: 'ASC' } as const;
const PAYMENTS_NEWEST_FIRST = { type: 'in', order_field: 'date', order_direction: 'DESC' } as const;

export function alegraQueries(entity: AccountingEntity, input: QueryPlanInput): ProviderQuery[] {
  const incremental = input.mode === 'incremental' && input.since;
  if (entity === 'invoices') {
    const from = incremental
      ? daysBefore(input.since as string, INVOICE_LOOKBACK_DAYS)
      : monthsAgo(input.now, input.mode === 'sweep' ? SWEEP_MONTHS : INITIAL_MONTHS);
    return [{ ...BY_ID, date_afterOrNow: from }];
  }
  if (entity === 'payments') {
    const from = incremental
      ? daysBefore(input.since as string, PAYMENT_LOOKBACK_DAYS)
      : monthsAgo(input.now, INITIAL_MONTHS);
    return [{ ...PAYMENTS_NEWEST_FIRST, [SINCE_KEY]: from }];
  }
  // Clientes y productos: sin filtro de cambios en Alegra, completos una vez
  // al día (la primera corrida de un día nuevo en Bogotá); el resto del día, nada.
  if (incremental && bogotaDay(input.since as string) === bogotaDay(input.now)) return [];
  return [entity === 'customers' ? { ...BY_ID, type: 'client' } : { ...BY_ID }];
}

export const alegraProvider: AccountingProvider = {
  id: 'alegra',
  name: 'Alegra',
  credentialsHelp:
    'En Alegra: Configuración → «API - Integraciones con otros sistemas». Copia el correo y el token.',
  credentialFields: [
    {
      key: 'email',
      label: 'Correo de la cuenta',
      secret: false,
      placeholder: 'usuario@empresa.com',
    },
    { key: 'token', label: 'Token de la API', secret: true, placeholder: 'Pega el token' },
  ],
  accountLabelField: 'email',
  entities: ['customers', 'products', 'invoices', 'payments'],
  paymentsLabel: 'Pagos recibidos',
  queries: alegraQueries,
  open(credentials, runtime: ProviderRuntime = {}): ProviderSession {
    const client = new AlegraClient({
      email: credentials.email ?? '',
      token: credentials.token ?? '',
      fetch: runtime.fetch,
      sleep: runtime.sleep,
      now: runtime.now,
      minIntervalMs: runtime.minIntervalMs,
    });
    let localCurrency: Promise<string> | null = null;
    const companyCurrency = () => {
      localCurrency ??= client
        .get<{ currency?: { code?: string } } | null>('/company')
        .then((c) => currencyCode(c?.currency?.code) ?? FALLBACK_CURRENCY)
        .catch(() => FALLBACK_CURRENCY);
      return localCurrency;
    };
    return {
      get requests() {
        return client.requests;
      },
      async verify() {
        await client.verify();
        return { token: null };
      },
      invoicing: alegraInvoicing(client),
      listPurchases: async (since, page) =>
        alegraBillPage(client, since, page, await companyCurrency()),
      async listPage(entity, query, page) {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(query)) if (!k.startsWith('_')) params[k] = v;
        const result = await client.page<unknown>(PATHS[entity], params, page);
        let raw = result.results.filter((r) => !ignore(entity, r));
        // Pagos del más reciente al más viejo: al pasar la fecha de corte, se acabó.
        let reachedCutoff = false;
        const since = query[SINCE_KEY];
        if (entity === 'payments' && since) {
          const dates = result.results.map((r) => day((r as AlegraPayment).date) ?? '');
          reachedCutoff = dates.some((d) => d !== '' && d < since);
          raw = raw.filter((r) => (day((r as AlegraPayment).date) ?? since) >= since);
        }
        const needsCurrency =
          (entity === 'invoices' || entity === 'payments') &&
          raw.some((r) => !currencyCode((r as { currency?: { code?: string } }).currency?.code));
        const currency = needsCurrency ? await companyCurrency() : FALLBACK_CURRENCY;
        const records = raw
          .map((r): NormalizedRecord | null => {
            switch (entity) {
              case 'customers':
                return normalizeAlegraContact(r as AlegraContact);
              case 'products':
                return normalizeAlegraItem(r as AlegraItem);
              case 'invoices':
                return normalizeAlegraInvoice(r as AlegraInvoice, currency);
              case 'payments':
                return normalizeAlegraPayment(r as AlegraPayment, currency);
            }
          })
          .filter((r): r is NormalizedRecord => r !== null);
        return {
          records,
          hasMore: !reachedCutoff && alegraHasMore(result),
          total: result.total ?? undefined,
          skipped: raw.length - records.length,
        };
      },
    };
  },
};
