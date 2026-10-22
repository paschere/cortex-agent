import type { SupabaseClient } from '@supabase/supabase-js';
import { type CombineResult, combineRecords, resolveSheetBalances } from './combine';
import type { Difference, OriginSummary } from './combine';
import { type AccRecord, type RowIssue, type SourceKind, isInvoiceKind } from './shape';
import { type LoadedBatch, loadSourceBatches } from './store';

/**
 * LEER LAS FUENTES COMBINADAS (0239) para quien las necesita: las fuentes de
 * plataforma de vistas, la cartera, los resultados mensuales, Hoy y el chat.
 * Siempre entran por aquí para que todas las pantallas cuenten lo mismo.
 */

/** Lo que una pantalla muestra de dónde salen sus totales. Sólo datos simples. */
export interface CombinedSummary {
  kind: SourceKind;
  origins: OriginSummary[];
  /** Cuántos registros de las hojas ya estaban en otra fuente. */
  overlaps: number;
  differences: Difference[];
  differenceCount: number;
  issues: RowIssue[];
  issueCount: number;
  rejectedCount: number;
  /** Cuántas hojas/tablas alimentan este tipo. */
  sheetCount: number;
}

const SUMMARY_CAP = 12;

export function summarize(kind: SourceKind, r: CombineResult): CombinedSummary {
  const rank = (i: RowIssue) => (i.severity === 'rechazada' ? 0 : 1);
  const sorted = [...r.issues].sort((a, b) => rank(a) - rank(b));
  return {
    kind,
    origins: r.origins,
    overlaps: r.overlaps,
    differences: r.differences.slice(0, SUMMARY_CAP),
    differenceCount: new Set(r.differences.map((d) => `${d.kind}|${d.number}`)).size,
    issues: sorted.slice(0, SUMMARY_CAP),
    issueCount: r.issues.length,
    rejectedCount: r.issues.filter((i) => i.severity === 'rechazada').length,
    sheetCount: new Set(r.records.filter((x) => x.sourceId !== 'base').map((x) => x.sourceId)).size,
  };
}

export interface CombinedKind {
  result: CombineResult;
  summary: CombinedSummary;
  /** Las fuentes de hoja declaradas para el tipo (aunque no hayan aportado filas). */
  batches: LoadedBatch[];
}

/**
 * Combina `base` (programa contable + documentos confirmados, ya como
 * registros) con las hojas declaradas. Para facturas resuelve primero el saldo
 * de las hojas que no lo traen, con los pagos de las hojas del tipo opuesto.
 * `sheetPayments`: los pagos de las hojas que dicen a qué factura pagan.
 */
export async function combineKind(
  db: SupabaseClient,
  kind: SourceKind,
  base: readonly AccRecord[],
  opts: { sheetPayments?: readonly AccRecord[] } = {},
): Promise<CombinedKind> {
  let batches: LoadedBatch[] = [];
  try {
    batches = await loadSourceBatches(db, kind);
  } catch {
    batches = [];
  }
  if (isInvoiceKind(kind) && batches.length) {
    const payKind: SourceKind = kind === 'ventas' ? 'pagos_recibidos' : 'pagos_proveedores';
    let payments = opts.sheetPayments;
    if (!payments) {
      try {
        payments = (await loadSourceBatches(db, payKind)).flatMap((b) => b.records);
      } catch {
        payments = [];
      }
    }
    for (const b of batches) {
      const r = resolveSheetBalances(b.records, payments);
      b.records = r.records;
      b.issues = [...b.issues, ...r.issues];
    }
  }
  const result = combineRecords(kind, base, batches);
  return { result, summary: summarize(kind, result), batches };
}

export const BASE_SOURCE_ID = 'base';

/** El registro de lo que ya trae el programa contable o un documento confirmado. */
export function baseRecord(
  kind: SourceKind,
  r: {
    rowId: string;
    origin: string;
    number: string;
    date: string | null;
    due?: string | null;
    nit?: string | null;
    party?: string | null;
    total: number;
    balance?: number | null;
    tax?: number | null;
    currency: string;
    invoiceRef?: string | null;
  },
): AccRecord {
  return {
    kind,
    sourceId: BASE_SOURCE_ID,
    origin: r.origin,
    rowId: r.rowId,
    number: r.number,
    date: (r.date ?? '').slice(0, 10),
    due: r.due ? r.due.slice(0, 10) : null,
    nit: normalizeBaseNit(r.nit),
    party: r.party ?? '',
    total: r.total,
    tax: r.tax ?? null,
    balance: r.balance ?? null,
    currency: r.currency || 'COP',
    trm: null,
    totalCop: r.currency === 'COP' ? r.total : null,
    costCenter: null,
    account: null,
    concept: null,
    invoiceRef: r.invoiceRef ?? null,
    debit: null,
    credit: null,
    creditNote: false,
  };
}

