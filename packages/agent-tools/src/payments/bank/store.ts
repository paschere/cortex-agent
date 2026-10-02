import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeNit } from '../../clients/shape';
import { type SystemPaymentRow, importSystemPayments } from '../import';
import { COUNTED_STATES, requireCurrency, signedAmount } from '../shape';
import {
  PAYMENT_COLUMNS,
  type PaymentReportRow,
  type PaymentRow,
  REPORT_COLUMNS,
  docNumberKey,
  hydratePayments,
  num,
} from '../store';
import {
  type CreditMatch,
  type InvoiceSuggestion,
  type MatchClient,
  type MatchInvoice,
  type MatchStatus,
  invoiceLabel,
  matchCredit,
  matchCredits,
} from './match';
import type { BankId, ColumnRole, ManualMapping, NeedsMapping, StatementCredit } from './parse';
import { parseStatementFile } from './read';

/**
 * El extracto del banco, contra la base de datos: vista previa, importación y
 * la lista de conciliación.
 *
 * NO HAY TABLA NUEVA. Cada abono entra por `importSystemPayments` —la puerta
 * que la 0098 dejó lista para «un extracto de Bancolombia, otra función
 * igual»— como un `payment_report` con `source_kind='system'`. Lo único que
 * este archivo decide es cómo se llama la fuente:
 *
 *   source_system = 'extracto · <nombre de la cuenta>'
 *
 * La CUENTA va en la fuente y no en la referencia de cada abono, para que dos
 * cuentas no compartan nunca referencias y para que la disputa diga «extracto ·
 * bancolombia corriente 1234» cuando choque con Siigo. Por eso el nombre de la
 * cuenta tiene que ser el mismo cada vez que se importa esa cuenta: la
 * pantalla ofrece los que ya existen.
 *
 * «Extracto» está en `BANK_SYSTEMS` de shape.ts, así que la jerarquía —que sólo
 * ordena la cola de disputas— ya lo trata como banco.
 *
 * LA CONCILIACIÓN NO SE GUARDA: SE CALCULA. Un abono atado a su factura es un
 * pago con `extraction_id` o `invoice_number`; uno sin atar se vuelve a pasar
 * por el emparejador cada vez que se mira la lista, contra las facturas
 * abiertas de ese momento. Así una factura que llega de Siigo mañana aparece
 * como sugerencia de un abono de la semana pasada sin que nadie reimporte nada.
 */

export const BANK_SYSTEM_PREFIX = 'extracto · ';
const BANK_SYSTEM_LIKE = 'extracto %';
const SCAN = 1000;

/** El nombre de la cuenta como se guarda: minúsculas, espacios simples, ≤ 48. */
export function normalizeAccountLabel(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s#-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
    .trim();
}

export function bankSystemName(accountLabel: string): string {
  const label = normalizeAccountLabel(accountLabel);
  if (!label) {
    throw new ValidationError(
      'Ponle un nombre a la cuenta (por ejemplo «Bancolombia corriente 1234») y usa siempre el mismo: es lo que evita duplicar abonos al volver a importar.',
    );
  }
  return `${BANK_SYSTEM_PREFIX}${label}`;
}

/** 'extracto · bancolombia corriente' → 'bancolombia corriente'. */
export function accountLabelOf(system: string | null | undefined): string | null {
  if (!system?.startsWith(BANK_SYSTEM_PREFIX)) return null;
  return system.slice(BANK_SYSTEM_PREFIX.length) || null;
}

// ---------------------------------------------------------------------------
// Las facturas abiertas y los clientes, para el emparejador
// ---------------------------------------------------------------------------

export interface MatchPool {
  invoices: MatchInvoice[];
  clients: MatchClient[];
}

/**
 * Lo que un abono puede estar pagando: facturas por cobrar confirmadas con
 * saldo, y facturas abiertas del programa contable.
 *
 * El saldo de una factura leída es su total menos lo ya atado a ella, con las
 * mismas reglas que la cartera (sólo pagos que cuentan, por moneda). El de una
 * factura de Siigo es el que dice Siigo, MENOS lo que ya se ató a ella desde el
 * banco y Siigo quizá no ha visto aún: para SUGERIR es mejor esconder una
 * factura ya cubierta que ofrecerla dos veces. Esto no toca la cartera.
 */
