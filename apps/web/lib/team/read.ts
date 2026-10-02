import 'server-only';
import { workspaceHref } from '@/lib/workspace-context';
import {
  type TeamWorkReport,
  type WorkItem,
  type WorkPeriod,
  type WorkSettings,
  loadTeamReport,
  readWorkSettings,
  syncWork,
  workItemsForPeriod,
  workScope,
  workSyncIsStale,
} from '@cortex/agent-tools';
import type { SessionUser } from '@cortex/core';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TeamHrefs } from './screen';
import { addDaysIso, chatPath, mondayOfIso } from './shape';

/**
 * LO QUE LAS PANTALLAS DE «EQUIPO» LEEN DE LA BASE.
 *
 * Todo pasa por el registro de trabajo (packages/agent-tools/src/work): el
 * reporte lo arma `loadTeamReport` con el motor puro, y quién ve qué lo decide
 * `workScope` (work/access.ts), la misma regla del chat y de las vistas. Lo
 * único que se agrega aquí: quien es DUEÑO de la empresa (fundador) administra
 * el equipo igual que un `org_admin` (ve todo, reasigna, configura, edita días
 * fuera), como en /team/activity.
 */

export interface TeamViewer {
  id: string;
  /**
   * Administra el equipo: `users.role = 'org_admin'` O dueño de la empresa
   * (`managesTeam`). La regla de work.assign, work.configure y los días fuera
   * de otros, igual que `isWorkAdmin` en el chat.
   */
  admin: boolean;
  /** Dueño de la empresa (no de un espacio personal). */
  founder: boolean;
  /** Ve a todo el equipo y lo que no tiene responsable. */
  seesAll: boolean;
  /** Personas visibles; `null` = todas. */
  visibleIds: ReadonlySet<string> | null;
}

export function isFounder(user: SessionUser): boolean {
  return user.organization.kind === 'company' && user.organization.role === 'owner';
}

/**
 * ¿Puede administrar el equipo? Quien administra (`org_admin`) o el DUEÑO de la
 * empresa: decisión del dueño, los fundadores tienen los mismos poderes de
 * equipo que un administrador. El rol del espacio sale de `ba_member` en esta
 * petición (lib/session.ts), nunca del navegador.
 */
export function managesTeam(user: SessionUser): boolean {
  return user.role === 'org_admin' || isFounder(user);
}

export async function teamViewer(db: SupabaseClient, user: SessionUser): Promise<TeamViewer> {
  const founder = isFounder(user);
  const admin = managesTeam(user);
  if (admin || founder) return { id: user.id, admin, founder, seesAll: true, visibleIds: null };
  const scope = await workScope(db, user.id);
  return {
    id: user.id,
    admin,
    founder,
    seesAll: scope.visibleIds === null,
    visibleIds: scope.visibleIds,
  };
}

/** Si el registro lleva más de esto sin refrescarse, se refresca antes de pintar (como work.query). */
const STALE_MS = 6 * 3_600_000;

/**
 * El reporte del período, refrescando antes el registro si quedó viejo. Un
 * refresco que falla no tumba la pantalla: se pinta lo último que había.
 */
export async function readTeamReport(
  db: SupabaseClient,
  organizationId: string,
  period: WorkPeriod,
  today: string,
): Promise<{
  report: TeamWorkReport;
  items: WorkItem[];
  truncated: boolean;
  settings: WorkSettings;
}> {
  let settings = await readWorkSettings(db);
  if (workSyncIsStale(settings.lastSyncedAt, new Date(), STALE_MS)) {
    try {
      await syncWork(db, organizationId);
      settings = await readWorkSettings(db);
    } catch (err) {
      logger.warn({ err, organizationId }, 'team: no se pudo refrescar el registro de trabajo');
    }
  }
  const { report, items, truncated } = await loadTeamReport(db, period, { today });
  return { report, items, truncated, settings };
}

/** El trabajo de una persona en las últimas ocho semanas, para sus tendencias. */
export async function readPersonHistory(
  db: SupabaseClient,
  personId: string,
  today: string,
): Promise<WorkItem[]> {
  const since = addDaysIso(mondayOfIso(today), -7 * 8);
  const { items } = await workItemsForPeriod(db, `${since}T00:00:00-05:00`, {
    assigneeIds: [personId],
  });
  return items;
}

/** Los enlaces de las pantallas reales, con la empresa de la pestaña. */
export function teamHrefs(organizationId: string, opts: { founder: boolean }): TeamHrefs {
  const href = (path: string) => workspaceHref(organizationId, path);
  const query = (params: Record<string, string | null | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v && !(k === 'periodo' && v === 'semana')) q.set(k, v);
    return q.size ? `?${q}` : '';
  };
  return {
    team: ({ periodo, tipo }) => href(`/team${query({ periodo, tipo })}`),
    person: (id, q) => href(`/team/${encodeURIComponent(id)}${query({ periodo: q?.periodo })}`),
    me: (q) => href(`/team/yo${query({ periodo: q?.periodo })}`),
    settings: href('/team/medir'),
    people: href('/admin/users'),
    activity: opts.founder ? href('/team/activity') : null,
    chat: (prompt) => href(chatPath(prompt)),
    source: (path) => href(path),
  };
}
