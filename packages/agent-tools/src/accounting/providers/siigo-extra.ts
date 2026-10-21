import { classifyPayrollAccount } from '../payroll';
import type {
  CatalogEntity,
  NormalizedCatalogItem,
  NormalizedJournalLine,
  NormalizedQuotation,
  NormalizedSupplierPayment,
} from '../types';
import { amount, clip, currencyCode, day } from './common';

/**
 * LO DE SIIGO QUE LLENA LAS TABLAS NUEVAS (0234): egresos, movimientos de
 * comprobantes, cotizaciones y catálogos. Puro: de la respuesta cruda a la
 * forma común (`../types.ts`).
 *
 *   egresos        GET /v1/payment-receipts  (document RP; mismo cuerpo que el
 *                  recibo de caja pero con `supplier`; items[].due = la compra
 *                  «FC-2-22»). Si Siigo no lo expone para listar, se cae a
 *                  GET /v1/vouchers y se dejan los «CE».
 *   movimientos    GET /v1/journals          (items[].account.code|movement,
 *                  customer.identification, cost_center, description, value)
 *   cotizaciones   GET /v1/quotations
 *   catálogos      GET /v1/cost-centers, /v1/taxes, /v1/payment-types
 *                  ?document_type=…, /v1/warehouses, /v1/document-types?type=…,
 *                  /v1/users (vendedores)
 *
 * Los registros de ejemplo de los tests siguen la forma que usan las
 * escrituras de este mismo conector (close/writeback/siigo.ts), que sí
 * están verificadas contra Siigo.
 */

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

const LOCAL_CURRENCY = 'COP';
/** Un comprobante con más líneas que esto guarda las primeras (un cierre masivo no llena la tabla). */
export const MAX_LINES_PER_JOURNAL = 300;

function dueName(due: Raw | null): string | null {
  const prefix = clip(due?.prefix, 20);
  const consecutive = due?.consecutive;
  if (!prefix || consecutive === undefined || consecutive === null) return null;
  return `${prefix}-${consecutive}`;
}

// ---------------------------------------------------------------------------
// Egresos
// ---------------------------------------------------------------------------

/** Un comprobante de egreso → pago a proveedor. `null` si no trae id, fecha o valor. */
export function normalizeSiigoSupplierPayment(r: Raw): NormalizedSupplierPayment | null {
  const id = clip(r.id, 120);
  const date = day(r.date);
  if (!id || !date) return null;
  const party = obj(r.supplier) ?? obj(r.customer);
  const lines = arr(r.items)
    .map((item, i) => ({ item, i, value: amount(item.value) }))
    .filter(
      (l): l is { item: Raw; i: number; value: number } =>
        Boolean(obj(l.item.due)) && l.value !== undefined && l.value > 0,
    );
  const linesTotal = lines.reduce((sum, l) => sum + l.value, 0);
  const paid = amount(obj(r.payment)?.value);
  const total = paid ?? (lines.length ? amount(linesTotal) : amount(r.total));
  if (total === undefined || total <= 0) return null;
  return {
    externalId: id,
    number: clip(r.name ?? r.number, 120),
    date,
    supplierExternalId: clip(party?.id, 60),
    supplierName: clip(party?.name, 200),
    supplierTaxId: clip(party?.identification, 40),
    amount: total,
    currency: currencyCode(obj(r.currency)?.code) ?? LOCAL_CURRENCY,
    method: clip(obj(r.payment)?.name, 120),
    notes: clip(r.observations, 400),
    annulled: r.annulled === true,
    applications: lines.length
      ? lines.map((l) => ({
          ref: `${id}:${l.i}`,
          purchaseNumber: dueName(obj(l.item.due)),
          amount: l.value,
        }))
      : [{ ref: id, purchaseNumber: null, amount: total }],
  };
}

/** Los de egreso empiezan por «CE» (cuando se lee del listado de recibos de caja). */
export const isEgressName = (name: string | undefined): boolean => /^CE/i.test((name ?? '').trim());

// ---------------------------------------------------------------------------
// Movimientos de los comprobantes contables
// ---------------------------------------------------------------------------

/**
 * Un comprobante → una línea por movimiento. Las cuentas de nómina (5105,
 * 2505…) salen sin tercero ni descripción: ahí el tercero es una persona.
 */
