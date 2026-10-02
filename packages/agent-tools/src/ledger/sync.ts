import type { SupabaseClient } from '@supabase/supabase-js';
import { ACCOUNTING_PROVIDER_IDS } from '../accounting/types';
import { bogotaToday } from '../commitments/shape';
import { BANK_SYSTEM_PREFIX, accountLabelOf } from '../payments/bank/store';
import { COUNTED_STATES, signedAmount } from '../payments/shape';
import {
  type AccountingInvoiceSource,
  type DocumentInvoiceSource,
  type PaymentReportSource,
  accountingInvoiceDrafts,
  documentDraft,
  documentRef,
  paymentReportDraft,
} from './adapters';
import { type LedgerClassifier, modelClassifier } from './categorize';
import { settlePayablesFromBank } from './payables';
import type { MovementDraft } from './shape';
import { num } from './shape';
import {
  type CategorizeCounts,
  categorizePending,
  ensureAccount,
  listAccounts,
  upsertMovements,
} from './store';

/**
 * TRAER AL LIBRO LO NUEVO DE CADA FUENTE (migración 0172).
 *
 * `syncLedger` es la única puerta por la que las fuentes que ya viven en
 * Cortex llegan al libro de plata. Cada corrida trae sólo lo que cambió desde
 * la anterior (los cursores viven en `ledger_sync_state`) y es idempotente:
 * correrla dos veces seguidas no mueve nada.
 *
 *   PROGRAMA CONTABLE  `accounting_invoices` cambiadas desde el cursor
 *                      (`synced_at`, que el conector pone en cada traída):
 *                      cuentas por cobrar con el saldo del programa, y lo
 *                      cobrado inferido del saldo cuando la conexión no trae
 *                      los pagos (adapters.ts).
 *   PAGOS              `payment_reports` nuevos y los de cada `payments` que
 *                      cambió de estado (una disputa que se resolvió, un pago
 *                      descartado): ingresos ya liquidados, con la llave del
 *                      pago para que el recibo de Siigo y el abono del banco
 *                      cuenten una vez.
 *   BANCO              los abonos de extractos llegan por los mismos reportes
 *                      (con la referencia del extracto); las salidas y el saldo
 *                      llegan en el momento de importar (ledger/bank.ts),
 *                      porque Pagos no las guarda.
 *   DOCUMENTOS         TODAS las facturas confirmadas y clasificadas por cobrar
 *                      o por pagar (0143), en cada corrida: son pocas, y una
 *                      reclasificación no siempre mueve `updated_at`. Lo que
 *                      dejó de calificar se anula en el libro.
 *   FACTURAS POR PAGAR las que una salida del extracto ya pagó quedan
 *                      saldadas, y las que perdieron su salida se reabren
 *                      (payables.ts, 0173).
 *   CATEGORÍAS         lo que quedó sin categoría: reglas, memoria y, con tope,
 *                      el modelo (store.ts › categorizePending).
 *
 * Lo corren el vigilante de cartera cada mañana, cada corrida de un programa
 * contable, y `ledger.query` antes de contestar (sin modelo y como mucho cada
 * 15 minutos). Un paso que falla no tumba a los demás: la corrida queda
 * `partial` con el motivo, y el cursor de ese paso no avanza.
 */

const PAGE = 500;
const MAX_PAGES = 10;
const DOC_SCAN = 2000;

interface Cursor {
  at: string;
  id: string;
}

type Cursors = Partial<Record<'accounting_invoices' | 'payment_reports' | 'payments', Cursor>>;

interface StateRow {
  organization_id: string;
  cursors: Cursors;
  last_run_at: string | null;
}

export interface SyncLedgerOptions {
  today?: string;
  /** El clasificador del modelo; `null` = sólo reglas y memoria. */
  classifier?: LedgerClassifier | null;
  maxModelItems?: number;
  /** No correr si la última corrida fue hace menos de esto. */
  minIntervalMinutes?: number;
  /** Epoch (ms) después del cual no se pide otra página. */
  deadline?: number;
}

export interface SyncLedgerResult {
  status: 'ok' | 'partial' | 'skipped';
  counts: Record<string, number>;
  categorized: CategorizeCounts | null;
  errors: string[];
}

function isAccountingSystem(system: string): boolean {
  return (ACCOUNTING_PROVIDER_IDS as readonly string[]).includes(system);
}

function isBankSystem(system: string): boolean {
  return system.startsWith(BANK_SYSTEM_PREFIX);
}

/** `(col > at) or (col = at and id > id)`: páginas estables aunque muchas filas compartan instante. */
function afterCursor(column: string, cursor: Cursor | undefined): string | null {
  if (!cursor) return null;
  return `${column}.gt.${cursor.at},and(${column}.eq.${cursor.at},id.gt.${cursor.id})`;
}

