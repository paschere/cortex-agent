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
  ProviderToken,
  QueryPlanInput,
} from '../types';
import { amount, clip, currencyCode, day, monthsAgo } from './common';
import {
  QUICKBOOKS_SETUP_MESSAGE,
  type QuickBooksAppConfig,
  QuickBooksClient,
  QuickBooksError,
  exchangeQuickbooksCode,
  quickbooksAppConfig,
  quickbooksSetupMissing,
} from './quickbooks-client';

/**
 * QUICKBOOKS ONLINE (Intuit), con la misma forma que Siigo y Alegra.
 *
 * Todo lo que es de QuickBooks vive aquí y en `quickbooks-client.ts`. Los
 * registros de ejemplo de los tests están copiados de la documentación oficial
 * (developer.intuit.com › API reference).
 *
 *   clientes  → SELECT * FROM Customer
 *   productos → SELECT * FROM Item     (sin las categorías: no se venden)
 *   facturas  → SELECT * FROM Invoice  (TxnDate, MetaData.LastUpdatedTime)
 *   pagos     → SELECT * FROM Payment  (pagos recibidos de clientes)
 *
 * LO QUE ES DISTINTO. QuickBooks no se conecta con una llave pegada sino
 * entrando a Intuit (OAuth): la «llave» que se guarda cifrada es el id de la
 * empresa (`realm_id`), el refresh token y el nombre de la empresa. Ningún
 * campo se escribe a mano (`connect: 'oauth'`); lo llena la vuelta de Intuit
 * (apps/web/app/api/integrations/quickbooks/callback).
 *
 * LO INCREMENTAL es un solo listado: `MetaData.LastUpdatedTime` cambia al
 * crear y al modificar, así que «lo nuevo y lo cambiado» es una consulta, en
 * orden de modificación (lo que cambie mientras se pagina queda al final y no
 * se pierde).
 *
 * UN PAGO NOMBRA SUS FACTURAS POR ID (`Line[].LinkedTxn[].TxnId`), no por
 * número. El número sale de las facturas que ya pasaron por la sesión o, si
 * falta, de una consulta `WHERE Id IN (…)` por página de pagos.
 *
 * LA MONEDA. Un documento sin `CurrencyRef` está en la moneda de la empresa
 * (`Preferences.CurrencyPrefs.HomeCurrency`); se pregunta una vez por sesión y
 * sólo si hace falta.
 */

const INITIAL_MONTHS = 12;
const SWEEP_MONTHS = 6;
/** Si QuickBooks no dice la moneda de la empresa (no debería pasar). */
const FALLBACK_CURRENCY = 'USD';

const TABLES: Record<AccountingEntity, string> = {
  customers: 'Customer',
  products: 'Item',
  invoices: 'Invoice',
  payments: 'Payment',
};

// ---------------------------------------------------------------------------
// Los registros de QuickBooks (sólo lo que se usa; todo opcional)
// ---------------------------------------------------------------------------

interface Ref {
  value?: string;
  name?: string;
}

interface MetaData {
  CreateTime?: string;
  LastUpdatedTime?: string;
}

export interface QuickBooksCustomer {
  Id: string;
  DisplayName?: string;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Mobile?: { FreeFormNumber?: string };
  BillAddr?: { Line1?: string; City?: string; CountrySubDivisionCode?: string };
  Active?: boolean;
  MetaData?: MetaData;
}

export interface QuickBooksItem {
  Id: string;
  Name?: string;
  FullyQualifiedName?: string;
  Sku?: string;
  Type?: string;
  UnitPrice?: number;
  QtyOnHand?: number;
  TrackQtyOnHand?: boolean;
  Active?: boolean;
  ParentRef?: Ref;
  Description?: string;
}

export interface QuickBooksInvoice {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  CustomerRef?: Ref;
  CurrencyRef?: Ref;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  InvoiceLink?: string;
  MetaData?: MetaData;
}

export interface QuickBooksPayment {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  UnappliedAmt?: number;
  CustomerRef?: Ref;
  CurrencyRef?: Ref;
  PaymentRefNum?: string;
  PaymentMethodRef?: Ref;
  DepositToAccountRef?: Ref;
  PrivateNote?: string;
  Line?: Array<{ Amount?: number; LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }>;
  MetaData?: MetaData;
}

// ---------------------------------------------------------------------------
// QuickBooks → forma común
// ---------------------------------------------------------------------------

