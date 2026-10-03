import type { AlegraClient } from './alegra-client';
import { alegraHasMore } from './alegra-client';
import { amount, clip, currencyCode, day } from './common';
import type { QuickBooksClient } from './quickbooks-client';
import type { SiigoClient } from './siigo-client';
import { hasMorePages } from './siigo-client';

/**
 * LAS COMPRAS (FACTURAS DE PROVEEDOR) DE CADA PROGRAMA, A UNA SOLA FORMA.
 *
 * Aislado aquí a propósito: el resto de la sincronización contable habla de
 * ventas (clientes, facturas, recibos). Esto sólo lo lee cuentas por pagar
 * (packages/agent-tools/src/payables, 0181) desde el trabajo del programa
 * contable, con `ProviderSession.listPurchases` cuando el programa lo expone:
 *
 *   Siigo       GET /v1/purchases       (número del proveedor en provider_invoice)
 *   Alegra      GET /bills              (facturas de proveedor)
 *   QuickBooks  SELECT * FROM Bill
 *
 * Puro: de la fila cruda a `NormalizedPurchase`, o null si no alcanza.
 */

export interface NormalizedPurchase {
  externalId: string;
  /** El número de la factura DEL PROVEEDOR cuando el programa lo guarda. */
  number: string;
  date: string;
  dueDate?: string | null;
  supplierName?: string | null;
  supplierTaxId?: string | null;
  total: number;
  balance: number;
  currency: string;
  status: 'open' | 'paid' | 'annulled';
}

type Raw = Record<string, unknown>;

function obj(v: unknown): Raw | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
}

function statusOf(balance: number, annulled: boolean): NormalizedPurchase['status'] {
  if (annulled) return 'annulled';
  return balance <= 0.004 ? 'paid' : 'open';
}

export function normalizeSiigoPurchase(
  r: Raw,
  fallbackCurrency = 'COP',
): NormalizedPurchase | null {
  const id = clip(r.id, 120);
  const date = day(r.date);
  const total = amount(r.total);
  if (!id || !date || total === undefined) return null;
  const pi = obj(r.provider_invoice);
  const providerNumber = pi
    ? `${clip(pi.prefix, 20) ?? ''}${clip(pi.number, 40) ?? ''}`.trim()
    : '';
  const number = providerNumber || clip(r.name, 60) || clip(r.number, 60) || id;
  const supplier = obj(r.supplier);
  const payments = Array.isArray(r.payments) ? (r.payments as Raw[]) : [];
  const dues = payments
    .map((p) => day(p.due_date))
    .filter((d): d is string => Boolean(d))
    .sort();
  const balance = Math.max(0, amount(r.balance) ?? total);
  return {
    externalId: id,
    number,
    date,
    dueDate: dues[dues.length - 1] ?? null,
    supplierName: clip(supplier?.name, 200) ?? null,
    supplierTaxId: clip(supplier?.identification, 30) ?? null,
    total,
    balance,
    currency: currencyCode(obj(r.currency)?.code) ?? fallbackCurrency,
    status: statusOf(balance, r.annulled === true),
  };
}

export function normalizeAlegraBill(r: Raw, fallbackCurrency = 'COP'): NormalizedPurchase | null {
  const id = clip(r.id, 120);
  const date = day(r.date);
  const total = amount(r.total);
  if (!id || !date || total === undefined) return null;
  const tpl = obj(r.numberTemplate);
  const number =
    clip(tpl?.fullNumber, 60) ||
    (tpl ? `${clip(tpl.prefix, 20) ?? ''}${clip(tpl.number, 40) ?? ''}`.trim() : '') ||
    clip(r.billNumber, 60) ||
    clip(r.number, 60) ||
    id;
  const provider = obj(r.provider) ?? obj(r.client);
  const identification = provider?.identification;
  const balance = Math.max(0, amount(r.balance) ?? total - (amount(r.totalPaid) ?? 0));
  const status = String(r.status ?? '').toLowerCase();
  return {
    externalId: id,
    number,
    date,
    dueDate: day(r.dueDate) ?? null,
    supplierName: clip(provider?.name, 200) ?? null,
    supplierTaxId:
      typeof identification === 'string' || typeof identification === 'number'
        ? (clip(identification, 30) ?? null)
        : (clip(obj(identification)?.number, 30) ?? null),
    total,
    balance,
    currency: currencyCode(obj(r.currency)?.code) ?? fallbackCurrency,
    status: statusOf(balance, status === 'void'),
  };
}

export function normalizeQuickbooksBill(
  r: Raw,
  fallbackCurrency = 'USD',
): NormalizedPurchase | null {
  const id = clip(r.Id, 120);
  const date = day(r.TxnDate);
  const total = amount(r.TotalAmt);
  if (!id || !date || total === undefined) return null;
  const vendor = obj(r.VendorRef);
  const balance = Math.max(0, amount(r.Balance) ?? total);
  return {
    externalId: id,
    number: clip(r.DocNumber, 60) || id,
    date,
    dueDate: day(r.DueDate) ?? null,
    supplierName: clip(vendor?.name, 200) ?? null,
    supplierTaxId: null,
    total,
    balance,
    currency: currencyCode(obj(r.CurrencyRef)?.value) ?? fallbackCurrency,
    status: statusOf(balance, false),
  };
}

// ---------------------------------------------------------------------------
// La página de compras de cada programa (lo que `listPurchases` llama)
// ---------------------------------------------------------------------------

export interface PurchasePage {
  records: NormalizedPurchase[];
  hasMore: boolean;
}

function keep<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

export async function siigoPurchasePage(
  client: SiigoClient,
  since: string,
  page: number,
): Promise<PurchasePage> {
  const result = await client.page<Raw>('/v1/purchases', { date_start: since }, page);
  return {
    records: keep(result.results.map((r) => normalizeSiigoPurchase(r))),
    hasMore: hasMorePages(result),
  };
}

export async function alegraBillPage(
  client: AlegraClient,
  since: string,
  page: number,
  currency = 'COP',
): Promise<PurchasePage> {
  const result = await client.page<Raw>(
    '/bills',
    { order_field: 'date', order_direction: 'DESC' },
    page,
  );
  const records = keep(result.results.map((r) => normalizeAlegraBill(r, currency)));
  // Del más reciente al más viejo: al pasar la fecha de corte, se acabó.
  const reachedCutoff = records.some((r) => r.date < since);
  return {
    records: records.filter((r) => r.date >= since),
    hasMore: !reachedCutoff && alegraHasMore(result),
  };
}

export async function quickbooksBillPage(
  client: QuickBooksClient,
  since: string,
  page: number,
  currency = 'USD',
): Promise<PurchasePage> {
  const result = await client.page<Raw>('Bill', `TxnDate >= '${since}'`, 'TxnDate', page);
  return {
    records: keep(result.results.map((r) => normalizeQuickbooksBill(r, currency))),
    hasMore: result.hasMore,
  };
}