/** El NIT guardado puede traer DV (10 dígitos): se compara sin él, igual que en la cartera. */
function normalizeBaseNit(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length > 9 ? d.slice(0, -1) : d;
}

export function originName(system: string): string {
  return system === 'siigo'
    ? 'Siigo'
    : system === 'alegra'
      ? 'Alegra'
      : system === 'quickbooks'
        ? 'QuickBooks'
        : system;
}

const PAGE = 1000;
type Row = Record<string, unknown>;

async function pageAll(
  db: SupabaseClient,
  table: string,
  columns: string,
  // biome-ignore lint/suspicious/noExplicitAny: filtro encadenable de PostgREST, sin tipo público estable
  apply: (q: any) => any,
  max = 20_000,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await apply(db.from(table).select(columns)).range(
      from,
      from + PAGE - 1,
    );
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const n = (v: unknown) => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Lo que ya está en Cortex para un tipo, como registros: ventas = facturas del
 * programa contable + documentos confirmados (sin repetir); compras = facturas
 * de proveedor del libro de pagos. Sirve donde no hay una lectura propia
 * (resultados mensuales, el chat).
 */
export async function loadBaseRecords(db: SupabaseClient, kind: SourceKind): Promise<AccRecord[]> {
  const out: AccRecord[] = [];
  if (kind === 'ventas') {
    const docs = await pageAll(
      db,
      'document_extractions',
      'id, doc_number, counterparty_nit, counterparty_name, total_amount, tax_amount, currency, issued_on, due_on',
      (q) =>
        q
          .eq('review_state', 'confirmed')
          .eq('doc_type', 'invoice')
          .eq('financial_role', 'receivable'),
    ).catch(() => [] as Row[]);
    const seen = new Set<string>();
    for (const d of docs) {
      if (!d.issued_on || !d.total_amount) continue;
      const rec = baseRecord('ventas', {
        rowId: s(d.id),
        origin: 'Documento leído',
        number: s(d.doc_number),
        date: s(d.issued_on),
        due: d.due_on ? s(d.due_on) : null,
        nit: s(d.counterparty_nit),
        party: s(d.counterparty_name),
        total: n(d.total_amount),
        tax: d.tax_amount === null ? null : n(d.tax_amount),
        currency: s(d.currency) || 'COP',
      });
      seen.add(`${rec.number.toUpperCase().replace(/[^A-Z0-9]/g, '')}|${rec.nit}`);
      out.push(rec);
    }
    const acc = await pageAll(
      db,
      'accounting_invoices',
      'id, source_system, doc_number, client_nit, counterparty_name, currency, total, balance, issued_on, due_on',
      (q) => q.eq('annulled', false),
    ).catch(() => [] as Row[]);
    for (const a of acc) {
      const rec = baseRecord('ventas', {
        rowId: s(a.id),
        origin: originName(s(a.source_system)),
        number: s(a.doc_number),
        date: s(a.issued_on),
        due: a.due_on ? s(a.due_on) : null,
        nit: s(a.client_nit),
        party: s(a.counterparty_name),
        total: n(a.total),
        balance: n(a.balance),
        currency: s(a.currency) || 'COP',
      });
      if (seen.has(`${rec.number.toUpperCase().replace(/[^A-Z0-9]/g, '')}|${rec.nit}`)) continue;
      out.push(rec);
    }
  } else if (kind === 'compras') {
    const rows = await pageAll(
      db,
      'payable_invoices',
      'id, supplier_nit, supplier_name, doc_number, currency, issue_date, due_date, total, iva, status, source_system',
      (q) => q,
    ).catch(() => [] as Row[]);
    for (const r of rows) {
      if (!r.issue_date) continue;
      out.push(
        baseRecord('compras', {
          rowId: s(r.id),
          origin: r.source_system ? originName(s(r.source_system)) : 'Cortex',
          number: s(r.doc_number),
          date: s(r.issue_date),
          due: r.due_date ? s(r.due_date) : null,
          nit: s(r.supplier_nit),
          party: s(r.supplier_name),
          total: n(r.total),
          // Lo abierto debe; lo pagado o rechazado ya no (así «por pagar» no suma lo cerrado).
          balance: ['pagada', 'rechazada'].includes(s(r.status)) ? 0 : n(r.total),
          tax: n(r.iva),
          currency: s(r.currency) || 'COP',
        }),
      );
    }
  }
  return out;
}