export function normalizeQuickbooksCustomer(c: QuickBooksCustomer): NormalizedCustomer {
  const person = [c.GivenName, c.FamilyName].filter(Boolean).join(' ');
  return {
    externalId: String(c.Id),
    name: clip(c.DisplayName ?? c.CompanyName ?? person, 200),
    // QuickBooks devuelve el número tributario enmascarado («XXXXX1234»): no
    // sirve para cruzar con `clients.tax_id`, así que no se trae.
    kind: c.CompanyName ? 'Empresa' : person ? 'Persona' : undefined,
    city: clip(
      [c.BillAddr?.City, c.BillAddr?.CountrySubDivisionCode].filter(Boolean).join(', '),
      120,
    ),
    address: clip(c.BillAddr?.Line1, 200),
    phone: clip(c.PrimaryPhone?.FreeFormNumber ?? c.Mobile?.FreeFormNumber, 40),
    email: clip(c.PrimaryEmailAddr?.Address, 200),
    active: c.Active !== false,
    createdOn: day(c.MetaData?.CreateTime),
  };
}

export function normalizeQuickbooksItem(i: QuickBooksItem): NormalizedProduct {
  return {
    externalId: String(i.Id),
    name: clip(i.Name ?? i.FullyQualifiedName, 200),
    code: clip(i.Sku, 60),
    kind:
      i.Type === 'Service'
        ? 'Servicio'
        : i.Type === 'Group'
          ? 'Combo'
          : i.Type === 'Inventory' || i.Type === 'NonInventory'
            ? 'Producto'
            : undefined,
    group: clip(i.ParentRef?.name, 120),
    price: amount(i.UnitPrice),
    stock: i.TrackQtyOnHand ? amount(i.QtyOnHand) : undefined,
    active: i.Active !== false,
  };
}

/**
 * Una factura de QuickBooks en la forma común. `null` si le falta lo que hace
 * falta para contarla. Una factura anulada en QuickBooks queda en cero con la
 * nota «Voided»: se marca anulada.
 */
export function normalizeQuickbooksInvoice(
  inv: QuickBooksInvoice,
  homeCurrency = FALLBACK_CURRENCY,
): NormalizedInvoice | null {
  const date = day(inv.TxnDate);
  const total = amount(inv.TotalAmt);
  if (!inv.Id || !date || total === undefined || total < 0) return null;
  const voided = total === 0 && /^voided/i.test(inv.PrivateNote ?? '');
  const balance = voided ? 0 : Math.min(Math.max(amount(inv.Balance) ?? 0, 0), total);
  return {
    externalId: String(inv.Id),
    number: clip(inv.DocNumber, 120) ?? String(inv.Id),
    date,
    dueDate: day(inv.DueDate) ?? date,
    customerExternalId: inv.CustomerRef?.value,
    customerName: clip(inv.CustomerRef?.name, 200),
    total,
    balance,
    currency: currencyCode(inv.CurrencyRef?.value) ?? homeCurrency,
    status: voided ? 'annulled' : balance <= 0.005 ? 'paid' : 'open',
    notes: clip(inv.CustomerMemo?.value || inv.PrivateNote, 400),
    url: clip(inv.InvoiceLink, 1000),
  };
}

/** Las facturas a las que abona un pago, por id. */
export function quickbooksLinkedInvoiceIds(p: QuickBooksPayment): string[] {
  return (p.Line ?? []).flatMap((l) =>
    (l.LinkedTxn ?? [])
      .filter((t) => t.TxnType === 'Invoice' && t.TxnId)
      .map((t) => String(t.TxnId)),
  );
}

/**
 * Un pago recibido en la forma común: una línea por factura que abona, con su
 * número (de `invoiceNumbers`, id → número), y lo no aplicado como anticipo.
 */
