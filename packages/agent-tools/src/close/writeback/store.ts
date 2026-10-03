import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AccountingConnectionRow,
  listAccountingConnections,
  openAccountingSession,
  requestAccountingSync,
} from '../../accounting/store';
import {
  type ProviderSession,
  ProviderUncertainError,
  ProviderValidationError,
} from '../../accounting/types';
import { isCompanyManager } from '../../directory/store';
import { PAYABLE_COLUMNS, type PayableInvoiceRow, adaptPayable } from '../../payables/shape';
import { BANK_SYSTEM_PREFIX } from '../../payments/bank/store';
import { assertPeriodOpen } from '../lock';
import { periodEnd, periodStart } from '../shape';
import { AccountMap, type AccountMapRow, type MapScope, validateMapRow } from './mapping';
import {
  PROVIDER_LABEL,
  type PurchaseSource,
  type ReceiptSource,
  type SupplierPaymentSource,
  type WritebackKind,
  type WritebackPreview,
  type WritebackProvider,
  type WritebackSource,
  type WritebackStatus,
  commonProblems,
  defaultAccountWarnings,
  entriesFor,
  round2,
  sourceAmount,
  sourceCounterparty,
  sourceDate,
  sourceLabel,
  writebackIdempotencyKey,
} from './shape';

/**
 * REGISTRAR EN EL PROGRAMA CONTABLE: LA BASE (migración 0192).
 *
 * El orden de una escritura, el mismo de la factura electrónica (sales/emit.ts):
 *
 *   1. De Cortex sale el documento de origen: una factura de proveedor
 *      aprobada (compra), un abono del banco atado a una factura de venta
 *      (recibo), una factura de proveedor que el banco ya pagó (pago).
 *   2. La vista previa: la partida en débitos y créditos con las cuentas del
 *      plan de la empresa (mapping.ts), y lo que el programa pide (catálogos,
 *      tercero por NIT). Con un solo problema no se manda nada.
 *   3. La toma: una fila por (empresa, clase, origen) pasa a `enviando` con
 *      compare-and-swap. Dos clics o dos personas no mandan dos documentos.
 *   4. POST con la llave de (empresa, clase, origen). Si la red se corta,
 *      `incierta`: no se repite sola; quien repite dice que ya revisó, y antes
 *      se busca en el programa (`find`) por si sí llegó.
 *   5. Lo que volvió (id, número) queda en la fila, y se pide una
 *      sincronización del programa para que todo vuelva a Cortex por el
 *      camino de siempre.
 *
 * El mes del documento no puede estar cerrado (lock.ts). La aprobación de una
 * persona la exigen las herramientas (`accounting.write_*`, confirmación
 * obligatoria) y la pantalla (/cierre, botón con la vista previa delante).
 */

const WRITABLE = new Set<WritebackProvider>(['siigo', 'alegra', 'quickbooks']);
const STUCK_MS = 10 * 60_000;
const SCAN = 2000;

export const WRITEBACK_COLUMNS =
  'id, kind, source_table, source_id, provider, connection_id, status, doc_date, amount, currency, counterparty_name, label, payload, preview, idempotency_key, provider_id, provider_number, provider_status, error, attempts, attempted_at, registered_at, reconciled_at, approved_by, discarded_by, discard_reason, created_by, created_at, updated_at';

export interface WritebackRow {
  id: string;
  kind: WritebackKind;
  source_table: 'payable_invoices' | 'payments';
  source_id: string;
  provider: WritebackProvider;
  connection_id: string | null;
  status: WritebackStatus;
  doc_date: string;
  amount: number | string | null;
  currency: string | null;
  counterparty_name: string | null;
  label: string;
  payload: Record<string, unknown> | null;
  preview: Record<string, unknown> | null;
  idempotency_key: string;
  provider_id: string | null;
  provider_number: string | null;
  provider_status: string | null;
  error: string | null;
  attempts: number;
  attempted_at: string | null;
  registered_at: string | null;
  reconciled_at: string | null;
  approved_by: string | null;
  discarded_by: string | null;
  discard_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// El plan de cuentas
// ---------------------------------------------------------------------------

const MAP_COLUMNS =
  'id, scope, key, account_code, account_name, cost_center, provider_refs, updated_at';

export async function loadAccountMap(db: SupabaseClient): Promise<AccountMap> {
  const { data, error } = await db.from('accounting_account_map').select(MAP_COLUMNS).limit(2000);
  if (error) throw error;
  return new AccountMap((data ?? []) as AccountMapRow[]);
}

export async function saveAccountMapRow(
  db: SupabaseClient,
  input: {
    scope: MapScope;
    key: string;
    accountCode: string;
    accountName?: string | null;
    costCenter?: string | null;
    providerRefs?: Partial<Record<'alegra' | 'quickbooks' | 'siigo', string>>;
  },
  opts: { userId: string },
): Promise<void> {
  if (!(await isCompanyManager(db, opts.userId)))
    throw new ForbiddenError('Sólo un administrador o dueño cambia el plan de cuentas.');
  const problem = validateMapRow(input);
  if (problem) throw new ValidationError(problem);
  const refs: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.providerRefs ?? {}))
    if (v && /^[A-Za-z0-9_-]{1,60}$/.test(v.trim())) refs[k] = v.trim();
  const { error } = await db.from('accounting_account_map').upsert(
    {
      scope: input.scope,
      key: input.key.trim().slice(0, 120),
      account_code: input.accountCode.trim(),
      account_name: input.accountName?.trim().slice(0, 160) || null,
      cost_center: input.costCenter?.trim().slice(0, 40) || null,
      provider_refs: refs,
      updated_by: opts.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,scope,key' },
  );
  if (error) throw error;
}