export async function loadMatchPool(db: SupabaseClient): Promise<MatchPool> {
  const [clientsRead, docsRead, accRead, paysRead] = await Promise.all([
    db.from('clients').select('id, name, tax_id').limit(2000),
    db
      .from('document_extractions')
      .select(
        'id, doc_number, client_id, counterparty_name, counterparty_nit, total_amount, currency, issued_on, due_on',
      )
      .eq('review_state', 'confirmed')
      .eq('doc_type', 'invoice')
      .eq('financial_role', 'receivable')
      .limit(SCAN),
    db
      .from('accounting_invoices')
      .select(
        'id, source_system, doc_number, client_id, client_nit, counterparty_name, currency, total, balance, issued_on, due_on',
      )
      .gt('balance', 0)
      .eq('annulled', false)
      .limit(SCAN),
    db
      .from('payments')
      .select('id, kind, amount, currency, extraction_id, invoice_number, state')
      .in('state', [...COUNTED_STATES])
      .limit(SCAN),
  ]);
  if (clientsRead.error) throw clientsRead.error;
  if (docsRead.error) throw docsRead.error;
  if (accRead.error) throw accRead.error;
  if (paysRead.error) throw paysRead.error;

  const clients: MatchClient[] = (
    (clientsRead.data ?? []) as Array<{ id: string; name: string; tax_id: string | null }>
  ).map((c) => ({ id: c.id, name: c.name, nit: c.tax_id ? normalizeNit(c.tax_id) : null }));
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const nitOf = new Map(clients.map((c) => [c.id, c.nit]));

  const applied = new Map<string, number>();
  const claimedByNumber = new Map<string, number>();
  for (const p of (paysRead.data ?? []) as Array<{
    kind: 'payment' | 'reversal' | 'adjustment';
    amount: number | string;
    currency: string;
    extraction_id: string | null;
    invoice_number: string | null;
  }>) {
    const signed = signedAmount(p.kind, num(p.amount) ?? 0);
    if (p.extraction_id) {
      const key = `${p.extraction_id}\u0000${p.currency}`;
      applied.set(key, (applied.get(key) ?? 0) + signed);
    } else if (p.invoice_number) {
      const key = `${docNumberKey(p.invoice_number)}\u0000${p.currency}`;
      claimedByNumber.set(key, (claimedByNumber.get(key) ?? 0) + signed);
    }
  }

  const invoices: MatchInvoice[] = [];
  for (const d of (docsRead.data ?? []) as Array<{
    id: string;
    doc_number: string | null;
    client_id: string | null;
    counterparty_name: string | null;
    counterparty_nit: string | null;
    total_amount: number | string | null;
    currency: string | null;
    issued_on: string | null;
    due_on: string | null;
  }>) {
    const total = num(d.total_amount);
    if (total == null || !d.currency) continue;
    const balance = total - (applied.get(`${d.id}\u0000${d.currency}`) ?? 0);
    if (balance <= 0.004) continue;
    invoices.push({
      kind: 'document',
      id: d.id,
      docNumber: d.doc_number,
      clientId: d.client_id,
      clientName: (d.client_id ? nameOf.get(d.client_id) : null) ?? d.counterparty_name,
      nit: d.counterparty_nit
        ? normalizeNit(d.counterparty_nit)
        : d.client_id
          ? (nitOf.get(d.client_id) ?? null)
          : null,
      currency: d.currency,
      total,
      balance: Math.round(balance * 100) / 100,
      issuedOn: d.issued_on,
      dueOn: d.due_on,
      system: null,
    });
  }

  // Una factura que existe como documento confirmado y en Siigo es UNA: la del
  // documento, igual que en la cartera.
  const documentNumbers = new Set(invoices.map((i) => docNumberKey(i.docNumber)).filter(Boolean));
  for (const a of (accRead.data ?? []) as Array<{
    id: string;
    source_system: string;
    doc_number: string;
    client_id: string | null;
    client_nit: string | null;
    counterparty_name: string | null;
    currency: string;
    total: number | string;
    balance: number | string;
    issued_on: string | null;
    due_on: string | null;
  }>) {
    if (documentNumbers.has(docNumberKey(a.doc_number))) continue;
    const reported = num(a.balance) ?? 0;
    const claimed = claimedByNumber.get(`${docNumberKey(a.doc_number)}\u0000${a.currency}`) ?? 0;
    const balance = reported - Math.max(claimed, 0);
    if (balance <= 0.004) continue;
    invoices.push({
      kind: 'accounting',
      id: a.id,
      docNumber: a.doc_number,
      clientId: a.client_id,
      clientName: (a.client_id ? nameOf.get(a.client_id) : null) ?? a.counterparty_name,
      nit: a.client_nit
        ? normalizeNit(a.client_nit)
        : a.client_id
          ? (nitOf.get(a.client_id) ?? null)
          : null,
      currency: a.currency,
      total: num(a.total) ?? reported,
      balance: Math.round(balance * 100) / 100,
      issuedOn: a.issued_on,
      dueOn: a.due_on,
      system: a.source_system,
    });
  }
  return { invoices, clients };
}

