import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountingProvider } from '../accounting/providers/index';
import { listAccountingConnections } from '../accounting/store';
import { KIND_LABEL as ACTION_KIND_LABEL, type ActionKind } from '../actions/shape';
import { addDays } from '../commitments/shape';
import { listCommitments } from '../commitments/store';
import { personLabel } from '../directory/line';
import { listDirectory } from '../directory/store';
import { loadExpirationSnapshot } from '../doc-expirations/autopilot';
import { loadReorderSnapshot } from '../inventory/autopilot';
import { hasLedgerCash } from '../ledger/forecast-explain';
import { runForecast } from '../ledger/plans';
import { supplierInvoicesSnapshot } from '../payables/autopilot';
import { bankReconciliation } from '../payments/bank/store';
import { moneyAtRisk } from '../payments/risk';
import { overdueReceivableInvoices } from '../payments/store';
import { listTaxObligations, readTaxProfile } from '../tax/store';
import { toolErrorMessage } from '../tool-error';
import { lastDaysPeriod, loadTeamReport } from '../work/view-sources';
import type { AutopilotSnapshot, SnapshotInvoice } from './collectors';
import { STALE_APPROVAL_HOURS } from './collectors';

/**
 * LA FOTOGRAFÍA DE LA MAÑANA: una lectura por fuente, cada una aislada.
 *
 * Si la cartera no se puede leer, el plan sale igual con la conciliación, los
 * procesos y lo demás, y dice en `errors` qué no pudo mirar. Nunca se
 * interpreta «no pude leer» como «no hay nada»: una fuente caída no deja la
 * llave puesta en el resto, ni hace creer al dueño que su cartera está al día.
 *
 * Todas las lecturas van con el handle de la empresa (getOrgScopedClient en la
 * app): ninguna puede ver filas de otra.
 */

export type SourceKey =
  | 'cartera'
  | 'pagos'
  | 'banco'
  | 'libro'
  | 'procesos'
  | 'vencimientos'
  | 'equipo'
  | 'aprobaciones'
  | 'caja'
  | 'impuestos'
  | 'inventario';

export const SOURCE_LABEL: Record<SourceKey, string> = {
  cartera: 'la cartera',
  pagos: 'los pagos de la semana',
  banco: 'los extractos del banco',
  libro: 'el libro de plata',
  procesos: 'las sincronizaciones',
  vencimientos: 'los vencimientos',
  equipo: 'el registro de trabajo',
  aprobaciones: 'las aprobaciones',
  caja: 'la proyección de caja',
  impuestos: 'el calendario tributario',
  inventario: 'el inventario',
};

interface ContactRow {
  client_id: string;
  full_name: string | null;
  email: string | null;
  is_primary: boolean | null;
  status: string | null;
}

/** El contacto de cobro de cada cliente: el principal si tiene correo; si no, el primero activo. */
export async function collectionContacts(
  db: SupabaseClient,
  clientIds: string[],
): Promise<Map<string, { name: string | null; email: string }>> {
  const out = new Map<string, { name: string | null; email: string }>();
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return out;
  const { data, error } = await db
    .from('client_contacts')
    .select('client_id, full_name, email, is_primary, status')
    .in('client_id', ids)
    .not('email', 'is', null)
    .limit(2000);
  if (error) throw error;
  const rows = ((data ?? []) as ContactRow[])
    .filter((r) => r.email?.includes('@') && r.status !== 'left')
    .sort((a, b) => Number(b.is_primary === true) - Number(a.is_primary === true));
  for (const r of rows) {
    if (!out.has(r.client_id) && r.email)
      out.set(r.client_id, { name: r.full_name, email: r.email.trim().toLowerCase() });
  }
  return out;
}

async function overdueWithContacts(db: SupabaseClient, today: string): Promise<SnapshotInvoice[]> {
  const invoices = await overdueReceivableInvoices(db, { today });
  const contacts = await collectionContacts(
    db,
    invoices.map((i) => i.clientId ?? ''),
  );
  return invoices.map((i) => ({
    id: i.id,
    source: i.source,
    docNumber: i.docNumber,
    clientId: i.clientId,
    counterparty: i.counterparty,
    currency: i.currency,
    balance: i.balance,
    dueOn: i.dueOn,
    daysOverdue: i.daysOverdue,
    contact: i.clientId ? (contacts.get(i.clientId) ?? null) : null,
  }));
}

