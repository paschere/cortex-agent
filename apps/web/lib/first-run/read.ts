import 'server-only';
import {
  bogotaToday,
  getSyncState,
  isCompanyManager,
  readAutopilotSettings,
  readModuleStates,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type Finding, type FindingsInput, buildFindings } from './findings';
import {
  type IngestionCounts,
  type ProgressView,
  describeProgress,
  stillLoading,
} from './progress';
import type { FirstRunFacts, InterviewState } from './steps';

/**
 * LECTURAS DE LOS PRIMEROS 15 MINUTOS.
 *
 * Todo con el cliente del espacio (nada cruza empresas), conteos `head` o
 * consultas con tope, y cada lectura aislada: una que falle cuesta su línea,
 * nunca el recorrido. El correo es de quien mira y de nadie más.
 */

type Db = SupabaseClient;
const head = { count: 'exact' as const, head: true };

async function safeCount(
  q: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  try {
    const r = await q;
    return r.error ? 0 : (r.count ?? 0);
  } catch {
    return 0;
  }
}

async function safeRows<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const r = await q;
    return r.error ? [] : ((r.data as T[] | null) ?? []);
  } catch {
    return [];
  }
}

export async function readFirstRunFacts(db: Db, userId: string): Promise<FirstRunFacts> {
  const [states, google, accounting, whatsapp, interview, autopilot] = await Promise.all([
    readModuleStates(db).catch(() => null),
    safeCount(
      db.from('integrations').select('id', head).eq('user_id', userId).eq('provider', 'google'),
    ),
    safeCount(db.from('accounting_connections').select('id', head).eq('enabled', true)),
    safeCount(db.from('whatsapp_sessions').select('id', head).eq('status', 'connected')),
    safeRows<{ status: string }>(
      db
        .from('guided_setup_sessions')
        .select('status')
        .order('created_at', { ascending: false })
        .limit(1),
    ),
    readAutopilotSettings(db).catch(() => null),
  ]);
  const raw = interview[0]?.status;
  const interviewState: InterviewState =
    raw === 'applied'
      ? 'applied'
      : raw === 'proposed'
        ? 'proposed'
        : raw === 'interviewing'
          ? 'talking'
          : 'none';
  return {
    // Sin lectura de módulos no se puede decir «no contestó»: no se bloquea el paso.
    modulesAnswered: states ? states.some((s) => !s.isDefault) : true,
    googleConnected: google > 0,
    accountingConnected: accounting > 0,
    whatsappConnected: whatsapp > 0,
    interviewState,
    autopilotEnabled: autopilot?.enabled === true,
  };
}

export async function readIngestionCounts(db: Db, userId: string): Promise<IngestionCounts> {
  const [
    ready,
    pending,
    failed,
    invoices,
    payables,
    sheets,
    mail,
    syncing,
    accounting,
    whatsapp,
    google,
  ] = await Promise.all([
    safeCount(db.from('kb_documents').select('id', head).eq('status', 'ready')),
    safeCount(db.from('kb_documents').select('id', head).in('status', ['pending', 'ingesting'])),
    safeCount(db.from('kb_documents').select('id', head).eq('status', 'failed')),
    safeCount(db.from('accounting_invoices').select('id', head)),
    safeCount(db.from('payable_invoices').select('id', head)),
    safeCount(db.from('tracker_syncs').select('id', head).eq('enabled', true)),
    getSyncState(db, userId).catch(() => null),
    safeCount(db.from('accounting_connections').select('id', head).eq('last_status', 'partial')),
    safeCount(db.from('accounting_connections').select('id', head).eq('enabled', true)),
    safeCount(db.from('whatsapp_sessions').select('id', head).eq('status', 'connected')),
    safeCount(
      db.from('integrations').select('id', head).eq('user_id', userId).eq('provider', 'google'),
    ),
  ]);
  // Una conexión contable nueva (sin primera corrida) también cuenta como «trayendo».
  const neverRan = await safeCount(
    db
      .from('accounting_connections')
      .select('id', head)
      .eq('enabled', true)
      .is('last_run_at', null),
  );
  return {
    documentsReady: ready,
    documentsPending: pending,
    documentsFailed: failed,
    invoices,
    payables,
    sheets,
    mailThreads: mail?.backfillThreads ?? 0,
    mailRunning: !!mail && !mail.paused && !mail.backfillDoneAt,
    accountingSyncing: syncing + neverRan > 0,
    accountingConnected: accounting > 0,
    whatsappConnected: whatsapp > 0,
    googleConnected: google > 0,
  };
}

const CAP = 500;