// ---------------------------------------------------------------------------
// Vista previa e importación
// ---------------------------------------------------------------------------

export interface BankStatementInput {
  bytes: Uint8Array;
  fileName: string;
  mime?: string | null;
  /** El nombre de la cuenta. Siempre el mismo para la misma cuenta. */
  accountLabel: string;
  /** Tres letras. Nunca se asume: la pantalla la muestra escogida. */
  currency: string;
  bank?: BankId | null;
  mapping?: ManualMapping | null;
}

export interface SuggestionView {
  kind: 'document' | 'accounting';
  id: string;
  docNumber: string | null;
  clientName: string | null;
  balance: number;
  currency: string;
  label: string;
  score: number;
  exact: boolean;
  reasons: string[];
}

export interface PreviewLine {
  line: number;
  date: string;
  amount: number;
  description: string;
  reference: string | null;
  sourceRef: string;
  duplicate: boolean;
  status: MatchStatus | null;
  reason: string | null;
  suggestions: SuggestionView[];
}

export interface BankStatementPreview {
  status: 'ready';
  bank: { id: BankId; label: string; detectedBy: 'name' | 'headers' | 'none' | 'chosen' };
  columnNames: Partial<Record<ColumnRole, string>>;
  accountLabel: string;
  system: string;
  accountHint: string | null;
  currency: string;
  period: { from: string; to: string } | null;
  credits: number;
  creditsTotal: number;
  debitsIgnored: number;
  debitsTotal: number;
  skipped: number;
  skippedExamples: Array<{ line: number; reason: string }>;
  duplicates: number;
  newCredits: number;
  newTotal: number;
  matched: number;
  suggested: number;
  unmatched: number;
  /** Hasta 300 abonos, los nuevos primero. */
  lines: PreviewLine[];
  warnings: string[];
}

export type BankPreviewResult = BankStatementPreview | NeedsMapping;

export function suggestionView(s: InvoiceSuggestion): SuggestionView {
  return {
    kind: s.invoice.kind,
    id: s.invoice.id,
    docNumber: s.invoice.docNumber,
    clientName: s.invoice.clientName,
    balance: s.invoice.balance,
    currency: s.invoice.currency,
    label: invoiceLabel(s.invoice),
    score: s.score,
    exact: s.amountFit === 'exact',
    reasons: s.reasons,
  };
}