async function uncategorized(db: SupabaseClient) {
  const { data, error } = await db
    .from('ledger_movements')
    .select('amount, currency, status')
    .is('category', null)
    .neq('kind', 'transfer')
    .is('duplicate_of', null)
    .limit(2000);
  if (error) throw error;
  const rows = (
    (data ?? []) as Array<{ amount: number | string; currency: string; status: string }>
  ).filter((r) => r.status !== 'cancelled');
  const cop = rows.filter((r) => (r.currency ?? 'COP').toUpperCase() === 'COP');
  return {
    count: rows.length,
    amount: cop.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0),
    currency: 'COP',
  };
}

async function failingSyncs(db: SupabaseClient): Promise<NonNullable<AutopilotSnapshot['syncs']>> {
  const out: NonNullable<AutopilotSnapshot['syncs']> = [];
  const drive = await db
    .from('drive_folder_syncs')
    .select('id, folder_name, last_run_at, last_error')
    .eq('enabled', true)
    .eq('last_status', 'error')
    .limit(20);
  if (drive.error) throw drive.error;
  for (const r of (drive.data ?? []) as Array<{
    id: string;
    folder_name: string | null;
    last_run_at: string | null;
    last_error: string | null;
  }>)
    out.push({
      kind: 'drive_folder',
      id: r.id,
      name: r.folder_name ?? 'Carpeta de Drive',
      lastRunAt: r.last_run_at,
      lastError: r.last_error,
    });

  const tables = await db
    .from('tracker_syncs')
    .select('id, tracker_id, last_run_at, last_error')
    .eq('enabled', true)
    .eq('last_status', 'error')
    .limit(20);
  if (tables.error) throw tables.error;
  const trows = (tables.data ?? []) as Array<{
    id: string;
    tracker_id: string;
    last_run_at: string | null;
    last_error: string | null;
  }>;
  const names = new Map<string, string>();
  if (trows.length) {
    const t = await db
      .from('trackers')
      .select('id, name')
      .in(
        'id',
        trows.map((r) => r.tracker_id),
      );
    if (t.error) throw t.error;
    for (const r of (t.data ?? []) as Array<{ id: string; name: string }>) names.set(r.id, r.name);
  }
  for (const r of trows)
    out.push({
      kind: 'table_sync',
      id: r.id,
      name: names.get(r.tracker_id) ?? 'una tabla',
      lastRunAt: r.last_run_at,
      lastError: r.last_error,
    });

  for (const c of await listAccountingConnections(db)) {
    if (!c.enabled || c.last_status !== 'error') continue;
    out.push({
      kind: 'accounting',
      id: c.id,
      name: getAccountingProvider(c.provider)?.name ?? c.provider,
      provider: c.provider,
      lastRunAt: c.last_run_at,
      lastError: c.last_error,
    });
  }
  return out;
}

async function staleApprovals(db: SupabaseClient, now: Date, names: Map<string, string>) {
  const cutoff = new Date(now.getTime() - STALE_APPROVAL_HOURS * 3_600_000).toISOString();
  const { data, error } = await db
    .from('actions')
    .select('id, user_id, kind, recipient, subject, created_at, expires_at')
    .eq('state', 'proposed')
    .lte('created_at', cutoff)
    .gt('expires_at', now.toISOString())
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return (
    (data ?? []) as Array<{
      id: string;
      user_id: string;
      kind: ActionKind;
      recipient: string;
      subject: string;
      created_at: string;
      expires_at: string;
    }>
  ).map((a) => ({
    id: a.id,
    userId: a.user_id,
    ownerName: names.get(a.user_id) ?? null,
    kindLabel: ACTION_KIND_LABEL[a.kind] ?? 'Propuesta',
    recipient: a.recipient,
    subject: a.subject,
    createdAt: a.created_at,
    expiresAt: a.expires_at,
  }));
}

/**
 * Arma la fotografía. Cada fuente en su propio try; lo que falla queda
 * `undefined` en la fotografía y nombrado en `errors`.
 */