/** Volver al defecto de Cortex: borra la fila de la empresa. */
export async function resetAccountMapRow(
  db: SupabaseClient,
  input: { scope: MapScope; key: string },
  opts: { userId: string },
): Promise<void> {
  if (!(await isCompanyManager(db, opts.userId)))
    throw new ForbiddenError('Sólo un administrador o dueño cambia el plan de cuentas.');
  const { error } = await db
    .from('accounting_account_map')
    .delete()
    .eq('scope', input.scope)
    .eq('key', input.key);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// El programa que escribe
// ---------------------------------------------------------------------------

export async function writeConnection(
  db: SupabaseClient,
  provider?: WritebackProvider,
): Promise<AccountingConnectionRow | null> {
  const all = (await listAccountingConnections(db)).filter(
    (c) => c.enabled && WRITABLE.has(c.provider as WritebackProvider),
  );
  if (provider) return all.find((c) => c.provider === provider) ?? null;
  if (all.length > 1)
    throw new ValidationError(
      `Hay ${all.map((c) => PROVIDER_LABEL[c.provider as WritebackProvider]).join(' y ')} conectados. Di en cuál registro.`,
    );
  return all[0] ?? null;
}

export const NO_PROGRAM_GUIDANCE =
  'No hay programa contable conectado (Siigo, Alegra o QuickBooks): un administrador lo conecta en Integraciones → Programas contables. Mientras tanto, esto se registra a mano donde lleven la contabilidad.';

// ---------------------------------------------------------------------------
// Los documentos de origen
// ---------------------------------------------------------------------------

async function writebackRows(
  db: SupabaseClient,
  kind?: WritebackKind,
): Promise<Map<string, WritebackRow>> {
  let q = db.from('accounting_writebacks').select(WRITEBACK_COLUMNS).limit(SCAN);
  if (kind) q = q.eq('kind', kind);
  const { data, error } = await q;
  if (error) throw error;
  const out = new Map<string, WritebackRow>();
  for (const r of (data ?? []) as WritebackRow[]) out.set(`${r.kind}:${r.source_id}`, r);
  return out;
}

async function categoryOf(db: SupabaseClient, movementId: string | null): Promise<string | null> {
  if (!movementId) return null;
  const { data, error } = await db
    .from('ledger_movements')
    .select('category')
    .eq('id', movementId)
    .maybeSingle();
  if (error) throw error;
  return ((data as { category?: string | null } | null)?.category ?? null) || null;
}

export function purchaseFromPayable(
  row: PayableInvoiceRow,
  category: string | null,
): PurchaseSource {
  const inv = adaptPayable(row);
  const iva = inv.iva;
  const otherTaxes = Number(row.other_taxes) || 0;
  const subtotal = inv.subtotal ?? round2(inv.total - iva - otherTaxes);
  return {
    kind: 'compra',
    id: inv.id,
    supplierId: inv.supplierId,
    supplierName: inv.supplierName,
    supplierNit: inv.supplierNit,
    supplierDv: row.supplier_dv,
    docNumber: inv.docNumber,
    cufe: inv.cufe,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    currency: inv.currency,
    subtotal,
    iva,
    otherTaxes,
    total: inv.total,
    withholdings: inv.withholdings,
    lines: (Array.isArray(row.lines) ? row.lines : []).map((l) => ({
      description: l.description,
      amount: Number(l.amount) || 0,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
    })),
    category,
  };
}

async function payableRow(db: SupabaseClient, id: string): Promise<PayableInvoiceRow | null> {
  const { data, error } = await db
    .from('payable_invoices')
    .select(PAYABLE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as PayableInvoiceRow | null) ?? null;
}

/** La compra ya en el programa: la causada por Cortex, o la que vino de él. */
function purchaseRef(
  row: PayableInvoiceRow,
  provider: WritebackProvider,
  written: WritebackRow | undefined,
): { id: string; number: string | null } | null {
  if (written?.status === 'registrada' && written.provider === provider && written.provider_id)
    return { id: written.provider_id, number: written.provider_number };
  if (
    row.source === 'contable' &&
    row.source_system === provider &&
    row.source_ref.startsWith('purchase:')
  )
    return { id: row.source_ref.slice('purchase:'.length), number: null };
  return null;
}

async function bankOfMovement(
  db: SupabaseClient,
  movementId: string | null | undefined,
): Promise<{ account: string | null; reference: string | null; date: string | null }> {
  if (!movementId) return { account: null, reference: null, date: null };
  const { data, error } = await db
    .from('ledger_movements')
    .select('account_id, description, date, source_ref')
    .eq('id', movementId)
    .maybeSingle();
  if (error) throw error;
  const m = data as { account_id: string | null; description: string; date: string } | null;
  if (!m) return { account: null, reference: null, date: null };
  let account: string | null = null;
  if (m.account_id) {
    const acc = await db
      .from('ledger_accounts')
      .select('name')
      .eq('id', m.account_id)
      .maybeSingle();
    if (acc.error) throw acc.error;
    account = (acc.data as { name?: string } | null)?.name ?? null;
  }
  return { account, reference: m.description.slice(0, 60), date: m.date };
}

interface PaymentLite {
  id: string;
  amount: number | string;
  currency: string;
  paid_on: string;
  client_id: string | null;
  client_nit: string | null;
  invoice_number: string | null;
  state: string;
}

interface InvoiceLite {
  source_ref: string;
  doc_number: string;
  balance: number | string;
  issued_on: string;
  due_on: string | null;
  counterparty_name: string | null;
  client_nit: string | null;
}

async function receiptFromPayment(
  db: SupabaseClient,
  payment: PaymentLite,
  provider: WritebackProvider,
  bank: { account: string | null; reference: string | null },
): Promise<ReceiptSource | null> {
  if (!payment.invoice_number) return null;
  const { data, error } = await db
    .from('accounting_invoices')
    .select('source_ref, doc_number, balance, issued_on, due_on, counterparty_name, client_nit')
    .eq('source_system', provider)
    .eq('doc_number', payment.invoice_number)
    .eq('annulled', false)
    .limit(2);
  if (error) throw error;
  const rows = (data ?? []) as InvoiceLite[];
  if (rows.length !== 1) return null;
  const inv = rows[0] as InvoiceLite;
  let customerName = inv.counterparty_name;
  if (!customerName && payment.client_id) {
    const c = await db.from('clients').select('name').eq('id', payment.client_id).maybeSingle();
    if (c.error) throw c.error;
    customerName = (c.data as { name?: string } | null)?.name ?? null;
  }
  return {
    kind: 'recibo',
    id: payment.id,
    date: payment.paid_on,
    amount: Number(payment.amount) || 0,
    currency: payment.currency,
    customerName,
    customerNit: (payment.client_nit ?? inv.client_nit)?.replace(/\D/g, '') || null,
    invoiceNumber: inv.doc_number,
    invoiceExternalId: inv.source_ref,
    invoiceBalance: Number(inv.balance) || 0,
    invoiceDate: inv.due_on ?? inv.issued_on,
    bankAccount: bank.account,
    reference: bank.reference,
  };
}

/** Lee el origen tal como está ahora. null si ya no aplica (rechazada, sin factura…). */
export async function loadSource(
  db: SupabaseClient,
  kind: WritebackKind,
  sourceId: string,
  provider: WritebackProvider,
): Promise<WritebackSource | null> {
  if (kind === 'compra') {
    const row = await payableRow(db, sourceId);
    if (!row || !['aprobada', 'programada', 'pagada'].includes(row.status)) return null;
    return purchaseFromPayable(row, await categoryOf(db, row.ledger_movement_id));
  }
  if (kind === 'pago_proveedor') {
    const row = await payableRow(db, sourceId);
    if (!row || row.status !== 'pagada' || !row.paid_at) return null;
    const written = (await writebackRows(db, 'compra')).get(`compra:${row.id}`);
    const ref = purchaseRef(row, provider, written);
    if (!ref) return null;
    const inv = adaptPayable(row);
    const bank = await bankOfMovement(db, row.paid_evidence?.movementId);
    return {
      kind: 'pago_proveedor',
      id: row.id,
      date: row.paid_at,
      amount: inv.netAmount,
      currency: inv.currency,
      supplierId: inv.supplierId,
      supplierName: inv.supplierName,
      supplierNit: inv.supplierNit,
      docNumber: inv.docNumber,
      purchaseExternalId: ref.id,
      purchaseNumber: ref.number,
      bankAccount: bank.account,
      reference: row.paid_evidence?.reference ?? bank.reference,
    };
  }
  const { data, error } = await db
    .from('payments')
    .select('id, amount, currency, paid_on, client_id, client_nit, invoice_number, state')
    .eq('id', sourceId)
    .maybeSingle();
  if (error) throw error;
  const payment = data as PaymentLite | null;
  if (!payment || !['reported', 'confirmed'].includes(payment.state)) return null;
  const reports = await db
    .from('payment_reports')
    .select('source_system, reference')
    .eq('payment_id', payment.id)
    .limit(20);
  if (reports.error) throw reports.error;
  const bankReport = (
    (reports.data ?? []) as Array<{ source_system: string | null; reference: string | null }>
  ).find((r) => r.source_system?.startsWith(BANK_SYSTEM_PREFIX));
  return receiptFromPayment(db, payment, provider, {
    account: bankReport?.source_system?.slice(BANK_SYSTEM_PREFIX.length) ?? null,
    reference: bankReport?.reference ?? null,
  });
}

// ---------------------------------------------------------------------------
// La cola: lo que falta registrar
// ---------------------------------------------------------------------------

export interface QueueItem {
  kind: WritebackKind;
  sourceId: string;
  label: string;
  date: string;
  amount: number;
  currency: string;
  counterparty: string;
  status: WritebackStatus;
  error: string | null;
  providerNumber: string | null;
  updatedAt: string | null;
}

export interface WritebackQueue {
  provider: WritebackProvider | null;
  providerName: string | null;
  guidance: string | null;
  items: QueueItem[];
  /** Lo ya registrado en el rango, lo más nuevo primero (hasta 50). */
  done: QueueItem[];
}

function inRange(day: string | null | undefined, range?: { from: string; to: string }): boolean {
  if (!day) return false;
  return !range || (day >= range.from && day <= range.to);
}

/**
 * Lo que falta registrar en el programa, por clase. Con `period`, sólo lo de
 * ese mes; sin él, todo lo abierto. Barato: tres lecturas acotadas y las filas
 * de escrituras ya hechas.
 */
export async function loadWritebackQueue(
  db: SupabaseClient,
  opts: { period?: string; provider?: WritebackProvider } = {},
): Promise<WritebackQueue> {
  const conn = await writeConnection(db, opts.provider).catch((err) => {
    if (err instanceof ValidationError) return null;
    throw err;
  });
  if (!conn)
    return {
      provider: null,
      providerName: null,
      guidance: NO_PROGRAM_GUIDANCE,
      items: [],
      done: [],
    };
  const provider = conn.provider as WritebackProvider;
  const range = opts.period
    ? { from: periodStart(opts.period), to: periodEnd(opts.period) }
    : undefined;
  const written = await writebackRows(db);
  const items: QueueItem[] = [];
  const done: QueueItem[] = [];
  const push = (base: Omit<QueueItem, 'status' | 'error' | 'providerNumber' | 'updatedAt'>) => {
    const row = written.get(`${base.kind}:${base.sourceId}`);
    if (row?.status === 'descartada') return;
    const item: QueueItem = {
      ...base,
      status: row?.status ?? 'pendiente',
      error: row?.error ?? null,
      providerNumber: row?.provider_number ?? null,
      updatedAt: row?.updated_at ?? null,
    };
    (row?.status === 'registrada' ? done : items).push(item);
  };

  // Compras: aprobadas (o ya programadas/pagadas) que no vinieron del programa.
  const payables = await db
    .from('payable_invoices')
    .select(PAYABLE_COLUMNS)
    .in('status', ['aprobada', 'programada', 'pagada'])
    .order('issue_date', { ascending: false })
    .limit(SCAN);
  if (payables.error) throw payables.error;
  for (const row of (payables.data ?? []) as PayableInvoiceRow[]) {
    const inv = adaptPayable(row);
    if (row.source !== 'contable' && inRange(inv.issueDate, range))
      push({
        kind: 'compra',
        sourceId: row.id,
        label: `Factura ${inv.docNumber} de ${inv.supplierName}`,
        date: inv.issueDate,
        amount: inv.total,
        currency: inv.currency,
        counterparty: inv.supplierName,
      });
    // Pagos a proveedor: pagadas por el banco cuya compra ya está en el programa.
    if (
      row.status === 'pagada' &&
      row.paid_at &&
      row.paid_evidence?.kind === 'bank' &&
      inRange(row.paid_at, range) &&
      purchaseRef(row, provider, written.get(`compra:${row.id}`))
    )
      push({
        kind: 'pago_proveedor',
        sourceId: row.id,
        label: `Pago a ${inv.supplierName} de la factura ${inv.docNumber}`,
        date: row.paid_at,
        amount: inv.netAmount,
        currency: inv.currency,
        counterparty: inv.supplierName,
      });
  }

  // Recibos: abonos del banco atados a una factura que el programa conoce, y
  // que el programa todavía no trae como pagados.
  let reportsQ = db
    .from('payment_reports')
    .select('payment_id, paid_on, source_system')
    .like('source_system', 'extracto %')
    .not('payment_id', 'is', null)
    .limit(SCAN);
  if (range) reportsQ = reportsQ.gte('paid_on', range.from).lte('paid_on', range.to);
  const reports = await reportsQ;
  if (reports.error) throw reports.error;
  const paymentIds = [
    ...new Set(((reports.data ?? []) as Array<{ payment_id: string }>).map((r) => r.payment_id)),
  ];
  for (let i = 0; i < paymentIds.length; i += 200) {
    const chunk = paymentIds.slice(i, i + 200);
    const [pays, fromProgram] = await Promise.all([
      db
        .from('payments')
        .select('id, amount, currency, paid_on, client_id, client_nit, invoice_number, state')
        .in('id', chunk)
        .in('state', ['reported', 'confirmed'])
        .not('invoice_number', 'is', null),
      db
        .from('payment_reports')
        .select('payment_id')
        .in('payment_id', chunk)
        .in('source_system', [...WRITABLE]),
    ]);
    if (pays.error) throw pays.error;
    if (fromProgram.error) throw fromProgram.error;
    const known = new Set(
      ((fromProgram.data ?? []) as Array<{ payment_id: string }>).map((r) => r.payment_id),
    );
    const rows = ((pays.data ?? []) as PaymentLite[]).filter((p) => !known.has(p.id));
    const numbers = [...new Set(rows.map((p) => p.invoice_number as string))];
    const invoices = new Map<string, InvoiceLite>();
    for (let j = 0; j < numbers.length; j += 200) {
      const inv = await db
        .from('accounting_invoices')
        .select('source_ref, doc_number, balance, issued_on, due_on, counterparty_name, client_nit')
        .eq('source_system', provider)
        .eq('annulled', false)
        .in('doc_number', numbers.slice(j, j + 200));
      if (inv.error) throw inv.error;
      for (const r of (inv.data ?? []) as InvoiceLite[]) invoices.set(r.doc_number, r);
    }
    for (const p of rows) {
      const inv = invoices.get(p.invoice_number as string);
      if (!inv) continue;
      push({
        kind: 'recibo',
        sourceId: p.id,
        label: `Pago de ${inv.counterparty_name ?? 'cliente'} a la factura ${inv.doc_number}`,
        date: p.paid_on,
        amount: Number(p.amount) || 0,
        currency: p.currency,
        counterparty: inv.counterparty_name ?? 'Cliente',
      });
    }
  }

  const byDate = (a: QueueItem, b: QueueItem) => a.date.localeCompare(b.date);
  items.sort(byDate);
  done.sort((a, b) => b.date.localeCompare(a.date));
  return {
    provider,
    providerName: PROVIDER_LABEL[provider],
    guidance: null,
    items,
    done: done.slice(0, 50),
  };
}

/** Cuántas faltan por clase en un mes (para la lista del cierre). */
export async function pendingWritebackCounts(
  db: SupabaseClient,
  period: string,
): Promise<Record<WritebackKind, number> | null> {
  const q = await loadWritebackQueue(db, { period });
  if (!q.provider) return null;
  const out: Record<WritebackKind, number> = { compra: 0, recibo: 0, pago_proveedor: 0 };
  for (const i of q.items) out[i.kind] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Vista previa
// ---------------------------------------------------------------------------

export interface PreparedWriteback {
  preview: WritebackPreview;
  payload: unknown;
  source: WritebackSource;
  connection: AccountingConnectionRow;
  session: ProviderSession;
}

export interface WritebackDeps {
  openSession?: (db: SupabaseClient, connectionId: string) => Promise<ProviderSession>;
}

export async function prepareWriteback(
  db: SupabaseClient,
  kind: WritebackKind,
  sourceId: string,
  opts: { provider?: WritebackProvider } & WritebackDeps = {},
): Promise<PreparedWriteback> {
  const conn = await writeConnection(db, opts.provider);
  if (!conn) throw new ValidationError(NO_PROGRAM_GUIDANCE);
  const provider = conn.provider as WritebackProvider;
  const source = await loadSource(db, kind, sourceId, provider);
  if (!source)
    throw new NotFoundError(
      kind === 'compra'
        ? 'Esa factura de proveedor no está aprobada (o ya no existe): sólo se causa una aprobada.'
        : kind === 'recibo'
          ? `Ese pago no está atado a una factura que ${PROVIDER_LABEL[provider]} conozca.`
          : `Esa factura no está pagada por el banco, o su compra no está en ${PROVIDER_LABEL[provider]} todavía (cáusala primero).`,
    );
  const session = await (opts.openSession ?? openAccountingSession)(db, conn.id);
  if (!session.writer?.supports[kind])
    throw new ValidationError(`${PROVIDER_LABEL[provider]} todavía no permite esto desde Cortex.`);
  const map = await loadAccountMap(db);
  const entries = entriesFor(source, map);
  const prepared = await session.writer.prepare(source, entries, map);
  const preview: WritebackPreview = {
    kind,
    provider,
    label: sourceLabel(source),
    date: sourceDate(source),
    amount: sourceAmount(source),
    currency: source.currency,
    counterparty: sourceCounterparty(source),
    entries,
    problems: [...commonProblems(source, entries), ...prepared.problems],
    warnings: [...defaultAccountWarnings(entries), ...prepared.warnings],
  };
  return { preview, payload: prepared.payload, source, connection: conn, session };
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export interface WritebackOutcome {
  status: 'registrada' | 'ya_registrada';
  kind: WritebackKind;
  sourceId: string;
  provider: WritebackProvider;
  providerId: string;
  providerNumber: string | null;
  label: string;
  markdown: string;
}

async function getRow(
  db: SupabaseClient,
  kind: WritebackKind,
  sourceId: string,
): Promise<WritebackRow | null> {
  const { data, error } = await db
    .from('accounting_writebacks')
    .select(WRITEBACK_COLUMNS)
    .eq('kind', kind)
    .eq('source_id', sourceId)
    .maybeSingle();
  if (error) throw error;
  return (data as WritebackRow | null) ?? null;
}

function doneOutcome(row: WritebackRow, already: boolean): WritebackOutcome {
  const name = PROVIDER_LABEL[row.provider];
  return {
    status: already ? 'ya_registrada' : 'registrada',
    kind: row.kind,
    sourceId: row.source_id,
    provider: row.provider,
    providerId: row.provider_id ?? '',
    providerNumber: row.provider_number,
    label: row.label,
    markdown: `${already ? 'Ya estaba registrada' : 'Registrada'} en ${name}: ${row.label}${row.provider_number ? ` → **${row.provider_number}**` : ''}.`,
  };
}

/**
 * Registrar UNA cosa en el programa. Idempotente: si ya está registrada, lo
 * dice y no manda nada. Lanza `ValidationError` en español si no se pudo.
 */
export async function executeWriteback(
  ctx: {
    db: SupabaseClient;
    organizationId: string;
    userId: string;
    enqueueJob?: (name: string, data: Record<string, unknown>) => Promise<boolean>;
  },
  kind: WritebackKind,
  sourceId: string,
  opts: { provider?: WritebackProvider; retryUncertain?: boolean; now?: Date } & WritebackDeps = {},
): Promise<WritebackOutcome> {
  const { db, userId } = ctx;
  const existing = await getRow(db, kind, sourceId);
  if (existing?.status === 'registrada') return doneOutcome(existing, true);
  if (existing?.status === 'descartada')
    throw new ValidationError(
      `Eso se marcó para registrar a mano en el programa${existing.discard_reason ? ` («${existing.discard_reason}»)` : ''}. Para que Cortex lo registre, vuelve a ponerlo en la cola desde /cierre.`,
    );
  const now = opts.now ?? new Date();
  const stuck =
    existing?.status === 'enviando' &&
    existing.attempted_at &&
    now.getTime() - Date.parse(existing.attempted_at) > STUCK_MS;
  if (existing?.status === 'enviando' && !stuck)
    throw new ValidationError(
      'Esto se está registrando en este momento. Espera un minuto y revisa.',
    );

  const prepared = await prepareWriteback(db, kind, sourceId, opts);
  const { preview, source, connection, session } = prepared;
  const provider = connection.provider as WritebackProvider;
  const name = PROVIDER_LABEL[provider];
  await assertPeriodOpen(db, preview.date, {
    action: `registrar en ${name} «${preview.label}»`,
    userId,
    now,
  });

  // Una escritura anterior que no se supo si llegó: primero buscar.
  if (existing && (existing.status === 'incierta' || stuck)) {
    if (!opts.retryUncertain)
      throw new ValidationError(
        `El intento anterior se cortó y no se sabe si ${name} alcanzó a registrar «${preview.label}». Búscalo en ${name}; si no está, pide reintentar diciendo que ya revisaste.`,
      );
    const found = session.writer?.find ? await session.writer.find(source).catch(() => null) : null;
    if (found?.id) {
      const { data, error } = await db
        .from('accounting_writebacks')
        .update({
          status: 'registrada',
          provider_id: found.id,
          provider_number: found.number,
          error: null,
          registered_at: now.toISOString(),
          approved_by: userId,
          updated_at: now.toISOString(),
        })
        .eq('id', existing.id)
        .in('status', ['incierta', 'enviando'])
        .select(WRITEBACK_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (data) return doneOutcome(data as WritebackRow, true);
    }
  }

  if (preview.problems.length) {
    const message = `No se registró nada en ${name}. Falta arreglar: ${preview.problems.join(' ')}`;
    if (existing && existing.status !== 'enviando') {
      const { error } = await db
        .from('accounting_writebacks')
        .update({ status: 'error', error: message.slice(0, 2000), updated_at: now.toISOString() })
        .eq('id', existing.id)
        .in('status', ['pendiente', 'error', 'incierta']);
      if (error) throw error;
    }
    throw new ValidationError(message);
  }

  // La toma: una sola escritura a la vez por origen.
  const key = writebackIdempotencyKey(ctx.organizationId, kind, sourceId);
  const claim = {
    provider,
    connection_id: connection.id,
    status: 'enviando' as const,
    doc_date: preview.date,
    amount: round2(preview.amount),
    currency: preview.currency,
    counterparty_name: preview.counterparty.slice(0, 200),
    label: preview.label.slice(0, 300),
    payload: prepared.payload as Record<string, unknown>,
    preview: { entries: preview.entries, warnings: preview.warnings } as Record<string, unknown>,
    idempotency_key: key,
    error: null,
    attempts: (existing?.attempts ?? 0) + 1,
    attempted_at: now.toISOString(),
    approved_by: userId,
    updated_at: now.toISOString(),
  };
  let row: WritebackRow | null;
  if (!existing) {
    const { data, error } = await db
      .from('accounting_writebacks')
      .insert({
        ...claim,
        kind,
        source_table: kind === 'recibo' ? 'payments' : 'payable_invoices',
        source_id: sourceId,
        created_by: userId,
      })
      .select(WRITEBACK_COLUMNS)
      .maybeSingle();
    // Otra persona la tomó al mismo tiempo: la base dice cuál ganó.
    if (error && (error as { code?: string }).code === '23505')
      throw new ValidationError(
        'Esto se está registrando en este momento. Espera un minuto y revisa.',
      );
    if (error) throw error;
    row = data as WritebackRow | null;
  } else {
    const { data, error } = await db
      .from('accounting_writebacks')
      .update(claim)
      .eq('id', existing.id)
      .in('status', stuck ? ['enviando'] : ['pendiente', 'error', 'incierta'])
      .select(WRITEBACK_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    row = data as WritebackRow | null;
  }
  if (!row) {
    const now2 = await getRow(db, kind, sourceId);
    if (now2?.status === 'registrada') return doneOutcome(now2, true);
    throw new ValidationError(
      'Esto se está registrando en este momento. Espera un minuto y revisa.',
    );
  }

  try {
    const written = await (session.writer as NonNullable<ProviderSession['writer']>).send(
      source,
      prepared.payload,
      { idempotencyKey: key },
    );
    if (!written.id)
      throw new ProviderUncertainError(
        `${name} respondió sin el número del documento: no se sabe si quedó creado. Revisa en ${name}.`,
      );
    const { data, error } = await db
      .from('accounting_writebacks')
      .update({
        status: 'registrada',
        provider_id: written.id.slice(0, 120),
        provider_number: written.number?.slice(0, 120) ?? null,
        provider_status: written.status?.slice(0, 80) ?? null,
        error: null,
        registered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'enviando')
      .select(WRITEBACK_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    const done = (data as WritebackRow | null) ?? (await getRow(db, kind, sourceId)) ?? row;
    try {
      const synced = await requestAccountingSync(db, provider);
      await ctx.enqueueJob?.('accounting/run', {
        organizationId: ctx.organizationId,
        connectionId: synced.id,
      });
    } catch {
      // La sincronización programada lo trae igual.
    }
    return doneOutcome(done, false);
  } catch (err) {
    const uncertain = err instanceof ProviderUncertainError;
    const message =
      err instanceof ProviderValidationError || uncertain
        ? (err as Error).message
        : `No se pudo registrar en ${name}: ${err instanceof Error ? err.message : 'error desconocido'}`;
    const { error } = await db
      .from('accounting_writebacks')
      .update({
        status: uncertain ? 'incierta' : 'error',
        error: message.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'enviando');
    if (error) throw error;
    throw new ValidationError(message);
  }
}

/** Sacarlo de la cola: se registra a mano en el programa. Reversible con `restoreWriteback`. */
export async function discardWriteback(
  db: SupabaseClient,
  input: { kind: WritebackKind; sourceId: string; reason: string; userId: string },
): Promise<void> {
  const existing = await getRow(db, input.kind, input.sourceId);
  if (existing?.status === 'registrada')
    throw new ValidationError('Ya está registrada en el programa: no se puede descartar.');
  if (existing?.status === 'enviando')
    throw new ValidationError('Se está registrando en este momento.');
  const now = new Date().toISOString();
  const reason = input.reason.trim().slice(0, 500) || 'Se registra a mano';
  if (existing) {
    const { error } = await db
      .from('accounting_writebacks')
      .update({
        status: 'descartada',
        discarded_by: input.userId,
        discard_reason: reason,
        updated_at: now,
      })
      .eq('id', existing.id)
      .in('status', ['pendiente', 'error', 'incierta']);
    if (error) throw error;
    return;
  }
  const conn = await writeConnection(db).catch(() => null);
  if (!conn) throw new ValidationError(NO_PROGRAM_GUIDANCE);
  const provider = conn.provider as WritebackProvider;
  const source = await loadSource(db, input.kind, input.sourceId, provider);
  if (!source) throw new NotFoundError('Eso ya no está en la cola.');
  const { error } = await db.from('accounting_writebacks').insert({
    kind: input.kind,
    source_table: input.kind === 'recibo' ? 'payments' : 'payable_invoices',
    source_id: input.sourceId,
    provider,
    connection_id: conn.id,
    status: 'descartada',
    doc_date: sourceDate(source),
    amount: round2(sourceAmount(source)),
    currency: source.currency,
    counterparty_name: sourceCounterparty(source).slice(0, 200),
    label: sourceLabel(source).slice(0, 300),
    idempotency_key: writebackIdempotencyKey('local', input.kind, input.sourceId),
    discarded_by: input.userId,
    discard_reason: reason,
    created_by: input.userId,
  });
  if (error) throw error;
}

export async function restoreWriteback(
  db: SupabaseClient,
  input: { kind: WritebackKind; sourceId: string },
): Promise<void> {
  const { error } = await db
    .from('accounting_writebacks')
    .update({
      status: 'pendiente',
      discarded_by: null,
      discard_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('kind', input.kind)
    .eq('source_id', input.sourceId)
    .eq('status', 'descartada');
  if (error) throw error;
}

/**
 * Conciliar lo registrado con lo que el programa dice ahora: un recibo
 * registrado cuya factura sigue con saldo completo en el programa (después de
 * sincronizar) se marca para revisar. Barato; lo corre la pantalla.
 */
export async function reconcileWritebacks(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('accounting_writebacks')
    .select('id, kind, source_id, provider, registered_at, amount')
    .eq('status', 'registrada')
    .eq('kind', 'recibo')
    .is('reconciled_at', null)
    .limit(200);
  if (error) throw error;
  let touched = 0;
  for (const w of (data ?? []) as Array<{ id: string; source_id: string; provider: string }>) {
    const pay = await db
      .from('payments')
      .select('invoice_number')
      .eq('id', w.source_id)
      .maybeSingle();
    if (pay.error) throw pay.error;
    const number = (pay.data as { invoice_number?: string | null } | null)?.invoice_number;
    if (!number) continue;
    const inv = await db
      .from('accounting_invoices')
      .select('balance, total, synced_at')
      .eq('source_system', w.provider)
      .eq('doc_number', number)
      .maybeSingle();
    if (inv.error) throw inv.error;
    const row = inv.data as { balance: number | string; total: number | string } | null;
    if (!row) continue;
    const status = Number(row.balance) <= 0.5 ? 'factura saldada' : `saldo ${Number(row.balance)}`;
    const upd = await db
      .from('accounting_writebacks')
      .update({ provider_status: status, reconciled_at: new Date().toISOString() })
      .eq('id', w.id);
    if (upd.error) throw upd.error;
    touched += 1;
  }
  return touched;
}
