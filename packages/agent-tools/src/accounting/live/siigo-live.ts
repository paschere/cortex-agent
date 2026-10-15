import { amount, clip, currencyCode, day } from '../providers/common';
import type { SiigoClient } from '../providers/siigo-client';
import { hasMorePages } from '../providers/siigo-client';
import {
  type LiveDoc,
  type LiveLine,
  type LiveRecord,
  type LiveRequest,
  type LiveResource,
  type LiveResult,
  docMatches,
  groupDocs,
  maskPayroll,
  totalsOf,
  trimLinesToAccount,
} from './shape';

/**
 * CONSULTA EN VIVO A SIIGO (sólo GET).
 *
 * Rutas (siigoapi.docs.apiary.io y SDK oficial SiigoSAS/siigo_sdk_javascript):
 *   facturas_venta     GET /v1/invoices       (document_id, customer_identification, name,
 *                                              date_start, date_end, created_*, updated_*)
 *   notas_credito      GET /v1/credit-notes
 *   compras            GET /v1/purchases      (las de documento soporte traen prefijo «DS»)
 *   documento_soporte  GET /v1/purchases      (sólo las que empiezan por «DS»)
 *   recibos_caja       GET /v1/vouchers       (los de egreso empiezan por «CE»)
 *   pagos              GET /v1/vouchers       (sólo los «CE»)
 *   comprobantes       GET /v1/journals       (items[].account.code|movement, customer, value)
 *   terceros           GET /v1/customers      (identification)
 *   productos          GET /v1/products       (code)
 *   impuestos          GET /v1/taxes          (sin paginar)
 *
 * Los filtros que Siigo conoce se mandan al servidor para leer menos; TODOS se
 * vuelven a aplicar aquí (`docMatches`), así un filtro que Siigo ignore no
 * deja pasar documentos de más. Cada página espera su turno en el cliente
 * (límite de Siigo) y la lectura se corta a tiempo, avisando cuánto faltó.
 */

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

const PATH: Partial<Record<LiveResource, string>> = {
  facturas_venta: '/v1/invoices',
  notas_credito: '/v1/credit-notes',
  compras: '/v1/purchases',
  documento_soporte: '/v1/purchases',
  recibos_caja: '/v1/vouchers',
  pagos: '/v1/vouchers',
  comprobantes: '/v1/journals',
  terceros: '/v1/customers',
  productos: '/v1/products',
};

const DEFAULT_MAX_DOCS = 3_000;
const HARD_MAX_DOCS = 10_000;
const TIME_BUDGET_MS = 45_000;
const NAME_LOOKUPS = 12;

// ---------------------------------------------------------------------------
// Siigo → LiveDoc (puro)
// ---------------------------------------------------------------------------

function docName(r: Raw): string {
  const name = clip(r.name, 60);
  if (name) return name;
  const pi = obj(r.provider_invoice);
  const doc = obj(r.document);
  const number = clip(r.number, 40);
  return (
    (pi ? `${clip(pi.prefix, 20) ?? ''}${clip(pi.number, 40) ?? ''}` : '') ||
    `${clip(doc?.id, 20) ?? ''}${number ? `-${number}` : ''}` ||
    clip(r.id, 60) ||
    'sin número'
  );
}

function statusOf(r: Raw, balance: number | undefined): LiveDoc['status'] {
  if (r.annulled === true) return 'annulled';
  if (balance === undefined) return undefined;
  return balance > 0.004 ? 'open' : 'paid';
}

function itemLines(r: Raw): LiveLine[] {
  return arr(r.items).flatMap((it): LiveLine[] => {
    const qty = amount(it.quantity);
    const price = amount(it.price);
    const total = amount(it.total) ?? amount(it.value) ?? (qty !== undefined && price !== undefined ? qty * price : undefined);
    if (total === undefined) return [];
    const account = obj(it.account);
    const code = clip(account?.code, 20)?.replace(/\D/g, '');
    return [
      {
        product: clip(it.description, 120) ?? clip(it.code, 60),
        description: clip(it.description, 200),
        quantity: qty,
        value: Math.abs(total),
        ...(code ? { account: code } : {}),
      },
    ];
  });
}