export async function loadSnapshot(
  db: SupabaseClient,
  opts: { today: string; now: Date },
): Promise<{ snapshot: AutopilotSnapshot; errors: Array<{ source: string; message: string }> }> {
  const { today, now } = opts;
  const errors: Array<{ source: string; message: string }> = [];
  const attempt = async <T>(source: SourceKey, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ source: SOURCE_LABEL[source], message: toolErrorMessage(err) });
      return undefined;
    }
  };

  // El directorio, una vez: los nombres de responsables y dueños.
  const directory = await attempt('vencimientos', () => listDirectory(db));
  const names = new Map((directory ?? []).map((p) => [p.id, personLabel(p)]));

  // Fuera del Promise.all para no tocar su forma, pero en paralelo con él: una
  // lectura más, aislada como las demás. Sin perfil tributario, lista vacía.
  const taxRead = attempt('impuestos', () => taxSnapshot(db, today, names));
  // Documentos que vencen (0184): igual, aparte y en paralelo.
  const docsRead = attempt('vencimientos', () => loadExpirationSnapshot(db, today, names));
  // Facturas de proveedor por aprobar (0181): igual, aparte y en paralelo.
  const supplierRead = attempt('pagos', () => supplierInvoicesSnapshot(db));
  // Lo que hay que reponer (0183): igual, aparte y en paralelo.
  const reorderRead = attempt('inventario', () => loadReorderSnapshot(db, today));
  const [overdueInvoices, risk, recon, ledger, syncs, commitments, team, approvals, forecast] =
    await Promise.all([
      attempt('cartera', () => overdueWithContacts(db, today)),
      attempt('pagos', () => moneyAtRisk(db, { today })),
      attempt('banco', () => bankReconciliation(db, { limit: 300 })),
      attempt('libro', () => uncategorized(db)),
      attempt('procesos', () => failingSyncs(db)),
      attempt('vencimientos', () =>
        listCommitments(db, {
          states: ['due_soon', 'overdue'],
          today,
          dueBefore: addDays(today, 2),
          limit: 300,
        }),
      ),
      attempt('equipo', () => loadTeamReport(db, lastDaysPeriod(today, 30), { today })),
      attempt('aprobaciones', () => staleApprovals(db, now, names)),
      attempt('caja', () => runForecast(db, { today })),
    ]);
  const tax = await taxRead;
  const documentExpirations = await docsRead;
  const supplierInvoices = await supplierRead;
  const reorder = await reorderRead;

  const snapshot: AutopilotSnapshot = {
    today,
    overdueInvoices,
    payments: risk
      ? {
          overdueAmount: risk.cop.paymentsOverdue,
          dueSoonAmount: risk.cop.paymentsDueSoon,
          commitments: risk.cop.paymentCommitments,
          finesPending: risk.cop.finesPending,
        }
      : undefined,
    reconciliation: recon?.suggested.map((r) => ({
      paymentId: r.paymentId,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      description: r.description,
      client: r.client,
      reason: r.reason,
      suggestions: r.suggestions.map((s) => ({
        kind: s.kind,
        id: s.id,
        docNumber: s.docNumber,
        clientName: s.clientName,
        exact: s.exact,
        reasons: s.reasons,
      })),
    })),
    uncategorized: ledger,
    syncs,
    commitments: commitments?.map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind,
      counterparty: c.counterparty,
      amountCop: c.amount_cop,
      dueOn: c.due_on,
      ownerUserId: c.owner_user_id,
      ownerName: c.owner_user_id ? (names.get(c.owner_user_id) ?? null) : null,
    })),
    taxObligations: tax,
    documentExpirations,
    signals: team?.report.signals,
    staleApprovals: approvals,
    supplierInvoices,
    reorder,
    cash:
      forecast && hasLedgerCash(forecast.base)
        ? {
            currency: forecast.base.currency,
            alerts: forecast.base.alerts,
            lowestWeek: forecast.base.lowest?.week ?? null,
            lowestClosing: forecast.base.lowest?.closing ?? null,
          }
        : undefined,
  };
  return { snapshot, errors };
}

/**
 * Las obligaciones tributarias pendientes de los próximos días (0180), con el
 * responsable del perfil. Sin perfil, una lista vacía: no es un error.
 */
async function taxSnapshot(
  db: SupabaseClient,
  today: string,
  names: Map<string, string>,
): Promise<NonNullable<AutopilotSnapshot['taxObligations']>> {
  const profile = await readTaxProfile(db);
  if (!profile) return [];
  const rows = await listTaxObligations(db, {
    from: today,
    to: addDays(today, 7),
    statuses: ['pendiente'],
    limit: 50,
  });
  return rows.map((o) => ({
    id: o.id,
    title: o.title,
    authority: o.authority,
    dueOn: o.dueDate,
    commitmentId: o.commitmentId,
    needsConfirmation: o.needsConfirmation,
    ownerUserId: profile.ownerUserId,
    ownerName: profile.ownerUserId ? (names.get(profile.ownerUserId) ?? null) : null,
  }));
}
