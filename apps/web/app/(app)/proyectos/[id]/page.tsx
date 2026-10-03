import { ProjectDetail } from '@/components/projects/ProjectDetail';
import { companyModules } from '@/lib/modules/server';
import { detailView } from '@/lib/projects/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  isCompanyManager,
  listProducts,
  loadProjectDetail,
  unassignedLedgerExpenses,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import {
  addCostAction,
  addMilestoneAction,
  addTaskAction,
  consumeMaterialAction,
  deleteTimeAction,
  invoiceAction,
  linkLedgerAction,
  logTimeAction,
  toggleTaskAction,
  updateProjectAction,
} from '../actions';

/**
 * Un proyecto u orden de servicio (migración 0196): avance, horas y costos
 * contra el presupuesto, margen, tareas, horas, materiales, gastos, hitos de
 * facturación, documentos de ventas, equipo y línea de tiempo.
 */

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const [detail, manager, modules] = await Promise.all([
    loadProjectDetail(db, id, today),
    isCompanyManager(db, user.id),
    companyModules(user.organization.id),
  ]);
  if (!detail) notFound();
  const canManage = manager || detail.project.owner_id === user.id;
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 120 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [ledger, products] = await Promise.all([
    canManage && modules.has('finance')
      ? unassignedLedgerExpenses(db, { since, limit: 60 })
      : Promise.resolve([]),
    modules.has('inventory') ? listProducts(db, { limit: 500 }) : Promise.resolve([]),
  ]);
  const view = detailView(detail, {
    today,
    viewerId: user.id,
    canManage,
    salesEnabled: modules.has('sales'),
    inventoryEnabled: modules.has('inventory'),
    ledgerExpenses: ledger,
    products: products
      .filter((p) => p.trackStock && p.active)
      .map((p) => ({
        value: p.id,
        label: `${p.sku ? `${p.sku} · ` : ''}${p.name}${p.onHand !== null ? ` (${p.onHand.toLocaleString('es-CO')} ${p.unit})` : ''}`,
      })),
  });
  return (
    <ProjectDetail
      view={view}
      today={today}
      handlers={{
        update: updateProjectAction,
        addTask: addTaskAction,
        toggleTask: toggleTaskAction,
        logTime: logTimeAction,
        deleteTime: deleteTimeAction,
        addCost: addCostAction,
        linkLedger: linkLedgerAction,
        consumeMaterial: consumeMaterialAction,
        addMilestone: addMilestoneAction,
        invoice: invoiceAction,
      }}
    />
  );
}
