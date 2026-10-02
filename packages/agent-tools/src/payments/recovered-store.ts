import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import {
  type ManualRecoveryInput,
  type MoneyRecovered,
  RECOVERY_WINDOW_DAYS,
  type RecoveryBalanceDrop,
  type RecoveryInvoice,
  type RecoveryPayment,
  type RecoveryTrigger,
  addDaysTo,
  attributeRecovered,
} from './recovered';
import { COUNTED_STATES, type PaymentKind, type PaymentState } from './shape';

/**
 * PLATA RECUPERADA: LA LECTURA (las reglas están en ./recovered.ts).
 *
 * Lee lo justo para la cifra y se lo entrega a `attributeRecovered`: las
 * acciones de Cortex sobre facturas (avisos de mora, procesos de cobro de
 * Gerencia y los correos de cobro que salieron), esas facturas, los pagos
 * atados a ellas, las caídas de saldo anotadas (0166) y lo manual de los
 * asuntos cerrados con verificación.
 *
 * Toda lectura revisa `error` y lanza: una cifra de plata calculada sobre una
 * lectura que falló a medias es peor que ninguna cifra.
 *
 * `db` es siempre un handle con alcance de espacio (0064).
 */

const LIMIT = 5000;
const CHUNK = 200;

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** El día de Bogotá de un timestamp. */
function dayOf(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  return bogotaToday(new Date(ms));
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

interface NoticeRow {
  id: string;
  extraction_id: string | null;
  accounting_invoice_id: string | null;
  stage: number;
  sent_on: string;
  balance: number | string | null;
}

interface WorkflowRow {
  id: string;
  case_id: string;
  invoice_id: string;
  created_at: string;
}

interface CaseRow {
  id: string;
  data: {
    title?: string;
    state?: string;
    recovered?: { amountCop?: number; note?: string } | null;
  };
  updated_at: string;
}

/** Todo lo que necesita la cifra, ya leído. Exportado para los tests del almacén. */
export async function loadRecoveryInputs(
  db: SupabaseClient,
  opts: { today?: string } = {},
): Promise<Parameters<typeof attributeRecovered>[0]> {
  const today = opts.today ?? bogotaToday();

  const [notices, workflows, cases, drops, connections] = await Promise.all([
    db
      .from('receivable_notices')
      .select('id, extraction_id, accounting_invoice_id, stage, sent_on, balance')
      .order('sent_on', { ascending: false })
      .limit(LIMIT),
    db
      .from('management_workflows')
      .select('id, case_id, invoice_id, created_at')
      .order('created_at', { ascending: false })
      .limit(LIMIT),
    db
      .from('management_cases')
      .select('id, data, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1000),
    db
      .from('receivable_balance_drops')
      .select(
        'id, accounting_invoice_id, currency, balance_before, balance_after, seen_before_on, observed_on',
      )
      .order('observed_on', { ascending: false })
      .limit(LIMIT),
    // Sólo columnas que no son secretas: qué programa y qué trae.
    db
      .from('accounting_connections')
      .select('provider, entities')
      .limit(20),
  ]);
  if (notices.error) throw notices.error;
  if (workflows.error) throw workflows.error;
  if (cases.error) throw cases.error;
  if (drops.error) throw drops.error;
  if (connections.error) throw connections.error;

  const noticeRows = (notices.data ?? []) as NoticeRow[];
  const workflowRows = (workflows.data ?? []) as WorkflowRow[];

  // Los correos de cobro que salieron, atados a su proceso de Gerencia.
  const sent: Array<{ id: string; origin_id: string; executed_at: string }> = [];
  for (const ids of chunks(workflowRows.map((w) => w.id))) {
    const { data, error } = await db
      .from('actions')
      .select('id, origin_id, executed_at')
      .eq('kind', 'collect_payment')
      .eq('origin_kind', 'manual')
      .eq('execution_status', 'ok')
      .in('origin_id', ids)
      .limit(LIMIT);
    if (error) throw error;
    sent.push(...((data ?? []) as typeof sent));
  }

  const docIds = new Set<string>();
  const accIds = new Set<string>();
  for (const n of noticeRows) {
    if (n.extraction_id) docIds.add(n.extraction_id);
    if (n.accounting_invoice_id) accIds.add(n.accounting_invoice_id);
  }
  for (const w of workflowRows) docIds.add(w.invoice_id);

  const synced = new Set(
    ((connections.data ?? []) as Array<{ provider: string; entities: string[] | null }>)
      .filter((c) => (c.entities ?? []).includes('payments'))
      .map((c) => c.provider),
  );

  const invoices: RecoveryInvoice[] = [];
  for (const ids of chunks([...docIds])) {
    const { data, error } = await db
      .from('document_extractions')
      .select('id, doc_number, client_id, counterparty_name, total_amount, currency')
      .eq('review_state', 'confirmed')
      .eq('doc_type', 'invoice')
      .in('id', ids)
      .limit(LIMIT);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{
      id: string;
      doc_number: string | null;
      client_id: string | null;
      counterparty_name: string | null;
      total_amount: number | string | null;
      currency: string | null;
    }>) {
      const total = num(r.total_amount);
      if (total == null || !r.currency) continue;
      invoices.push({
        id: r.id,
        source: 'document',
        system: null,
        docNumber: r.doc_number,
        clientId: r.client_id,
        counterparty: r.counterparty_name,
        currency: r.currency,
        total,
        href: null,
      });
    }
  }
  for (const ids of chunks([...accIds])) {
    const { data, error } = await db
      .from('accounting_invoices')
      .select(
        'id, source_system, doc_number, client_id, counterparty_name, currency, total, public_url',
      )
      .eq('annulled', false)
      .in('id', ids)
      .limit(LIMIT);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{
      id: string;
      source_system: string;
      doc_number: string;
      client_id: string | null;
      counterparty_name: string | null;
      currency: string;
      total: number | string;
      public_url: string | null;
    }>) {
      const total = num(r.total);
      if (total == null) continue;
      invoices.push({
        id: r.id,
        source: 'accounting',
        system: r.source_system,
        docNumber: r.doc_number,
        clientId: r.client_id,
        counterparty: r.counterparty_name,
        currency: r.currency,
        total,
        paymentsSynced: synced.has(r.source_system),
        href: r.public_url,
      });
    }
  }

  // Los pagos: por id de documento, o por número para las del programa contable.
  const paymentColumns =
    'id, extraction_id, invoice_number, kind, amount, currency, paid_on, state';
  const paymentRows: Array<{
    id: string;
    extraction_id: string | null;
    invoice_number: string | null;
    kind: PaymentKind;
    amount: number | string;
    currency: string;
    paid_on: string;
    state: PaymentState;
  }> = [];
  const documentIds = invoices.filter((i) => i.source === 'document').map((i) => i.id);
  for (const ids of chunks(documentIds)) {
    const { data, error } = await db
      .from('payments')
      .select(paymentColumns)
      .in('extraction_id', ids)
      .in('state', [...COUNTED_STATES])
      .limit(LIMIT);
    if (error) throw error;
    paymentRows.push(...((data ?? []) as typeof paymentRows));
  }
  const numbers = [
    ...new Set(
      invoices
        .filter((i) => i.source === 'accounting' && i.docNumber)
        .map((i) => i.docNumber as string),
    ),
  ];
  for (const ids of chunks(numbers)) {
    const { data, error } = await db
      .from('payments')
      .select(paymentColumns)
      .is('extraction_id', null)
      .in('invoice_number', ids)
      .in('state', [...COUNTED_STATES])
      .limit(LIMIT);
    if (error) throw error;
    paymentRows.push(...((data ?? []) as typeof paymentRows));
  }
  const payments: RecoveryPayment[] = paymentRows.map((p) => ({
    id: p.id,
    extractionId: p.extraction_id,
    invoiceNumber: p.invoice_number,
    kind: p.kind,
    amount: num(p.amount) ?? 0,
    currency: p.currency,
    paidOn: p.paid_on,
    state: p.state,
  }));

  // Las acciones de Cortex.
  const triggers: RecoveryTrigger[] = [];
  for (const n of noticeRows) {
    const invoiceId = n.extraction_id ?? n.accounting_invoice_id;
    if (!invoiceId) continue;
    triggers.push({
      kind: 'notice',
      id: n.id,
      invoiceId,
      on: n.sent_on,
      balance: num(n.balance),
      stage: n.stage,
      href: '/payments',
    });
  }
  const workflowById = new Map(workflowRows.map((w) => [w.id, w]));
  const workflowByCase = new Map(workflowRows.map((w) => [w.case_id, w]));
  for (const w of workflowRows) {
    const on = dayOf(w.created_at);
    if (!on) continue;
    triggers.push({
      kind: 'case',
      id: w.id,
      invoiceId: w.invoice_id,
      on,
      caseId: w.case_id,
      href: `/management?case=${w.case_id}`,
    });
  }
  for (const a of sent) {
    const w = workflowById.get(a.origin_id);
    const on = dayOf(a.executed_at);
    if (!w || !on) continue;
    triggers.push({
      kind: 'collection',
      id: a.id,
      invoiceId: w.invoice_id,
      on,
      caseId: w.case_id,
      href: '/actions',
    });
  }

  const dropRows: RecoveryBalanceDrop[] = (
    (drops.data ?? []) as Array<{
      id: string;
      accounting_invoice_id: string;
      currency: string;
      balance_before: number | string;
      balance_after: number | string;
      seen_before_on: string;
      observed_on: string;
    }>
  ).map((d) => ({
    id: d.id,
    invoiceId: d.accounting_invoice_id,
    amount: (num(d.balance_before) ?? 0) - (num(d.balance_after) ?? 0),
    currency: d.currency,
    seenBeforeOn: d.seen_before_on,
    observedOn: d.observed_on,
  }));

  // Lo manual: sólo asuntos cerrados con verificación humana. Un asunto
  // verificado no se puede modificar sin reabrirlo, así que su `updated_at` es
  // el día del cierre.
  const manual: ManualRecoveryInput[] = [];
  for (const c of (cases.data ?? []) as CaseRow[]) {
    const r = c.data?.recovered;
    if (c.data?.state !== 'verified' || !r) continue;
    const amountCop = num(r.amountCop);
    const on = dayOf(c.updated_at);
    if (amountCop == null || amountCop <= 0 || !on) continue;
    manual.push({
      caseId: c.id,
      title: c.data.title ?? 'Asunto',
      amountCop,
      note: r.note ?? '',
      on,
      invoiceId: workflowByCase.get(c.id)?.invoice_id ?? null,
    });
  }

  return { today, invoices, triggers, payments, drops: dropRows, manual };
}