/** Las referencias de este extracto que ya están en `payment_reports`. */
async function existingRefs(
  db: SupabaseClient,
  system: string,
  refs: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < refs.length; i += 200) {
    const { data, error } = await db
      .from('payment_reports')
      .select('source_ref')
      .eq('source_kind', 'system')
      .eq('source_system', system)
      .in('source_ref', refs.slice(i, i + 200))
      .limit(200);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ source_ref: string | null }>) {
      if (r.source_ref) out.add(r.source_ref);
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Analysis {
  preview: BankStatementPreview;
  fresh: Array<{ credit: StatementCredit; match: CreditMatch }>;
}

async function analyze(
  db: SupabaseClient,
  input: BankStatementInput,
): Promise<Analysis | NeedsMapping> {
  const currency = requireCurrency(input.currency);
  const system = bankSystemName(input.accountLabel);
  const parsed = await parseStatementFile(input.bytes, input.fileName, input.mime, {
    bank: input.bank ?? null,
    mapping: input.mapping ?? null,
  });
  if (parsed.status === 'needs_mapping') return parsed;

  const known = await existingRefs(
    db,
    system,
    parsed.credits.map((c) => c.sourceRef),
  );
  const freshCredits = parsed.credits.filter((c) => !known.has(c.sourceRef));
  const pool = freshCredits.length ? await loadMatchPool(db) : { invoices: [], clients: [] };
  const matches = matchCredits(
    freshCredits.map((c) => ({
      amount: c.amount,
      currency,
      date: c.date,
      description: c.description,
      reference: [c.reference, c.txid].filter(Boolean).join(' ') || null,
      nit: c.nit,
      counterparty: c.counterparty,
    })),
    pool,
  );
  const fresh = freshCredits.map((credit, i) => ({ credit, match: matches[i] as CreditMatch }));
  const byRef = new Map(fresh.map((f) => [f.credit.sourceRef, f.match]));

  const lines: PreviewLine[] = [...parsed.credits]
    .sort((a, b) => Number(known.has(a.sourceRef)) - Number(known.has(b.sourceRef)))
    .slice(0, 300)
    .map((c) => {
      const match = byRef.get(c.sourceRef) ?? null;
      return {
        line: c.line,
        date: c.date,
        amount: c.amount,
        description: c.description,
        reference: c.reference ?? c.txid,
        sourceRef: c.sourceRef,
        duplicate: known.has(c.sourceRef),
        status: match?.status ?? null,
        reason: match?.reason ?? null,
        suggestions: (match?.suggestions ?? []).map(suggestionView),
      };
    });

  const count = (s: MatchStatus) => fresh.filter((f) => f.match.status === s).length;
  const preview: BankStatementPreview = {
    status: 'ready',
    bank: parsed.bank,
    columnNames: parsed.columnNames,
    accountLabel: normalizeAccountLabel(input.accountLabel),
    system,
    accountHint: parsed.accountHint,
    currency,
    period: parsed.period,
    credits: parsed.credits.length,
    creditsTotal: round2(parsed.credits.reduce((s, c) => s + c.amount, 0)),
    debitsIgnored: parsed.debits,
    debitsTotal: parsed.debitsTotal,
    skipped: parsed.skipped.length,
    skippedExamples: parsed.skipped.slice(0, 5),
    duplicates: parsed.credits.length - freshCredits.length,
    newCredits: freshCredits.length,
    newTotal: round2(freshCredits.reduce((s, c) => s + c.amount, 0)),
    matched: count('matched'),
    suggested: count('suggested'),
    unmatched: count('unmatched'),
    lines,
    warnings: parsed.warnings,
  };
  return { preview, fresh };
}

/** Leer el extracto y decir qué pasaría, sin escribir nada. */
export async function previewBankStatement(
  db: SupabaseClient,
  input: BankStatementInput,
): Promise<BankPreviewResult> {
  const result = await analyze(db, input);
  return 'preview' in result ? result.preview : result;
}

export interface BankImportResult {
  status: 'imported';
  preview: BankStatementPreview;
  created: number;
  agreed: number;
  disputed: number;
  duplicates: number;
  rejected: Array<{ sourceRef: string | null; reason: string }>;
  /** Abonos que quedaron atados a su factura al entrar. */
  autoMatched: number;
  sentence: string;
}

function moneyText(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/**
 * Importar el extracto. Los abonos nuevos entran como reportes del sistema
 * «extracto · <cuenta>»; los que el emparejador confirmó solos entran ya atados
 * a su factura y a su cliente, y los demás entran sin factura y quedan en la
 * lista de conciliación con sus sugerencias.
 *
 * Reimportar es un no-op por dos lados: aquí se saltan las referencias que ya
 * estaban, y si dos importaciones corren a la vez gana el índice único de la
 * 0098 dentro de `recordPaymentReport`.
 */
export async function importBankStatement(
  db: SupabaseClient,
  input: BankStatementInput & { createdBy?: string | null; readAt?: string },
): Promise<BankImportResult | NeedsMapping> {
  const analysis = await analyze(db, input);
  if (!('preview' in analysis)) return analysis;
  const { preview, fresh } = analysis;

  const rows: SystemPaymentRow[] = fresh.map(({ credit, match }) => {
    const best = match.status === 'matched' ? match.best?.invoice : null;
    const clientId = best?.clientId ?? match.clientId ?? null;
    const clientNit = clientId ? null : (match.clientNit ?? (best?.nit || null));
    const note = [credit.description, credit.counterparty]
      .filter((t): t is string => Boolean(t))
      .join(' · ');
    return {
      sourceRef: credit.sourceRef,
      amount: credit.amount,
      currency: preview.currency,
      paidOn: credit.date,
      kind: 'payment',
      clientId,
      clientNit,
      extractionId: best?.kind === 'document' ? best.id : null,
      invoiceNumber: best?.docNumber ?? null,
      reference: (credit.reference ?? credit.txid ?? credit.description).slice(0, 200),
      note: note.slice(0, 1000) || null,
    };
  });

  const imported = await importSystemPayments(db, {
    system: preview.system,
    readAt: input.readAt,
    rows,
    createdBy: input.createdBy ?? null,
  });

  const written = new Set(
    (imported.outcomes ?? []).filter((o) => o.outcome !== 'duplicate').map((o) => o.sourceRef),
  );
  const autoMatched = fresh.filter(
    (f) => f.match.status === 'matched' && written.has(f.credit.sourceRef),
  ).length;
  const duplicates = preview.duplicates + imported.duplicates;
  const newOnes = imported.created + imported.agreed + imported.disputed;
  const account = preview.accountLabel;

  const parts: string[] = [];
  if (newOnes > 0) {
    parts.push(
      `Del extracto de «${account}» entraron ${newOnes} abono(s) por ${moneyText(preview.newTotal, preview.currency)}.`,
    );
    parts.push(
      `${autoMatched} quedaron atados a su factura sin que tengas que hacer nada; ${preview.suggested} tienen una factura sugerida para que la confirmes con un clic, y ${preview.unmatched} no tienen factura a la vista.`,
    );
  } else {
    parts.push(`Del extracto de «${account}» no entró ningún abono nuevo.`);
  }
  if (duplicates > 0) parts.push(`${duplicates} ya estaban y no se duplicaron.`);
  if (imported.agreed > 0) {
    parts.push(
      `${imported.agreed} coinciden con pagos que otra fuente ya había reportado: suben la confianza, no el importe.`,
    );
  }
  if (imported.disputed > 0) {
    parts.push(
      `${imported.disputed} no cuadran con lo que ya decía otra fuente y quedaron en disputa.`,
    );
  }
  if (preview.debitsIgnored > 0) {
    parts.push(`Las ${preview.debitsIgnored} salidas del extracto no se importan.`);
  }
  if (imported.rejected.length > 0) {
    parts.push(`${imported.rejected.length} fila(s) no se pudieron registrar.`);
  }

  return {
    status: 'imported',
    preview,
    created: imported.created,
    agreed: imported.agreed,
    disputed: imported.disputed,
    duplicates,
    rejected: imported.rejected,
    autoMatched,
    sentence: parts.join(' '),
  };
}

// ---------------------------------------------------------------------------
// La conciliación
// ---------------------------------------------------------------------------

export interface ReconItem {
  reportId: string;
  paymentId: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  reference: string | null;
  account: string | null;
  state: PaymentRow['state'];
  client: string | null;
  invoiceNumber: string | null;
  status: MatchStatus | 'disputed';
  reason: string;
  suggestions: SuggestionView[];
}

export interface BankReconciliation {
  matched: ReconItem[];
  suggested: ReconItem[];
  unmatched: ReconItem[];
  /** Los nombres de cuenta ya usados, para ofrecerlos al importar. */
  accounts: string[];
  /** Facturas abiertas, para escoger a mano una que no salió sugerida. */
  openInvoices: SuggestionView[];
}

export async function bankAccounts(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from('payment_reports')
    .select('source_system')
    .eq('source_kind', 'system')
    .like('source_system', BANK_SYSTEM_LIKE)
    .limit(5000);
  if (error) throw error;
  const labels = new Set<string>();
  for (const r of (data ?? []) as Array<{ source_system: string | null }>) {
    const label = accountLabelOf(r.source_system);
    if (label) labels.add(label);
  }
  return [...labels].sort();
}

/**
 * Lo que entró por el banco y a qué factura va: atados, por revisar (con
 * sugerencia) y sin factura. Los «por revisar» se recalculan cada vez contra
 * las facturas abiertas de este momento.
 */
export async function bankReconciliation(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<BankReconciliation> {
  const limit = Math.min(opts.limit ?? 300, SCAN);
  const { data, error } = await db
    .from('payment_reports')
    .select(REPORT_COLUMNS)
    .eq('source_kind', 'system')
    .like('source_system', BANK_SYSTEM_LIKE)
    .order('paid_on', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const reports = (data ?? []) as PaymentReportRow[];

  const ids = [...new Set(reports.map((r) => r.payment_id).filter(Boolean))] as string[];
  const payments = new Map<string, PaymentRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const read = await db
      .from('payments')
      .select(PAYMENT_COLUMNS)
      .in('id', ids.slice(i, i + 200));
    if (read.error) throw read.error;
    for (const p of await hydratePayments(db, (read.data ?? []) as PaymentRow[])) {
      payments.set(p.id, p);
    }
  }

  const [pool, accounts] = await Promise.all([loadMatchPool(db), bankAccounts(db)]);
  const out: BankReconciliation = {
    matched: [],
    suggested: [],
    unmatched: [],
    accounts,
    openInvoices: pool.invoices
      .slice()
      .sort((a, b) => (a.docNumber ?? '').localeCompare(b.docNumber ?? ''))
      .slice(0, 500)
      .map((invoice) =>
        suggestionView({
          invoice,
          score: 0,
          amountFit: 'over',
          invoiceRef: null,
          nitMatch: false,
          nameScore: 0,
          reasons: [],
        }),
      ),
  };

  const seen = new Set<string>();
  for (const report of reports) {
    const payment = report.payment_id ? payments.get(report.payment_id) : null;
    if (!payment || seen.has(payment.id) || payment.state === 'discarded') continue;
    seen.add(payment.id);
    const amount = num(report.amount) ?? 0;
    const base = {
      reportId: report.id,
      paymentId: payment.id,
      date: report.paid_on,
      amount,
      currency: report.currency,
      description: report.note ?? report.reference ?? '',
      reference: report.reference,
      account: accountLabelOf(report.source_system),
      state: payment.state,
      client: payment.client_name ?? null,
      invoiceNumber: payment.invoice_number,
    };
    if (payment.extraction_id || payment.invoice_number) {
      out.matched.push({
        ...base,
        status: 'matched',
        reason: payment.invoice_number
          ? `Atado a la factura ${payment.invoice_number}.`
          : 'Atado a su factura.',
        suggestions: [],
      });
      continue;
    }
    if (payment.state === 'disputed') {
      out.unmatched.push({
        ...base,
        status: 'disputed',
        reason: 'Está en disputa con otra fuente. Resuélvela arriba y después se ata a su factura.',
        suggestions: [],
      });
      continue;
    }
    const match = matchCredit(
      {
        amount,
        currency: report.currency,
        date: report.paid_on,
        description: report.note ?? '',
        reference: report.reference,
        nit: report.client_nit,
      },
      pool,
    );
    const item: ReconItem = {
      ...base,
      // Lo que entró sin atar nunca está «confirmado» desde la lista: confirmar
      // es un clic de una persona.
      status: match.status === 'unmatched' ? 'unmatched' : 'suggested',
      reason:
        match.status === 'matched'
          ? `Muy probable: ${match.best?.reasons.join(' y ')}. Confírmalo.`
          : match.reason,
      suggestions: match.suggestions.map(suggestionView),
    };
    if (item.status === 'suggested') out.suggested.push(item);
    else out.unmatched.push(item);
  }
  return out;
}