function journalLines(r: Raw): LiveLine[] {
  return arr(r.items).flatMap((it): LiveLine[] => {
    const account = obj(it.account);
    const code = clip(account?.code, 20)?.replace(/\D/g, '');
    const value = amount(it.value);
    const movement = String(account?.movement ?? '').toLowerCase();
    if (!code || value === undefined) return [];
    const customer = obj(it.customer);
    const out: LiveLine = {
      account: code,
      movement: movement === 'credit' ? 'credit' : 'debit',
      value: Math.abs(value),
    };
    const party = clip(customer?.identification, 30);
    if (party) out.party = party;
    const desc = clip(it.description, 200);
    if (desc) out.description = desc;
    const name = clip(account?.name, 80);
    if (name) out.accountName = name;
    return [out];
  });
}

/** Una fila cruda de Siigo → documento común; null si no alcanza (sin id o fecha). */
export function normalizeSiigoLiveDoc(resource: LiveResource, r: Raw): LiveDoc | null {
  const id = clip(r.id, 120);
  const date = day(r.date);
  if (!id || !date) return null;
  const currency = currencyCode(obj(r.currency)?.code) ?? 'COP';
  const number = docName(r);
  const base = { id, number, date, currency };

  if (resource === 'comprobantes') {
    const lines = journalLines(r);
    const total = lines.filter((l) => l.movement === 'debit').reduce((s, l) => s + l.value, 0);
    return { ...base, total: Math.round(total * 100) / 100, note: clip(r.observations, 300), lines };
  }
  if (resource === 'recibos_caja' || resource === 'pagos') {
    const customer = obj(r.customer) ?? obj(r.supplier);
    const lines = journalLines(r);
    const paid = amount(obj(r.payment)?.value);
    const dueSum = arr(r.items).reduce((s, it) => s + (amount(it.value) ?? 0), 0);
    return {
      ...base,
      partyId: clip(customer?.identification, 30),
      partyName: clip(customer?.name, 200),
      total: paid ?? amount(r.total) ?? dueSum,
      note: clip(r.observations, 300),
      lines,
    };
  }
  const party = obj(r.customer) ?? obj(r.supplier);
  const total = amount(r.total);
  if (total === undefined) return null;
  const balance = amount(r.balance);
  const dues = arr(r.payments)
    .map((p) => day(p.due_date))
    .filter((d): d is string => Boolean(d))
    .sort();
  return {
    ...base,
    partyId: clip(party?.identification, 30),
    partyName: clip(party?.name, 200),
    total,
    balance,
    status: statusOf(r, balance),
    dueDate: dues[dues.length - 1],
    note: clip(r.observations, 300),
    lines: itemLines(r),
  };
}

const isSupport = (name: string) => /^DS/i.test(name.trim());
const isEgress = (name: string) => /^CE/i.test(name.trim());

/** ¿Este documento pertenece al recurso pedido? (compras vs soporte, recibos vs egresos). */
export function belongsToResource(resource: LiveResource, doc: LiveDoc): boolean {
  if (resource === 'compras') return !isSupport(doc.number);
  if (resource === 'documento_soporte') return isSupport(doc.number);
  if (resource === 'pagos') return isEgress(doc.number);
  if (resource === 'recibos_caja') return !isEgress(doc.number);
  return true;
}