/** Cuánta plata volvió porque Cortex actuó. Ver las reglas en ./recovered.ts. */
export async function moneyRecovered(
  db: SupabaseClient,
  opts: { today?: string; windowDays?: number } = {},
): Promise<MoneyRecovered> {
  const input = await loadRecoveryInputs(db, opts);
  return attributeRecovered({ ...input, windowDays: opts.windowDays ?? RECOVERY_WINDOW_DAYS });
}

// ---------------------------------------------------------------------------
// Anotar las caídas de saldo (lo único que se escribe)
// ---------------------------------------------------------------------------

/**
 * Compara el saldo de hoy de cada factura de programa contable avisada con el
 * último saldo que se vio (el del aviso, o el de la última caída anotada) y,
 * si bajó, anota la caída. Lo llama el vigilante de cartera cada mañana, ANTES
 * de reclamar avisos nuevos.
 *
 * Idempotente: una caída por factura y día (índice único de la 0166). Una
 * factura anulada no anota nada: anular no es cobrar.
 */
export async function recordBalanceDrops(
  db: SupabaseClient,
  opts: { today?: string } = {},
): Promise<{ recorded: number }> {
  const today = opts.today ?? bogotaToday();
  // Más allá de la ventana una caída ya no se atribuye a nada: no hace falta mirarla.
  const since = addDaysTo(today, -(RECOVERY_WINDOW_DAYS + 1));
  const notices = await db
    .from('receivable_notices')
    .select('id, accounting_invoice_id, sent_on, balance')
    .not('accounting_invoice_id', 'is', null)
    .not('balance', 'is', null)
    .gte('sent_on', since)
    .order('sent_on', { ascending: false })
    .limit(LIMIT);
  if (notices.error) throw notices.error;
  const noticeRows = (notices.data ?? []) as Array<{
    id: string;
    accounting_invoice_id: string;
    sent_on: string;
    balance: number | string;
  }>;
  if (!noticeRows.length) return { recorded: 0 };

  const ids = [...new Set(noticeRows.map((n) => n.accounting_invoice_id))];
  const current = new Map<string, { balance: number; currency: string; annulled: boolean }>();
  const lastDrop = new Map<string, { on: string; balance: number }>();
  for (const part of chunks(ids)) {
    const [inv, dr] = await Promise.all([
      db
        .from('accounting_invoices')
        .select('id, balance, currency, annulled')
        .in('id', part)
        .limit(LIMIT),
      db
        .from('receivable_balance_drops')
        .select('accounting_invoice_id, balance_after, observed_on')
        .in('accounting_invoice_id', part)
        .order('observed_on', { ascending: false })
        .limit(LIMIT),
    ]);
    if (inv.error) throw inv.error;
    if (dr.error) throw dr.error;
    for (const r of (inv.data ?? []) as Array<{
      id: string;
      balance: number | string;
      currency: string;
      annulled: boolean;
    }>) {
      const balance = num(r.balance);
      if (balance != null)
        current.set(r.id, { balance, currency: r.currency, annulled: r.annulled });
    }
    for (const r of (dr.data ?? []) as Array<{
      accounting_invoice_id: string;
      balance_after: number | string;
      observed_on: string;
    }>) {
      const prev = lastDrop.get(r.accounting_invoice_id);
      const balance = num(r.balance_after);
      if (balance != null && (!prev || r.observed_on > prev.on))
        lastDrop.set(r.accounting_invoice_id, { on: r.observed_on, balance });
    }
  }

  let recorded = 0;
  for (const invoiceId of ids) {
    const now = current.get(invoiceId);
    if (!now || now.annulled) continue;
    // El último saldo visto: el aviso más reciente o la caída más reciente; el
    // mismo día manda el aviso, que se reclama después de anotar caídas.
    const notice = noticeRows.find((n) => n.accounting_invoice_id === invoiceId);
    if (!notice) continue;
    const drop = lastDrop.get(invoiceId);
    const base =
      drop && drop.on > notice.sent_on
        ? { on: drop.on, balance: drop.balance }
        : { on: notice.sent_on, balance: num(notice.balance) ?? 0 };
    if (base.on >= today) continue;
    if (!(now.balance < base.balance - 0.005) || base.balance <= 0) continue;
    const { error } = await db.from('receivable_balance_drops').insert({
      accounting_invoice_id: invoiceId,
      notice_id: notice.id,
      currency: now.currency,
      balance_before: base.balance,
      balance_after: now.balance,
      seen_before_on: base.on,
      observed_on: today,
    });
    if (!error) recorded += 1;
    else if ((error as { code?: string }).code !== '23505') throw error;
  }
  return { recorded };
}