async function readState(db: SupabaseClient): Promise<StateRow | null> {
  const { data, error } = await db
    .from('ledger_sync_state')
    .select('organization_id, cursors, last_run_at')
    .maybeSingle();
  if (error) throw error;
  return (data as StateRow | null) ?? null;
}

async function clientNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await db
      .from('clients')
      .select('id, name')
      .in('id', unique.slice(i, i + 100));
    if (error) throw error;
    for (const c of (data ?? []) as Array<{ id: string; name: string }>) out.set(c.id, c.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Programa contable
// ---------------------------------------------------------------------------

async function syncAccounting(
  db: SupabaseClient,
  cursors: Cursors,
  ctx: { today: string; deadline: number },
): Promise<{ written: number; done: boolean }> {
  const { data: conns, error: connError } = await db
    .from('accounting_connections')
    .select('provider, entities');
  if (connError) throw connError;
  const brings = new Map<string, boolean>();
  for (const c of (conns ?? []) as Array<{ provider: string; entities: string[] | null }>) {
    brings.set(c.provider, (c.entities ?? []).includes('payments'));
  }

  let written = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > ctx.deadline) return { written, done: false };
    let q = db
      .from('accounting_invoices')
      .select(
        'id, source_system, source_ref, doc_number, client_nit, client_id, counterparty_name, currency, total, balance, issued_on, due_on, annulled, synced_at',
      );
    const after = afterCursor('synced_at', cursors.accounting_invoices);
    if (after) q = q.or(after);
    const { data, error } = await q
      .order('synced_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    const rows = (data ?? []) as Array<AccountingInvoiceSource & { client_id: string | null }>;
    if (!rows.length) return { written, done: true };

    // Lo ya inferido como cobrado, por factura (sólo hace falta sin pagos).
    const needPrior = rows.filter((r) => !brings.get(r.source_system) && !r.annulled);
    const prior = new Map<string, number>();
    const numbers = [...new Set(needPrior.map((r) => r.doc_number))];
    for (let i = 0; i < numbers.length; i += 100) {
      const { data: paid, error: paidError } = await db
        .from('ledger_movements')
        .select('source_system, source_ref, amount')
        .eq('source_kind', 'accounting')
        .like('source_ref', 'paid:%')
        .in('doc_number', numbers.slice(i, i + 100));
      if (paidError) throw paidError;
      for (const p of (paid ?? []) as Array<{
        source_system: string;
        source_ref: string;
        amount: number | string;
      }>) {
        const invoiceRef = p.source_ref.slice('paid:'.length).replace(/:\d+$/, '');
        const key = `${p.source_system}\u0001${invoiceRef}`;
        prior.set(key, (prior.get(key) ?? 0) + (num(p.amount) ?? 0));
      }
    }
    const names = await clientNames(
      db,
      rows.filter((r) => !r.counterparty_name && r.client_id).map((r) => r.client_id as string),
    );
    const drafts: MovementDraft[] = rows.flatMap((r) =>
      accountingInvoiceDrafts(r, {
        bringsPayments: brings.get(r.source_system) ?? false,
        priorPaid: prior.get(`${r.source_system}\u0001${r.source_ref}`) ?? 0,
        today: ctx.today,
        clientName: r.client_id ? (names.get(r.client_id) ?? null) : null,
      }),
    );
    const result = await upsertMovements(db, drafts);
    written += result.inserted.length + result.updated.length;
    const last = rows[rows.length - 1] as AccountingInvoiceSource;
    cursors.accounting_invoices = { at: last.synced_at as string, id: last.id };
    if (rows.length < PAGE) return { written, done: true };
  }
  return { written, done: false };
}

// ---------------------------------------------------------------------------
// Pagos reportados
// ---------------------------------------------------------------------------

const REPORT_COLUMNS =
  'id, payment_id, kind, amount, currency, paid_on, client_nit, invoice_number, reference, note, source_kind, source_system, source_ref, created_at';

