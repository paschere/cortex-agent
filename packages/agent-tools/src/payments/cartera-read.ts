import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeNit } from '../clients/shape';
import { bogotaToday } from '../commitments/shape';
import {
  type CarteraCreditNoteIn,
  type CarteraInvoiceIn,
  type CarteraModel,
  type CarteraPaymentIn,
  buildCartera,
  carteraNameKey,
  docKey,
} from './cartera';
import { COUNTED_STATES } from './shape';
import {
  type ConfirmedRef,
  dedupeAccountingInvoices,
  hydratePayments,
  listPayments,
} from './store';

/**
 * LEER LO QUE LA PANTALLA DE CARTERA NECESITA y dárselo a `buildCartera`.
 *
 * Sólo lee. Las fuentes, por orden de peso:
 *   - `accounting_invoices`   facturas de Siigo con SU saldo (ya neto de recibos,
 *                             cruces de anticipos y notas crédito).
 *   - `document_extractions`  facturas subidas y confirmadas por una persona; su
 *                             saldo es total menos los pagos atados a ellas.
 *   - `payments`              los recibos (con el número del recibo, que vive en
 *                             el reporte).
 *   - tablas sincronizadas    `siigo_notas_credito`, `siigo_pagos` (cuáles son
 *                             anticipos), `siigo_movimientos_contables` (cruces
 *                             de anticipos, cuentas 2805/1305) y
 *                             `siigo_saldos_terceros` cuando ya llegaron. Si no
 *                             existen la pantalla sigue, sólo sin ese dato.
 *
 * Cada lectura opcional va en su propio try: un dato de más que falla no puede
 * tumbar la cartera.
 */

const PAGE = 1000;
const MAX_ROWS = 20_000;

type Row = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: un filtro de PostgREST encadenable, sin tipo público estable
type Apply = (q: any) => any;

