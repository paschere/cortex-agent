import { PayablesScreen } from '@/components/payables/PayablesScreen';
import { PageHeader } from '@/components/ui/page-header';
import { loadTeam } from '@/lib/clients/read';
import { type InvoiceView, invoiceView, supplierViews } from '@/lib/payables/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  PAYABLE_COLUMNS,
  type PayPlan,
  type PayableInvoiceRow,
  adaptPayable,
  bogotaToday,
  importConfirmedDocuments,
  listSuppliers,
  loadPayPlan,
  syncPaidFromLedger,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { HandCoins } from 'lucide-react';
import {
  approveInvoices,
  checkMailNow,
  markInvoicePaid,
  recheckInvoice,
  recordInvoice,
  rejectInvoices,
  reopenInvoices,
  saveSupplier,
  scheduleInvoices,
  suggestPayDates,
} from './actions';

/**
 * Por pagar: las facturas de los proveedores, de que llegan a que se pagan.
 *
 * Tres pestañas: la bandeja (todas las facturas en la grilla compartida, con
 * lo que encontró la revisión y las decisiones), el programa de pagos por
 * semana contra la caja proyectada, y los proveedores (plazo, retenciones,
 * quién aprueba). Antes de dibujar se ponen al día dos cosas baratas e
 * idempotentes: las facturas confirmadas en la Bandeja que todavía no estaban
 * aquí, y las que el banco ya pagó.
 */

export const dynamic = 'force-dynamic';

const TABS = ['bandeja', 'programa', 'proveedores'] as const;
type Tab = (typeof TABS)[number];

export default async function PagarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab: Tab = TABS.includes(q.tab as Tab) ? (q.tab as Tab) : 'bandeja';
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const canManage =
    user.role === 'org_admin' ||
    user.organization.role === 'owner' ||
    user.organization.role === 'admin';

  // Ponerse al día: si falla, la pantalla igual sale con lo que hay.
  await importConfirmedDocuments(db, { today })
    .then(() => syncPaidFromLedger(db))
    .catch((err) => logger.warn({ err }, 'payables refresh failed'));

  const [rowsRead, suppliers, team, planRead] = await Promise.all([
    db
      .from('payable_invoices')
      .select(PAYABLE_COLUMNS)
      .order('issue_date', { ascending: false })
      .limit(1000),
    listSuppliers(db),
    loadTeam(db).catch(() => []),
    loadPayPlan(db, { today })
      .then((plan): { plan: PayPlan | null; error: string | null } => ({ plan, error: null }))
      .catch((err): { plan: PayPlan | null; error: string | null } => ({
        plan: null,
        error: err instanceof Error ? err.message : 'No pude proyectar la caja.',
      })),
  ]);
  if (rowsRead.error) throw rowsRead.error;
  const rows = (rowsRead.data ?? []) as PayableInvoiceRow[];
  const names = new Map(team.map((m) => [m.id, m.name]));
  const invoices: InvoiceView[] = rows.map((r) =>
    invoiceView(adaptPayable(r), Array.isArray(r.lines) ? r.lines : [], names),
  );

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Por pagar"
        subtitle="Las facturas de tus proveedores, de que llegan a que se pagan: Cortex las revisa, tú apruebas, la caja sugiere el día. Cortex nunca paga."
        icon={<HandCoins className="h-5 w-5" aria-hidden />}
      />
      <PayablesScreen
        tab={tab}
        data={{
          today,
          invoices,
          suppliers: supplierViews(suppliers, invoices),
          plan: planRead.plan,
          planError: planRead.error,
          team,
          canManage,
        }}
        actions={{
          approve: approveInvoices,
          reject: rejectInvoices,
          reopen: reopenInvoices,
          schedule: scheduleInvoices,
          suggest: suggestPayDates,
          markPaid: markInvoicePaid,
          recheck: recheckInvoice,
          record: recordInvoice,
          saveSupplier,
          checkMail: checkMailNow,
        }}
      />
    </div>
  );
}