export function normalizeSiigoJournalLines(r: Raw): NormalizedJournalLine[] {
  const id = clip(r.id, 120);
  const date = day(r.date);
  if (!id || !date) return [];
  const number = clip(r.name, 60) ?? clip(r.number, 40) ?? id;
  const out: NormalizedJournalLine[] = [];
  arr(r.items).forEach((it, index) => {
    if (out.length >= MAX_LINES_PER_JOURNAL) return;
    const account = obj(it.account);
    const code = clip(account?.code, 20)?.replace(/\D/g, '');
    const value = amount(it.value);
    if (!code || value === undefined || value === 0) return;
    const customer = obj(it.customer);
    const movement = String(account?.movement ?? '').toLowerCase() === 'credit' ? 'credit' : 'debit';
    const confidential = classifyPayrollAccount(code) !== null;
    const cc = obj(it.cost_center);
    const costCenter = clip(cc?.id ?? it.cost_center, 40);
    out.push({
      externalId: `${id}:${index}`,
      journalId: id,
      journalNumber: number,
      date,
      account: code,
      accountName: clip(account?.name, 100),
      movement,
      value: Math.abs(value),
      partyExternalId: clip(customer?.id, 60),
      partyTaxId: clip(customer?.identification, 40),
      costCenter,
      description: clip(it.description, 200) ?? clip(r.observations, 200),
      ...(confidential ? { confidential: true } : {}),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Cotizaciones
// ---------------------------------------------------------------------------

export function normalizeSiigoQuotation(r: Raw): NormalizedQuotation | null {
  const id = clip(r.id, 120);
  const number = clip(r.name ?? r.number, 120);
  const date = day(r.date);
  const total = amount(r.total);
  if (!id || !number || !date || total === undefined || total < 0) return null;
  const customer = obj(r.customer);
  return {
    externalId: id,
    number,
    date,
    validUntil: day(r.due_date) ?? day(r.expiration_date) ?? day(r.valid_until),
    customerExternalId: clip(customer?.id, 60),
    customerTaxId: clip(customer?.identification, 40)?.replace(/\D/g, '') || undefined,
    sellerExternalId: clip(r.seller, 40),
    total,
    currency: currencyCode(obj(r.currency)?.code) ?? LOCAL_CURRENCY,
    notes: clip(r.observations, 400),
  };
}

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

/** Los tipos de documento y las formas de pago se piden por clase de documento. */
export const DOCUMENT_TYPE_CLASSES = ['FV', 'NC', 'FC', 'RC', 'RP', 'CC'] as const;
export const PAYMENT_TYPE_CLASSES = ['FV', 'FC', 'RC'] as const;

export const CATALOG_PATH: Record<CatalogEntity, string> = {
  cost_centers: '/v1/cost-centers',
  taxes: '/v1/taxes',
  payment_methods: '/v1/payment-types',
  warehouses: '/v1/warehouses',
  document_types: '/v1/document-types',
  sellers: '/v1/users',
  // 0235 (siigoapi.docs.apiary.io › Catálogos)
  price_lists: '/v1/price-lists',
  account_groups: '/v1/account-groups',
  fixed_assets: '/v1/fixed-assets',
  // «Descuentos en recibos de caja»: lo único que la API llama «expense».
  expense_concepts: '/v1/expense',
  // NO documentada: se prueba y, si Siigo responde 404/400, se usa la lista de respaldo.
  cities: '/v1/cities',
};

/** Una fila de catálogo de Siigo; `null` si no trae id o nombre. */
export function normalizeSiigoCatalogItem(
  catalog: CatalogEntity,
  r: Raw,
  kindHint?: string,
): NormalizedCatalogItem | null {
  const id = clip(r.id, 60) ?? clip(r.code, 60) ?? clip(r.city_code, 60);
  if (!id) return null;
  const active = r.active === false ? false : true;
  switch (catalog) {
    case 'cost_centers': {
      const name = clip(r.name, 160);
      return name ? { externalId: id, catalog, name, code: clip(r.code, 40), active } : null;
    }
    case 'taxes': {
      const name = clip(r.name, 160);
      if (!name) return null;
      return {
        externalId: id,
        catalog,
        name,
        kind: clip(r.type, 60),
        percentage: amount(r.percentage),
        active,
      };
    }
    case 'payment_methods': {
      const name = clip(r.name, 160);
      if (!name) return null;
      const credit = r.due_date === true || String(r.type ?? '').toLowerCase() === 'credit';
      return {
        externalId: id,
        catalog,
        name,
        code: kindHint,
        kind: credit ? 'Crédito' : 'Contado',
        active,
      };
    }
    case 'warehouses': {
      const name = clip(r.name, 160);
      return name ? { externalId: id, catalog, name, code: clip(r.code, 40), active } : null;
    }
    case 'document_types': {
      const name = clip(r.name, 160);
      if (!name) return null;
      return {
        externalId: id,
        catalog,
        name,
        code: clip(r.code, 40),
        kind: kindHint ?? clip(r.type, 20),
        active,
      };
    }
    case 'price_lists': {
      const name = clip(r.name, 160);
      if (!name) return null;
      const position = amount(r.position);
      return {
        externalId: id,
        catalog,
        name,
        code: position === undefined ? undefined : String(position),
        kind: position === undefined ? undefined : String(position),
        active,
      };
    }
    case 'account_groups':
    case 'expense_concepts': {
      const name = clip(r.name, 160);
      return name ? { externalId: id, catalog, name, active } : null;
    }
    case 'fixed_assets': {
      const name = clip(r.name, 160);
      return name ? { externalId: id, catalog, name, kind: clip(r.group, 100), active } : null;
    }
    case 'cities': {
      // Forma no documentada: se aceptan los nombres que usa Siigo en `address.city`.
      const code = clip(r.city_code ?? r.code ?? r.id, 10);
      const name = clip(r.city_name ?? r.name, 160);
      if (!code || !name) return null;
      return {
        externalId: code,
        catalog,
        name,
        code,
        kind: clip(r.state_name ?? r.department ?? r.state, 100),
        active,
      };
    }
    case 'sellers': {
      // Sólo el nombre: el correo y la identificación de un empleado no entran a una tabla.
      const first = clip(r.first_name, 80);
      const last = clip(r.last_name, 80);
      const name = [first, last].filter(Boolean).join(' ') || clip(r.username, 80);
      return name ? { externalId: id, catalog, name, active } : null;
    }
  }
}

/** Un catálogo puede llegar como lista o como `{ results: [...] }`. */
export function catalogRows(body: unknown): Raw[] {
  if (Array.isArray(body)) return body as Raw[];
  return arr(obj(body)?.results);
}