async function draftsForReports(
  db: SupabaseClient,
  reports: Array<PaymentReportSource & { created_at: string }>,
): Promise<MovementDraft[]> {
  if (!reports.length) return [];
  const paymentIds = [...new Set(reports.map((r) => r.payment_id).filter(Boolean))] as string[];
  const payments = new Map<string, { state: string; client_id: string | null }>();
  for (let i = 0; i < paymentIds.length; i += 100) {
    const { data, error } = await db
      .from('payments')
      .select('id, state, client_id')
      .in('id', paymentIds.slice(i, i + 100));
    if (error) throw error;
    for (const p of (data ?? []) as Array<{ id: string; state: string; client_id: string | null }>)
      payments.set(p.id, p);
  }
  const names = await clientNames(
    db,
    [...payments.values()].map((p) => p.client_id).filter(Boolean) as string[],
  );

  // Cada extracto tiene su cuenta de caja; la de un extracto importado antes
  // del libro se crea aquí, sin saldo.
  const accounts = new Map<string, string>();
  for (const a of await listAccounts(db)) {
    if (a.source_kind === 'bank' && a.source_system) accounts.set(a.source_system, a.id);
  }
  for (const r of reports) {
    const system = r.source_system ?? '';
    if (r.source_kind !== 'system' || !isBankSystem(system) || accounts.has(system)) continue;
    const label = accountLabelOf(system);
    if (!label) continue;
    const { account } = await ensureAccount(db, {
      name: label,
      currency: r.currency,
      source: { kind: 'bank', system, ref: label },
    });
    accounts.set(system, account.id);
  }

  const out: MovementDraft[] = [];
  for (const r of reports) {
    const payment = r.payment_id ? payments.get(r.payment_id) : undefined;
    const system = r.source_system ?? '';
    const draft = paymentReportDraft(r, {
      paymentState: payment?.state ?? null,
      clientName: payment?.client_id ? (names.get(payment.client_id) ?? null) : null,
      isAccountingSystem,
      isBankSystem,
      accountId: accounts.get(system) ?? null,
    });
    if (!draft) continue;
    // El extracto ya escribió este abono con su contraparte y su cuenta: el
    // reporte sólo pone al día el estado del pago y su llave.
    if (draft.source.kind === 'bank') draft.merge = 'status';
    out.push(draft);
  }
  return out;
}

async function syncPayments(
  db: SupabaseClient,
  cursors: Cursors,
  ctx: { deadline: number },
): Promise<{ written: number; done: boolean }> {
  let written = 0;
  let done = true;
  // Reportes nuevos.
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > ctx.deadline) return { written, done: false };
    let q = db.from('payment_reports').select(REPORT_COLUMNS);
    const after = afterCursor('created_at', cursors.payment_reports);
    if (after) q = q.or(after);
    const { data, error } = await q
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    const rows = (data ?? []) as Array<PaymentReportSource & { created_at: string }>;
    if (!rows.length) break;
    const result = await upsertMovements(db, await draftsForReports(db, rows));
    written += result.inserted.length + result.updated.length;
    const last = rows[rows.length - 1] as { created_at: string; id: string };
    cursors.payment_reports = { at: last.created_at, id: last.id };
    if (rows.length < PAGE) break;
    if (page === MAX_PAGES - 1) done = false;
  }
  // Pagos que cambiaron (estado, factura, cliente): sus reportes otra vez.
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > ctx.deadline) return { written, done: false };
    let q = db.from('payments').select('id, updated_at');
    const after = afterCursor('updated_at', cursors.payments);
    if (after) q = q.or(after);
    const { data, error } = await q
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    const changed = (data ?? []) as Array<{ id: string; updated_at: string }>;
    if (!changed.length) break;
    const reports: Array<PaymentReportSource & { created_at: string }> = [];
    for (let i = 0; i < changed.length; i += 100) {
      const { data: reps, error: repError } = await db
        .from('payment_reports')
        .select(REPORT_COLUMNS)
        .in(
          'payment_id',
          changed.slice(i, i + 100).map((p) => p.id),
        );
      if (repError) throw repError;
      reports.push(...((reps ?? []) as Array<PaymentReportSource & { created_at: string }>));
    }
    const result = await upsertMovements(db, await draftsForReports(db, reports));
    written += result.inserted.length + result.updated.length;
    const last = changed[changed.length - 1] as { updated_at: string; id: string };
    cursors.payments = { at: last.updated_at, id: last.id };
    if (changed.length < PAGE) break;
    if (page === MAX_PAGES - 1) done = false;
  }
  return { written, done };
}

// ---------------------------------------------------------------------------
// Documentos confirmados
// ---------------------------------------------------------------------------

