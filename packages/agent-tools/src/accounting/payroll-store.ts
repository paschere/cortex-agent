import type { SupabaseClient } from '@supabase/supabase-js';
import { isCompanyManager } from '../directory/store';
import {
  type NormalizedPayrollJournal,
  type PayrollLineRow,
  type PayrollPeriodTotals,
  type PayrollPerson,
  summarizePayrollPeople,
  summarizePayrollPeriods,
} from './payroll';
import { planPayrollSync } from './payroll-plan';
import type { PurchaseCursor } from './purchase-plan';
import { nextPurchaseCursor } from './purchase-plan';
import type { ProviderSession } from './types';

/**
 * LA NÓMINA TRAÍDA DEL PROGRAMA CONTABLE, EN LA BASE (migración 0217).
 *
 * `db` es el handle de la empresa (getOrgScopedClient / `ctx.db`): nada aquí
 * filtra por organization_id a mano.
 *
 * LA REGLA DE QUIÉN VE QUÉ VIVE AQUÍ (`readPayrollView`), igual que en
 * payroll/store.ts: el detalle por persona lo ve sólo quien administra la
 * empresa o es su dueño (`isCompanyManager`); cualquier otra persona recibe
 * totales por periodo y concepto, sin una sola identificación. Si no se puede
 * saber quién mira, se trata como no administrador (falla cerrado).
 */

const TABLE = 'accounting_payroll_lines';
const CHUNK = 400;
const PAGE = 1000;

/** Guarda los comprobantes: reemplaza las líneas de cada uno (re-traerlo no duplica). */
export async function replacePayrollJournals(
  db: SupabaseClient,
  system: string,
  journals: readonly NormalizedPayrollJournal[],
): Promise<{ journals: number; lines: number }> {
  const unique = [...new Map(journals.map((j) => [j.journalId, j])).values()];
  if (!unique.length) return { journals: 0, lines: 0 };
  const now = new Date().toISOString();
  const ids = unique.map((j) => j.journalId);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await db
      .from(TABLE)
      .delete()
      .eq('source_system', system)
      .in('journal_id', ids.slice(i, i + CHUNK));
    if (error) throw error;
  }
  const rows = unique.flatMap((j) =>
    j.lines.map((l) => ({
      source_system: system,
      journal_id: j.journalId,
      line_index: l.lineIndex,
      journal_name: j.name ?? null,
      journal_date: j.date,
      period: j.period,
      account_code: l.accountCode,
      movement: l.movement,
      concept_group: l.group,
      concept: l.concept,
      amount: l.amount,
      currency: j.currency,
      person_tax_id: l.personTaxId ?? null,
      description: l.description ?? null,
      synced_at: now,
    })),
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from(TABLE).upsert(rows.slice(i, i + CHUNK), {
      onConflict: 'organization_id,source_system,journal_id,line_index',
    });
    if (error) throw error;
  }
  return { journals: unique.length, lines: rows.length };
}

export interface PayrollSyncResult {
  cursor: PurchaseCursor;
  /** Quedan páginas: la conexión debe volver a encolarse. */
  partial: boolean;
  seen: number;
  journals: number;
  lines: number;
}

/**
 * Una tanda de la sincronización de nómina de una conexión: hasta `maxPages`
 * páginas desde donde iba. NO toca la conexión: quien llama guarda `cursor`
 * sólo si esto no lanzó (así un error repite la tanda, que es idempotente).
 */