export function normalizeQuickbooksPayment(
  p: QuickBooksPayment,
  invoiceNumbers: ReadonlyMap<string, string>,
  homeCurrency = FALLBACK_CURRENCY,
): NormalizedPayment | null {
  const date = day(p.TxnDate);
  const total = amount(p.TotalAmt);
  if (!p.Id || !date || total === undefined || total <= 0) return null;
  const id = String(p.Id);
  const applications: NormalizedPayment['applications'] = [];
  (p.Line ?? []).forEach((line, i) => {
    const value = amount(line.Amount);
    const invoice = (line.LinkedTxn ?? []).find((t) => t.TxnType === 'Invoice' && t.TxnId);
    if (!invoice || value === undefined || value <= 0) return;
    const txnId = String(invoice.TxnId);
    applications.push({
      ref: `${id}:${i}`,
      invoiceNumber: invoiceNumbers.get(txnId) ?? null,
      amount: value,
    });
  });
  const unapplied = amount(p.UnappliedAmt);
  if (unapplied !== undefined && unapplied > 0)
    applications.push({ ref: `${id}:sin-aplicar`, invoiceNumber: null, amount: unapplied });
  if (!applications.length) applications.push({ ref: id, invoiceNumber: null, amount: total });
  return {
    externalId: id,
    number: clip(p.PaymentRefNum, 120),
    date,
    customerExternalId: p.CustomerRef?.value,
    customerName: clip(p.CustomerRef?.name, 200),
    amount: total,
    currency: currencyCode(p.CurrencyRef?.value) ?? homeCurrency,
    kind: quickbooksLinkedInvoiceIds(p).length ? 'Abono a factura' : 'Anticipo',
    method: clip(
      [p.PaymentMethodRef?.name, p.DepositToAccountRef?.name].filter(Boolean).join(' · '),
      120,
    ),
    notes: clip(p.PrivateNote, 400),
    applications,
  };
}

// ---------------------------------------------------------------------------
// El programa
// ---------------------------------------------------------------------------