async function allRows(
  db: SupabaseClient,
  table: string,
  columns: string,
  apply: Apply,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const q = apply(db.from(table).select(columns)).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function trackerId(db: SupabaseClient, slug: string): Promise<string | null> {
  try {
    const { data } = await db.from('trackers').select('id').eq('slug', slug).maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

async function trackerValues(
  db: SupabaseClient,
  slug: string,
  apply: Apply = (q) => q,
): Promise<Array<Record<string, unknown>> | null> {
  const id = await trackerId(db, slug);
  if (!id) return null;
  try {
    const rows = await allRows(db, 'tracker_rows', 'values', (q) => apply(q.eq('tracker_id', id)));
    return rows.map((r) => (r.values ?? {}) as Record<string, unknown>);
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface ReadCarteraOptions {
  today?: string;
  /** «¿Y si las facturas sin plazo se cobraran a N días?». */
  defaultTermDays?: number | null;
}

export async function readCartera(
  db: SupabaseClient,
  opts: ReadCarteraOptions = {},
): Promise<CarteraModel> {
  const today = opts.today ?? bogotaToday();

  // --- clientes: para unir a la misma persona venga por id, NIT o nombre ------
  const clientRows = await allRows(
    db,
    'clients',
    'id, name, tax_id, payment_terms_days',
    (q) => q,
  ).catch(() => [] as Row[]);
  const byId = new Map<string, { name: string; term: number | null }>();
  const byNit = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const c of clientRows) {
    const id = str(c.id);
    byId.set(id, {
      name: str(c.name),
      term: c.payment_terms_days ? numOf(c.payment_terms_days) : null,
    });
    const nit = normalizeNit(str(c.tax_id));
    if (nit) byNit.set(nit, id);
    byName.set(carteraNameKey(str(c.name)), id);
  }

  const resolve = (ref: { id?: string | null; nit?: string | null; name?: string | null }) => {
    if (ref.id && byId.has(ref.id)) return ref.id;
    const nit = normalizeNit(ref.nit);
    if (nit) {
      const exact = byNit.get(nit) ?? byNit.get(nit.slice(0, -1));
      if (exact) return exact;
    }
    const nk = carteraNameKey(ref.name);
    if (nk && byName.has(nk)) return byName.get(nk) as string;
    if (nit) return `nit:${nit.length > 9 ? nit.slice(0, -1) : nit}`;
    if (nk) return `name:${nk}`;
    return null;
  };
  const nameOf = (key: string | null, fallback: string | null | undefined) =>
    (key ? byId.get(key)?.name : null) ?? fallback ?? 'Sin cliente identificado';

  // --- facturas -----------------------------------------------------------
  const accountingRows = await allRows(
    db,
    'accounting_invoices',
    'id, source_system, doc_number, client_id, client_nit, counterparty_name, currency, total, balance, issued_on, due_on, public_url',
    (q) => q.eq('annulled', false),
  );
  const accounting = accountingRows.map((r) => ({
    id: str(r.id),
    source_system: str(r.source_system),
    doc_number: str(r.doc_number),
    client_id: (r.client_id as string | null) ?? null,
    client_nit: (r.client_nit as string | null) ?? null,
    counterparty_name: (r.counterparty_name as string | null) ?? null,
    currency: str(r.currency),
    total: numOf(r.total),
    balance: numOf(r.balance),
    issued_on: (r.issued_on as string | null) ?? null,
    due_on: (r.due_on as string | null) ?? null,
    public_url: (r.public_url as string | null) ?? null,
  }));

  // Las facturas que además existen como documento confirmado cuentan UNA vez.
  let documents: Row[] = [];
  try {
    documents = await allRows(
      db,
      'document_extractions',
      'id, doc_number, client_id, counterparty_nit, counterparty_name, total_amount, currency, issued_on, due_on',
      (q) =>
        q
          .eq('review_state', 'confirmed')
          .eq('doc_type', 'invoice')
          .eq('financial_role', 'receivable'),
    );
  } catch {
    documents = [];
  }
  const confirmed: ConfirmedRef[] = documents
    .map((d) => ({
      key: docKey(str(d.doc_number)),
      clientId: (d.client_id as string | null) ?? null,
      nit: d.counterparty_nit ? normalizeNit(str(d.counterparty_nit)) : null,
    }))
    .filter((r) => r.key);
  const kept = dedupeAccountingInvoices(accounting, confirmed);

  // Pagos (todos los que cuentan) y el número de cada recibo.
  const paymentRows = await hydratePayments(
    db,
    await listPayments(db, { state: [...COUNTED_STATES], limit: 1000 }),
  );
  const references = new Map<string, string>();
  const ids = paymentRows.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 200) {
    try {
      const { data } = await db
        .from('payment_reports')
        .select('payment_id, reference')
        .in('payment_id', ids.slice(i, i + 200));
      for (const r of (data ?? []) as Array<{ payment_id: string; reference: string | null }>)
        if (r.reference && !references.has(r.payment_id)) references.set(r.payment_id, r.reference);
    } catch {
      // sin reportes, el número del recibo queda vacío
    }
  }

  const appliedToDocument = new Map<string, number>();
  for (const p of paymentRows) {
    if (!p.extraction_id) continue;
    const sign = p.kind === 'reversal' ? -1 : 1;
    appliedToDocument.set(
      p.extraction_id,
      (appliedToDocument.get(p.extraction_id) ?? 0) + sign * numOf(p.amount),
    );
  }

  const invoices: CarteraInvoiceIn[] = [];
  const termDays: Record<string, number> = {};
  const nitToKey = new Map<string, string>();
  for (const a of kept) {
    if (!a.issued_on) continue;
    const key = resolve({ id: a.client_id, nit: a.client_nit, name: a.counterparty_name });
    if (!key) continue;
    if (a.client_nit) nitToKey.set(normalizeNit(a.client_nit), key);
    invoices.push({
      id: a.id,
      kind: 'accounting',
      docNumber: a.doc_number,
      clientKey: key,
      clientId: byId.has(key) ? key : null,
      clientName: nameOf(key, a.counterparty_name),
      currency: a.currency,
      total: a.total,
      balance: a.balance,
      issuedOn: a.issued_on,
      dueOn: a.due_on,
      url: a.public_url,
    });
  }
  for (const d of documents) {
    const total = numOf(d.total_amount);
    const currency = str(d.currency);
    const issuedOn = str(d.issued_on);
    if (!total || !currency || !issuedOn) continue;
    const key = resolve({
      id: d.client_id as string | null,
      nit: d.counterparty_nit as string | null,
      name: d.counterparty_name as string | null,
    });
    if (!key) continue;
    invoices.push({
      id: str(d.id),
      kind: 'document',
      docNumber: str(d.doc_number) || 'Sin número',
      clientKey: key,
      clientId: byId.has(key) ? key : null,
      clientName: nameOf(key, str(d.counterparty_name)),
      currency,
      total,
      balance: Math.max(total - (appliedToDocument.get(str(d.id)) ?? 0), 0),
      issuedOn,
      dueOn: (d.due_on as string | null) ?? null,
    });
  }
  for (const [id, c] of byId) if (c.term && c.term > 0) termDays[id] = c.term;

  const payments: CarteraPaymentIn[] = paymentRows.map((p) => {
    const key = resolve({ id: p.client_id, nit: p.client_nit, name: p.client_name });
    return {
      id: p.id,
      kind: p.kind,
      amount: numOf(p.amount),
      currency: p.currency,
      paidOn: String(p.paid_on).slice(0, 10),
      clientKey: key,
      clientName: key ? nameOf(key, p.client_name) : null,
      invoiceNumber: p.invoice_number,
      reference: references.get(p.id) ?? null,
      state: p.state,
    };
  });

  // --- lo que sólo dicen las tablas sincronizadas ---------------------------
  const notes = (await trackerValues(db, 'siigo_notas_credito')) ?? [];
  const creditNotes: CarteraCreditNoteIn[] = notes
    .filter((n) => numOf(n.valor) > 0 && str(n.fecha))
    .map((n) => {
      const key = resolve({ nit: str(n.nit), name: str(n.cliente) });
      return {
        number: str(n.numero),
        invoiceNumber: str(n.factura) || null,
        amount: numOf(n.valor),
        date: str(n.fecha).slice(0, 10),
        clientKey: key,
        clientName: key ? nameOf(key, str(n.cliente)) : null,
      };
    });

  const receipts = (await trackerValues(db, 'siigo_pagos')) ?? [];
  const advanceReceipts = receipts
    .filter((r) => str(r.tipo) === 'Anticipo')
    .map((r) => str(r.numero))
    .filter(Boolean);

  // Cruces de anticipos (2805 al débito) y abonos a la cartera (1305 al crédito).
  const advanceCrossedByClient: Record<string, number> = {};
  const receivableCredits: Array<{ date: string; amount: number }> = [];
  const advanceRows = await trackerValues(db, 'siigo_movimientos_contables', (q) =>
    q.like('values->>cuenta', '2805%'),
  );
  const receivableRows = await trackerValues(db, 'siigo_movimientos_contables', (q) =>
    q.like('values->>cuenta', '1305%'),
  );
  const crossRows =
    advanceRows || receivableRows ? [...(advanceRows ?? []), ...(receivableRows ?? [])] : null;
  if (crossRows) {
    for (const m of crossRows) {
      const cuenta = str(m.cuenta);
      if (cuenta.startsWith('2805')) {
        const key = resolve({ name: str(m.tercero) });
        if (key) advanceCrossedByClient[key] = (advanceCrossedByClient[key] ?? 0) + numOf(m.debito);
      } else if (cuenta.startsWith('1305') && numOf(m.credito) > 0 && str(m.fecha)) {
        receivableCredits.push({ date: str(m.fecha).slice(0, 10), amount: numOf(m.credito) });
      }
    }
  }

  // Saldos por tercero: el último mes que traiga la cuenta 1305.
  let balance1305ByClient: Record<string, number> | undefined;
  let balancePeriod: string | null = null;
  const parties = await trackerValues(db, 'siigo_saldos_terceros', (q) =>
    q.like('values->>cuenta', '1305%'),
  );
  if (parties?.length) {
    balancePeriod =
      parties
        .map((p) => str(p.periodo))
        .sort()
        .at(-1) ?? null;
    balance1305ByClient = {};
    for (const p of parties) {
      if (str(p.periodo) !== balancePeriod) continue;
      const key = resolve({ nit: str(p.nit_tercero), name: str(p.tercero) });
      if (!key) continue;
      balance1305ByClient[key] = (balance1305ByClient[key] ?? 0) + numOf(p.saldo_final);
    }
  }

  return buildCartera({
    today,
    invoices,
    payments,
    creditNotes,
    advanceReceipts,
    termDays,
    defaultTermDays: opts.defaultTermDays ?? null,
    ledger: {
      advanceCrossedByClient: crossRows ? advanceCrossedByClient : undefined,
      receivableCredits,
      balance1305ByClient,
      balancePeriod,
    },
  });
}