export async function runPayrollSync(
  db: SupabaseClient,
  session: Pick<ProviderSession, 'listPayroll'>,
  opts: {
    system: string;
    cursor: PurchaseCursor | undefined;
    now?: Date;
    maxPages?: number;
  },
): Promise<PayrollSyncResult> {
  const now = opts.now ?? new Date();
  if (!session.listPayroll) throw new Error('Este programa no entrega nómina.');
  const plan = planPayrollSync(opts.cursor, now);
  const maxPages = opts.maxPages ?? 10;
  let page = plan.page;
  let hasMore = false;
  let seen = 0;
  let journals = 0;
  let lines = 0;
  for (let n = 0; n < maxPages; n++, page++) {
    const r = await session.listPayroll(plan.since, page);
    seen += r.seen;
    const saved = await replacePayrollJournals(db, opts.system, r.journals);
    journals += saved.journals;
    lines += saved.lines;
    hasMore = r.hasMore;
    if (!hasMore) break;
  }
  const next = hasMore ? page : null;
  return {
    cursor: nextPurchaseCursor(opts.cursor, plan, next, now),
    partial: hasMore,
    seen,
    journals,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Lectura con privacidad
// ---------------------------------------------------------------------------

interface LineDbRow {
  journal_id: string;
  period: string;
  account_code: string;
  movement: 'debit' | 'credit';
  concept_group: PayrollLineRow['group'];
  concept: string;
  amount: number | string;
  person_tax_id: string | null;
}

export async function readPayrollRows(
  db: SupabaseClient,
  opts: { fromPeriod?: string; period?: string },
): Promise<PayrollLineRow[]> {
  const out: PayrollLineRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from(TABLE)
      .select(
        'journal_id, period, account_code, movement, concept_group, concept, amount, person_tax_id',
      )
      .order('period', { ascending: false })
      .order('journal_id')
      .order('line_index')
      .range(from, from + PAGE - 1);
    if (opts.period) q = q.eq('period', opts.period);
    else if (opts.fromPeriod) q = q.gte('period', opts.fromPeriod);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as LineDbRow[];
    for (const r of rows)
      out.push({
        journalId: r.journal_id,
        period: r.period,
        accountCode: r.account_code,
        movement: r.movement,
        group: r.concept_group,
        concept: r.concept,
        amount: Number(r.amount),
        personTaxId: r.person_tax_id,
      });
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface PayrollViewPerson extends PayrollPerson {
  /** El nombre, si esa identificación es de alguien de la nómina de Cortex. */
  name: string | null;
}

export interface PayrollView {
  periods: PayrollPeriodTotals[];
  /** Por persona del periodo pedido. SIEMPRE vacío si quien mira no administra. */
  people: PayrollViewPerson[];
  /** ¿Quien mira vio el detalle por persona? */
  detail: boolean;
  /** Había detalle por persona pero se ocultó por privacidad. */
  detailHidden: boolean;
}

function monthsBack(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - months, 1));
  return d.toISOString().slice(0, 7);
}

export async function readPayrollView(
  db: SupabaseClient,
  opts: { viewerId: string | null | undefined; months?: number; period?: string; today: string },
): Promise<PayrollView> {
  const months = Math.min(Math.max(opts.months ?? 6, 1), 36);
  const fromPeriod = monthsBack(opts.today.slice(0, 7), months - 1);
  const rows = await readPayrollRows(db, opts.period ? { period: opts.period } : { fromPeriod });
  const periods = summarizePayrollPeriods(rows);
  const target = opts.period ?? periods[0]?.period;
  const manager = await isCompanyManager(db, opts.viewerId);
  const targetRows = target ? rows.filter((r) => r.period === target) : [];
  const people = manager && target ? summarizePayrollPeople(targetRows) : [];
  const detailHidden = !manager && targetRows.some((r) => r.personTaxId);

  let named: PayrollViewPerson[] = people.map((p) => ({ ...p, name: null }));
  if (named.length) {
    const { data, error } = await db
      .from('employees')
      .select('full_name, document_number')
      .in(
        'document_number',
        named.map((p) => p.taxId),
      );
    if (!error) {
      const byDoc = new Map(
        ((data ?? []) as Array<{ full_name: string; document_number: string }>).map((e) => [
          e.document_number.replace(/\D/g, ''),
          e.full_name,
        ]),
      );
      named = named.map((p) => ({ ...p, name: byDoc.get(p.taxId) ?? null }));
    }
  }
  return {
    periods,
    people: named,
    detail: manager,
    detailHidden,
  };
}
