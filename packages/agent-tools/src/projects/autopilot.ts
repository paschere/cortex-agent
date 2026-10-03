import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotProject, SnapshotProjects } from './autopilot-collect';
import { type ProjectSummary, loadProjectsOverview } from './store';

/** La lectura de la mañana para el piloto (0196): lo pasado de presupuesto y lo sin facturar. */
export async function loadProjectsSnapshot(
  db: SupabaseClient,
  today: string,
): Promise<SnapshotProjects | undefined> {
  const { projects } = await loadProjectsOverview(db, today, {
    statuses: ['abierto', 'en_curso', 'en_pausa', 'terminado'],
  });
  if (!projects.length) return undefined;
  const snap = (s: ProjectSummary): SnapshotProject => ({
    id: s.project.id,
    code: s.project.code,
    title: s.project.title,
    client: s.project.client_name,
    currency: s.project.currency,
    costTotal: s.metrics.costs.total,
    budget: s.metrics.costs.budget,
    hoursUsed: s.metrics.hours.used,
    budgetHours: s.metrics.hours.budget,
    margin: s.metrics.margin.amount,
    unbilled: s.metrics.revenue.unbilled,
    status: s.project.status,
  });
  const over = projects.filter((s) =>
    s.metrics.alerts.some((a) =>
      ['sobre_presupuesto', 'horas_excedidas', 'margen_negativo'].includes(a.kind),
    ),
  );
  const unbilled = projects.filter((s) => s.metrics.alerts.some((a) => a.kind === 'sin_facturar'));
  if (!over.length && !unbilled.length) return undefined;
  return { overBudget: over.map(snap), unbilled: unbilled.map(snap) };
}