export function normalizeSiigoRecord(resource: LiveResource, r: Raw): LiveRecord | null {
  const id = clip(r.id, 120) ?? clip(r.code, 60);
  if (!id) return null;
  if (resource === 'terceros') {
    const name = Array.isArray(r.name) ? r.name.filter(Boolean).join(' ') : clip(r.name, 200);
    const ident = clip(r.identification, 30);
    const type = r.type === 'Supplier' ? 'Proveedor' : r.type === 'Other' ? 'Otro' : 'Cliente';
    const city = obj(obj(r.address)?.city);
    const email = arr(r.contacts).find((c) => c.email)?.email;
    return {
      id,
      title: `${clip(name, 200) ?? clip(r.commercial_name, 200) ?? 'Sin nombre'}`,
      detail: [type, ident ? `NIT/CC ${ident}${r.check_digit ? `-${r.check_digit}` : ''}` : null, clip(city?.city_name, 60), clip(email, 80), r.active === false ? 'inactivo' : null]
        .filter(Boolean)
        .join(' · '),
    };
  }
  if (resource === 'productos') {
    const price = arr(r.prices)[0]?.price_list;
    const first = Array.isArray(price) ? amount((price[0] as Raw | undefined)?.value) : undefined;
    const qty = amount(r.available_quantity);
    return {
      id,
      title: `${clip(r.code, 60) ?? ''} ${clip(r.name, 160) ?? ''}`.trim(),
      detail: [
        clip(r.type, 30),
        first !== undefined ? `precio ${first}` : null,
        qty !== undefined ? `existencias ${qty}` : null,
        clip(obj(r.account_group)?.name, 60),
        r.active === false ? 'inactivo' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  if (resource === 'impuestos') {
    const pct = amount(r.percentage);
    return {
      id,
      title: clip(r.name, 120) ?? id,
      detail: [clip(r.type, 40), pct !== undefined ? `${pct}%` : null, r.active === false ? 'inactivo' : null]
        .filter(Boolean)
        .join(' · '),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Leer de Siigo
// ---------------------------------------------------------------------------

function serverQuery(req: LiveRequest): Record<string, string | undefined> {
  const q: Record<string, string | undefined> = { date_start: req.from, date_end: req.to };
  const digitsOnly = (req.party ?? '').replace(/[\s.\-]/g, '');
  if (/^\d{5,}$/.test(digitsOnly) && (req.resource === 'facturas_venta' || req.resource === 'notas_credito'))
    q.customer_identification = digitsOnly;
  if (req.number && /^[A-Za-z]{1,6}-\d+-\d+$/.test(req.number.trim()) && (req.resource === 'facturas_venta' || req.resource === 'notas_credito'))
    q.name = req.number.trim();
  return q;
}

export async function siigoLive(
  client: Pick<SiigoClient, 'page' | 'get'>,
  req: LiveRequest,
  runtime: { now?: () => number } = {},
): Promise<LiveResult> {
  const now = runtime.now ?? Date.now;
  const started = now();
  const resource = req.resource;
  const base: LiveResult = {
    provider: 'Siigo',
    resource,
    currency: 'COP',
    docs: [],
    records: [],
    trial: [],
    groups: [],
    totals: { count: 0, total: 0, balance: null },
    scanned: 0,
    reported: null,
    partial: false,
    notes: [],
  };

  if (resource === 'impuestos') {
    const body = await client.get<unknown>('/v1/taxes');
    const rows = Array.isArray(body) ? (body as Raw[]) : arr(obj(body)?.results);
    base.records = rows.map((r) => normalizeSiigoRecord('impuestos', r)).filter((x): x is LiveRecord => x !== null);
    base.scanned = rows.length;
    return base;
  }

  const path = PATH[resource];
  if (!path) throw new Error('Ese recurso no se lee por esta vía.');
  const maxDocs = Math.min(Math.max(req.maxDocuments ?? DEFAULT_MAX_DOCS, 100), HARD_MAX_DOCS);

  // Terceros y productos: filas planas.
  if (resource === 'terceros' || resource === 'productos') {
    const q: Record<string, string | undefined> = {};
    const digitsOnly = (req.party ?? '').replace(/[\s.\-]/g, '');
    if (resource === 'terceros' && /^\d{5,}$/.test(digitsOnly)) q.identification = digitsOnly;
    const needle = (req.party ?? '').trim().toLowerCase();
    const wantRel = req.relationship ?? 'todos';
    let fetched = 0;
    let page = 1;
    for (;;) {
      const res = await client.page<Raw>(path, q, page);
      base.reported = res.total;
      fetched += res.results.length;
      for (const r of res.results) {
        if (resource === 'terceros') {
          if (wantRel === 'cliente' && r.type === 'Supplier') continue;
          if (wantRel === 'proveedor' && r.type !== 'Supplier') continue;
        }
        const rec = normalizeSiigoRecord(resource, r);
        if (!rec) continue;
        if (needle && !q.identification && !`${rec.title} ${rec.detail}`.toLowerCase().includes(needle)) continue;
        base.records.push(rec);
      }
      if (!hasMorePages(res)) break;
      if (fetched >= maxDocs || now() - started > TIME_BUDGET_MS) {
        base.partial = true;
        break;
      }
      page += 1;
    }
    base.scanned = fetched;
    base.totals = { count: base.records.length, total: 0, balance: null };
    return base;
  }

  // Documentos.
  const query = serverQuery(req);
  const kept: LiveDoc[] = [];
  let fetched = 0;
  let page = 1;
  for (;;) {
    const res = await client.page<Raw>(path, query, page);
    base.reported = res.total;
    fetched += res.results.length;
    for (const raw of res.results) {
      const doc = normalizeSiigoLiveDoc(resource, raw);
      if (!doc || !belongsToResource(resource, doc)) continue;
      if (!docMatches(doc, req)) continue;
      kept.push(doc);
    }
    if (!hasMorePages(res)) break;
    if (fetched >= maxDocs || now() - started > TIME_BUDGET_MS) {
      base.partial = true;
      break;
    }
    page += 1;
  }
  base.scanned = fetched;
  if (resource === 'compras' || resource === 'documento_soporte')
    base.notes.push('Siigo guarda las facturas de proveedor y los documentos soporte en el mismo listado; se separan por el prefijo «DS» del documento.');
  if (resource === 'recibos_caja' || resource === 'pagos')
    base.notes.push('Siigo guarda recibos de caja y comprobantes de egreso en el mismo listado; se separan por el prefijo «CE» del egreso.');

  const docs = kept.map((d) => maskPayroll(trimLinesToAccount(d, req.account), req.canSeePayroll));
  base.docs = docs.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  base.totals = totalsOf(base.docs);
  base.groups = groupDocs(base.docs, req.groupBy ?? 'ninguna', {
    account: req.account,
    level: req.level,
    canSeePayroll: req.canSeePayroll,
  });
  await applyPartyNames(client, base, req);
  return base;
}

/**
 * Siigo no trae el nombre del cliente en facturas, notas ni recibos: sólo su
 * identificación. Se consultan los de más peso (hasta 12 llamadas) para que la
 * persona lea nombres y no números. Si falla, queda la identificación.
 */
export async function applyPartyNames(
  client: Pick<SiigoClient, 'page'>,
  result: LiveResult,
  req: Pick<LiveRequest, 'groupBy' | 'limit'>,
): Promise<void> {
  const ids: string[] = [];
  const add = (id?: string) => {
    if (id && /^\d{4,}$/.test(id) && !ids.includes(id)) ids.push(id);
  };
  if (req.groupBy === 'tercero') for (const g of result.groups.slice(0, NAME_LOOKUPS)) add(g.key);
  else
    for (const d of result.docs.slice(0, req.limit ?? 50))
      if (!d.partyName) add(d.partyId);
  const names = new Map<string, string>();
  for (const id of ids.slice(0, NAME_LOOKUPS)) {
    try {
      const res = await client.page<Raw>('/v1/customers', { identification: id }, 1, 1);
      const c = res.results[0];
      const name = c ? (Array.isArray(c.name) ? c.name.filter(Boolean).join(' ') : clip(c.name, 200)) : undefined;
      const label = clip(name, 200) ?? clip(c?.commercial_name, 200);
      if (label) names.set(id, label);
    } catch {
      break;
    }
  }
  if (!names.size) return;
  for (const d of result.docs) if (!d.partyName && d.partyId && names.has(d.partyId)) d.partyName = names.get(d.partyId);
  for (const g of result.groups) if (names.has(g.key)) g.label = `${names.get(g.key)} (${g.key})`;
}