async function syncDocuments(
  db: SupabaseClient,
  today: string,
): Promise<{ written: number; cancelled: number }> {
  const { data, error } = await db
    .from('document_extractions')
    .select(
      'id, doc_type, review_state, financial_role, doc_number, counterparty_nit, counterparty_name, total_amount, currency, issued_on, due_on, created_at',
    )
    .in('financial_role', ['receivable', 'payable'])
    .order('updated_at', { ascending: false })
    .limit(DOC_SCAN);
  if (error) throw error;
  const docs = (data ?? []) as DocumentInvoiceSource[];

  // Lo cobrado de cada factura por cobrar: pagos que cuentan, atados a ella.
  const applied = new Map<string, number>();
  const receivableIds = docs.filter((d) => d.financial_role === 'receivable').map((d) => d.id);
  const currencyOf = new Map(docs.map((d) => [d.id, d.currency]));
  for (let i = 0; i < receivableIds.length; i += 100) {
    const { data: pays, error: payError } = await db
      .from('payments')
      .select('kind, amount, currency, extraction_id')
      .in('extraction_id', receivableIds.slice(i, i + 100))
      .in('state', [...COUNTED_STATES]);
    if (payError) throw payError;
    for (const p of (pays ?? []) as Array<{
      kind: 'payment' | 'reversal' | 'adjustment';
      amount: number | string;
      currency: string;
      extraction_id: string;
    }>) {
      if (currencyOf.get(p.extraction_id) !== p.currency) continue;
      applied.set(
        p.extraction_id,
        (applied.get(p.extraction_id) ?? 0) + signedAmount(p.kind, num(p.amount) ?? 0),
      );
    }
  }

  const drafts: MovementDraft[] = [];
  const qualifying = new Set<string>();
  for (const d of docs) {
    const draft = documentDraft(d, { applied: applied.get(d.id) ?? 0, today });
    if (!draft) continue;
    drafts.push(draft);
    qualifying.add(documentRef(d.id));
  }
  const result = await upsertMovements(db, drafts);

  // Lo que estaba en el libro y ya no califica (rechazado, reclasificado,
  // borrado) queda anulado: no cuenta, y sigue a la vista.
  const { data: inLedger, error: ledgerError } = await db
    .from('ledger_movements')
    .select('id, source_ref')
    .eq('source_kind', 'document')
    .eq('source_system', '')
    .neq('status', 'cancelled')
    .like('source_ref', 'extraction:%')
    .limit(5000);
  if (ledgerError) throw ledgerError;
  const stale = ((inLedger ?? []) as Array<{ id: string; source_ref: string }>).filter(
    (r) => !qualifying.has(r.source_ref),
  );
  // Si el escaneo se cortó por tope, no se anula nada que no se vio.
  const complete = docs.length < DOC_SCAN;
  let cancelled = 0;
  if (complete) {
    for (const r of stale) {
      const { error: e } = await db
        .from('ledger_movements')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', r.id);
      if (e) throw e;
      cancelled += 1;
    }
  }
  return { written: result.inserted.length + result.updated.length, cancelled };
}

// ---------------------------------------------------------------------------
// La corrida
// ---------------------------------------------------------------------------

export async function syncLedger(
  db: SupabaseClient,
  organizationId: string,
  opts: SyncLedgerOptions = {},
): Promise<SyncLedgerResult> {
  const today = opts.today ?? bogotaToday();
  const deadline = opts.deadline ?? Date.now() + 4 * 60_000;
  const state = await readState(db);
  if (
    opts.minIntervalMinutes &&
    state?.last_run_at &&
    Date.now() - Date.parse(state.last_run_at) < opts.minIntervalMinutes * 60_000
  ) {
    return { status: 'skipped', counts: {}, categorized: null, errors: [] };
  }
  const cursors: Cursors = { ...(state?.cursors ?? {}) };
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  let partial = false;

  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      partial = true;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
    }
  };

  await step('programa contable', async () => {
    const r = await syncAccounting(db, cursors, { today, deadline });
    counts.accounting = r.written;
    if (!r.done) partial = true;
  });
  await step('pagos', async () => {
    const r = await syncPayments(db, cursors, { deadline });
    counts.payments = r.written;
    if (!r.done) partial = true;
  });
  await step('documentos', async () => {
    const r = await syncDocuments(db, today);
    counts.documents = r.written;
    counts.documents_cancelled = r.cancelled;
  });
  await step('facturas por pagar', async () => {
    const r = await settlePayablesFromBank(db);
    counts.payables_settled = r.settled;
    counts.payables_reopened = r.reopened;
  });
  let categorized: CategorizeCounts | null = null;
  await step('categorías', async () => {
    categorized = await categorizePending(db, {
      classifier: opts.classifier === undefined ? modelClassifier : opts.classifier,
      maxModelItems: opts.maxModelItems,
    });
  });

  const now = new Date().toISOString();
  const row = {
    organization_id: organizationId,
    cursors,
    last_run_at: now,
    last_status: partial ? (errors.length ? 'error' : 'partial') : 'ok',
    last_error: errors.length ? errors.join(' · ').slice(0, 500) : null,
    last_counts: counts,
    updated_at: now,
  };
  const { error } = await db
    .from('ledger_sync_state')
    .upsert(row, { onConflict: 'organization_id' });
  if (error) errors.push(`estado: ${error.message}`.slice(0, 200));
  return { status: partial ? 'partial' : 'ok', counts, categorized, errors };
}