/** Los insumos de los hallazgos. Sólo para quien administra: hay plata y papeles. */
export async function readFindingsInput(db: Db): Promise<FindingsInput> {
  const today = bogotaToday();
  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const [open, payRows, expRows, recent, overdueCommit, docs] = await Promise.all([
    safeRows<{
      counterparty_name: string | null;
      balance: number | string;
      due_on: string;
      currency: string;
    }>(
      db
        .from('accounting_invoices')
        .select('counterparty_name, balance, due_on, currency')
        .gt('balance', 0)
        .eq('annulled', false)
        .lt('due_on', today)
        .order('balance', { ascending: false })
        .limit(CAP),
    ),
    safeRows<{
      supplier_name: string;
      due_date: string | null;
      total: number | string;
      currency: string;
    }>(
      db
        .from('payable_invoices')
        .select('supplier_name, due_date, total, currency')
        .not('status', 'in', '(pagada,rechazada)')
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(CAP),
    ),
    safeRows<{ title: string; expires_on: string | null }>(
      db
        .from('document_expirations')
        .select('title, expires_on')
        .not('status', 'in', '(renovado,descartado)')
        .not('expires_on', 'is', null)
        .order('expires_on', { ascending: true })
        .limit(20),
    ),
    safeRows<{ counterparty_name: string | null }>(
      db
        .from('accounting_invoices')
        .select('counterparty_name')
        .eq('annulled', false)
        .gte('issued_on', since90)
        .limit(CAP),
    ),
    safeRows<{ title: string; due_on: string }>(
      db
        .from('commitments')
        .select('title, due_on')
        .in('state', ['in_force', 'due_soon', 'overdue'])
        .eq('review_state', 'confirmed')
        .lt('due_on', today)
        .order('due_on', { ascending: true })
        .limit(50),
    ),
    safeCount(db.from('kb_documents').select('id', head).eq('status', 'ready')),
  ]);

  const currency = open[0]?.currency ?? 'COP';
  const sameCur = open.filter((r) => r.currency === currency);
  const receivables = {
    count: sameCur.length,
    total: sameCur.reduce((a, r) => a + Number(r.balance), 0),
    currency,
    top: sameCur.slice(0, 3).map((r) => ({
      name: r.counterparty_name ?? 'un cliente sin nombre',
      balance: Number(r.balance),
      daysLate: Math.max(
        0,
        Math.round(
          (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.due_on}T00:00:00Z`)) / 86_400_000,
        ),
      ),
    })),
  };

  const payCur = payRows[0]?.currency ?? 'COP';
  const pays = payRows.filter((r) => r.currency === payCur);
  const nextPay = pays.find((r) => r.due_date && r.due_date >= today) ?? null;
  const payables = {
    count: pays.length,
    total: pays.reduce((a, r) => a + Number(r.total), 0),
    currency: payCur,
    next: nextPay?.due_date
      ? { supplier: nextPay.supplier_name, dueOn: nextPay.due_date, total: Number(nextPay.total) }
      : null,
  };

  const byClient = new Map<string, number>();
  for (const r of recent) {
    const name = r.counterparty_name?.trim();
    if (name) byClient.set(name, (byClient.get(name) ?? 0) + 1);
  }
  const topClients = [...byClient.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, invoices]) => ({ name, invoices }));

  return {
    today,
    receivables,
    payables,
    expiring: expRows.flatMap((e) =>
      e.expires_on ? [{ title: e.title, expiresOn: e.expires_on }] : [],
    ),
    topClients,
    commitments: { overdue: overdueCommit.length, oldestTitle: overdueCommit[0]?.title ?? null },
    documentsReady: docs,
  };
}

export interface FirstRunSnapshot {
  progress: ProgressView;
  loadingNotes: string[];
  findings: Finding[];
  /** Los hallazgos con plata o papeles sólo los ve quien administra. */
  restricted: boolean;
}

export async function readFirstRunSnapshot(
  db: Db,
  userId: string,
  opts: { withFindings: boolean },
): Promise<FirstRunSnapshot> {
  const counts = await readIngestionCounts(db, userId);
  const progress = describeProgress(counts);
  if (!opts.withFindings)
    return { progress, loadingNotes: stillLoading(counts), findings: [], restricted: false };
  const manager = await isCompanyManager(db, userId).catch(() => false);
  const findings = manager ? buildFindings(await readFindingsInput(db)) : [];
  return { progress, loadingNotes: stillLoading(counts), findings, restricted: !manager };
}

/**
 * ¿Ya hay datos REALES de la empresa? Con que haya una sola cosa, el recorrido
 * con datos de ejemplo (components/tour) sobra: se oculta.
 */
export async function workspaceHasRealData(db: Db): Promise<boolean> {
  const counts = await Promise.all([
    safeCount(db.from('kb_documents').select('id', head).limit(1)),
    safeCount(db.from('accounting_invoices').select('id', head).limit(1)),
    safeCount(db.from('payable_invoices').select('id', head).limit(1)),
    safeCount(db.from('tracker_syncs').select('id', head).limit(1)),
  ]);
  return counts.some((c) => c > 0);
}
