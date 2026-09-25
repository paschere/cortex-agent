/**
 * La forma de la consola del fundador: qué fila sale, en qué orden y con qué
 * filtro. Puro, sin base de datos, para que el componente de cliente y sus
 * pruebas (founder-console-shape.test.ts) compartan la misma lógica.
 *
 * El orden responde a «¿dónde entro primero?»: la empresa activa de la pestaña
 * arriba, luego las que tienen algo esperando decisión, luego las empresas
 * propias antes que aquellas donde se es gerente o colaborador, y el espacio
 * personal al final — está siempre ahí y rara vez es lo urgente.
 */

import type { WorkspaceKind } from '@cortex/core';
import type { CompanyHealth } from './founder-console';
import type { FounderOverviewData, WorkspacePulse } from './founder-overview';

export interface ConsoleRow {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspacePulse['workspace']['role'];
  active: boolean;
  owned: boolean;
  groupId: string | null;
  pulse: {
    status: WorkspacePulse['status'];
    approvals: number;
    actions: number;
    deadlines: number | null;
    blocked: number | null;
    /** Suma de las cuatro señales; lo que decide «Revisar» frente a «Abrir». */
    pending: number;
  };
  health: CompanyHealth | null;
}

export function buildConsoleRows(
  overview: FounderOverviewData,
  health: Readonly<Record<string, CompanyHealth>>,
  groupOf: Readonly<Record<string, string>>,
  activeId: string,
): ConsoleRow[] {
  const rows = overview.workspaces.map((item): ConsoleRow => {
    const kind = item.workspace.kind === 'personal' ? 'personal' : 'company';
    const owned = kind === 'company' && item.workspace.role === 'owner';
    const pending =
      item.status === 'ready'
        ? item.approvals + item.actions + (item.deadlines ?? 0) + (item.blocked ?? 0)
        : 0;
    return {
      id: item.workspace.id,
      name: item.workspace.name,
      kind,
      role: item.workspace.role,
      active: item.workspace.id === activeId,
      owned,
      groupId: groupOf[item.workspace.id] ?? null,
      pulse: {
        status: item.status,
        approvals: item.approvals,
        actions: item.actions,
        deadlines: item.deadlines,
        blocked: item.blocked,
        pending,
      },
      // Sólo las propias traen lectura de administración (ver founder-console.ts).
      health: owned ? (health[item.workspace.id] ?? null) : null,
    };
  });
  const rank = (row: ConsoleRow) =>
    (row.active ? 0 : 1) * 8 +
    (row.pulse.pending > 0 ? 0 : 1) * 4 +
    (row.owned ? 0 : 1) * 2 +
    (row.kind === 'personal' ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'es'));
}

/** `all`, `ungrouped` o el id de un grupo. */
export type GroupFilter = 'all' | 'ungrouped' | (string & {});

/**
 * Filtrar por grupo. El espacio personal y las empresas ajenas nunca están en
 * un grupo (0140 sólo admite empresas propias), así que «Sin grupo» las
 * incluye y un grupo concreto no.
 */
export function filterRows(rows: readonly ConsoleRow[], filter: GroupFilter): ConsoleRow[] {
  if (filter === 'all') return [...rows];
  if (filter === 'ungrouped') return rows.filter((row) => row.groupId === null);
  return rows.filter((row) => row.groupId === filter);
}

/** Totales de administración sobre las empresas propias que sí respondieron. */
export function founderTotals(rows: readonly ConsoleRow[]) {
  let members = 0;
  let pendingInvitations = 0;
  let failedRoutines = 0;
  let attention = 0;
  for (const row of rows) {
    if (!row.health) continue;
    members += row.health.members;
    pendingInvitations += row.health.pendingInvitations;
    failedRoutines += row.health.routines?.failedRecently ?? 0;
    if (row.health.health.tone === 'amber' || row.health.health.tone === 'rose') attention += 1;
  }
  return { members, pendingInvitations, failedRoutines, attention };
}

/** «3 de 5», «sin tope» — cómo se lee un asiento. */
export function seatsLabel(seats: CompanyHealth['seats']): string {
  if (!seats) return '—';
  return seats.maximum === null ? `${seats.used} · sin tope` : `${seats.used} de ${seats.maximum}`;
}

/** Porcentaje del cupo de respuestas, acotado para dibujar la barra. */
export function answersPercent(answers: CompanyHealth['answers']): number | null {
  if (!answers || answers.ratio === null) return null;
  return Math.max(0, Math.min(100, Math.round(answers.ratio * 100)));
}