/** «2026-10-01T11:50:00.123Z» → «2026-10-01T11:50:00Z», la forma de una fecha en una consulta. */
export function quickbooksDateTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19)}Z`;
}

export function quickbooksQueries(
  entity: AccountingEntity,
  input: QueryPlanInput,
): ProviderQuery[] {
  if (input.mode === 'incremental' && input.since)
    return [
      {
        where: `MetaData.LastUpdatedTime >= '${quickbooksDateTime(input.since)}'`,
        orderby: 'MetaData.LastUpdatedTime',
      },
    ];
  if (entity === 'invoices')
    return [
      {
        where: `TxnDate >= '${monthsAgo(input.now, input.mode === 'sweep' ? SWEEP_MONTHS : INITIAL_MONTHS)}'`,
        orderby: 'MetaData.CreateTime',
      },
    ];
  if (entity === 'payments')
    return [
      {
        where: `TxnDate >= '${monthsAgo(input.now, INITIAL_MONTHS)}'`,
        orderby: 'MetaData.CreateTime',
      },
    ];
  return [{ orderby: 'MetaData.CreateTime' }];
}

/** Ids para un `IN (…)`: sólo dígitos, que es lo que son; nada más entra a la consulta. */
function inList(ids: string[]): string {
  return ids
    .filter((id) => /^\d{1,20}$/.test(id))
    .map((id) => `'${id}'`)
    .join(', ');
}

export const quickbooksProvider: AccountingProvider = {
  id: 'quickbooks',
  name: 'QuickBooks',
  credentialsHelp:
    'Con tu usuario de QuickBooks Online: te llevamos a Intuit, eliges la empresa y das permiso de lectura. No hay llave que copiar.',
  // Lo que se guarda cifrado; nadie lo escribe (lo llena la vuelta de Intuit).
  credentialFields: [
    { key: 'realm_id', label: 'Empresa en QuickBooks', secret: false },
    { key: 'refresh_token', label: 'Permiso de Intuit', secret: true },
    { key: 'company_name', label: 'Nombre de la empresa', secret: false },
  ],
  accountLabelField: 'company_name',
  entities: ['customers', 'products', 'invoices', 'payments'],
  paymentsLabel: 'Pagos recibidos',
  connect: 'oauth',
  setupMissing: () => quickbooksSetupMissing(),
  queries: quickbooksQueries,
  open(credentials, runtime: ProviderRuntime = {}): ProviderSession {
    const config = quickbooksAppConfig();
    const store = runtime.tokenStore;
    const client = config
      ? new QuickBooksClient({
          realmId: credentials.realm_id ?? '',
          refreshToken: credentials.refresh_token ?? '',
          config,
          fetch: runtime.fetch,
          sleep: runtime.sleep,
          now: runtime.now,
          minIntervalMs: runtime.minIntervalMs,
          tokenStore: store,
          onRefreshToken: store?.saveCredentials
            ? (refreshToken) =>
                (store.saveCredentials as NonNullable<typeof store.saveCredentials>)({
                  ...credentials,
                  refresh_token: refreshToken,
                })
            : undefined,
        })
      : null;
    const ready = (): QuickBooksClient => {
      if (!client) throw new QuickBooksError(QUICKBOOKS_SETUP_MESSAGE, 'setup');
      return client;
    };

    // Número de cada factura vista en la sesión, para nombrarla en los pagos.
    const invoiceNumbers = new Map<string, string>();
    let home: Promise<string> | null = null;
    const homeCurrency = () => {
      home ??= ready()
        .homeCurrency()
        .then((c) => currencyCode(c) ?? FALLBACK_CURRENCY)
        .catch(() => FALLBACK_CURRENCY);
      return home;
    };

    const fillInvoiceNumbers = async (payments: QuickBooksPayment[]) => {
      const missing = [
        ...new Set(
          payments.flatMap(quickbooksLinkedInvoiceIds).filter((id) => !invoiceNumbers.has(id)),
        ),
      ];
      for (let i = 0; i < missing.length; i += 100) {
        const list = inList(missing.slice(i, i + 100));
        if (!list) continue;
        const found = await ready().query<{ Id: string; DocNumber?: string }>(
          'Invoice',
          `SELECT Id, DocNumber FROM Invoice WHERE Id IN (${list}) MAXRESULTS 1000`,
        );
        for (const inv of found)
          invoiceNumbers.set(String(inv.Id), inv.DocNumber || String(inv.Id));
      }
    };

    return {
      get requests() {
        return client?.requests ?? 0;
      },
      verify: () => ready().verify(),
      revoke: async () => {
        await client?.revoke();
      },
      async listPage(entity, query, page) {
        const result = await ready().page<unknown>(
          TABLES[entity],
          query.where,
          query.orderby,
          page,
        );
        // Las categorías son carpetas de productos, no productos.
        const raw =
          entity === 'products'
            ? result.results.filter((r) => (r as QuickBooksItem).Type !== 'Category')
            : result.results;
        const needsCurrency =
          (entity === 'invoices' || entity === 'payments') &&
          raw.some((r) => !currencyCode((r as { CurrencyRef?: Ref }).CurrencyRef?.value));
        const currency = needsCurrency ? await homeCurrency() : FALLBACK_CURRENCY;
        if (entity === 'invoices')
          for (const inv of raw as QuickBooksInvoice[])
            if (inv.Id) invoiceNumbers.set(String(inv.Id), inv.DocNumber || String(inv.Id));
        if (entity === 'payments') await fillInvoiceNumbers(raw as QuickBooksPayment[]);
        const records = raw
          .map((r): NormalizedRecord | null => {
            switch (entity) {
              case 'customers':
                return normalizeQuickbooksCustomer(r as QuickBooksCustomer);
              case 'products':
                return normalizeQuickbooksItem(r as QuickBooksItem);
              case 'invoices':
                return normalizeQuickbooksInvoice(r as QuickBooksInvoice, currency);
              case 'payments':
                return normalizeQuickbooksPayment(r as QuickBooksPayment, invoiceNumbers, currency);
            }
          })
          .filter((r): r is NormalizedRecord => r !== null);
        return { records, hasMore: result.hasMore, skipped: raw.length - records.length };
      },
    };
  },
};

/**
 * La vuelta de Intuit: cambia el código por tokens, lee el nombre de la empresa
 * (lo que prueba que el permiso sirve) y devuelve la llave lista para
 * `saveAccountingConnection`. La ruta de la vuelta sólo decide QUIÉN; lo que
 * es de QuickBooks queda aquí.
 */
export async function completeQuickbooksConnection(input: {
  code: string;
  realmId: string;
  redirectUri: string;
  fetch?: typeof fetch;
  config?: QuickBooksAppConfig | null;
}): Promise<{ credentials: Record<string, string>; token: ProviderToken }> {
  const config = input.config === undefined ? quickbooksAppConfig() : input.config;
  if (!config) throw new QuickBooksError(QUICKBOOKS_SETUP_MESSAGE, 'setup');
  const realmId = input.realmId.trim();
  if (!/^\d{1,30}$/.test(realmId))
    throw new QuickBooksError(
      'Intuit no dijo qué empresa elegiste. Vuelve a intentarlo desde Integraciones.',
      'other',
    );
  const tokens = await exchangeQuickbooksCode({
    config,
    code: input.code,
    redirectUri: input.redirectUri,
    fetch: input.fetch,
  });
  const token: ProviderToken = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
  let refreshToken = tokens.refreshToken;
  const client = new QuickBooksClient({
    realmId,
    refreshToken,
    config,
    fetch: input.fetch,
    tokenStore: { load: async () => token, save: async () => undefined },
    onRefreshToken: async (next) => {
      refreshToken = next;
    },
  });
  const name = (await client.companyName())?.slice(0, 200);
  return {
    credentials: {
      realm_id: realmId,
      refresh_token: refreshToken,
      company_name: name && name.length >= 3 ? name : `Empresa ${realmId}`,
    },
    token,
  };
}
