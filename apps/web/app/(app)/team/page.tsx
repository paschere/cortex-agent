import { TeamOverview } from '@/components/team/TeamOverview';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readTeamReport, teamHrefs, teamViewer } from '@/lib/team/read';
import { buildTeamScreen } from '@/lib/team/screen';
import { CONNECT_WORK_PROMPT, chatPath, periodFor, readPeriodKey } from '@/lib/team/shape';
import { workspaceHref } from '@/lib/workspace-context';
import { bogotaToday } from '@cortex/agent-tools';
import { redirect } from 'next/navigation';
import { TEAM_ACTIONS } from './team-actions';

export const dynamic = 'force-dynamic';

/**
 * EQUIPO: cómo va el trabajo del equipo (components/team/TeamOverview).
 *
 * Quien administra o es dueño de la empresa ve a todo el equipo. Los demás van
 * a «Mi semana», salvo que la empresa haya abierto la visibilidad (`team` o
 * `all` en work_settings): entonces ven las cifras de quienes les tocan, sin
 * señales con nombre de otros ni lo que no tiene responsable.
 *
 * Parámetros: `?periodo=semana|pasada|30d` y `?tipo=<tipo de trabajo>`.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const q = await searchParams;
  const periodKey = readPeriodKey(q.periodo);
  const viewer = await teamViewer(db, user);
  const hrefs = teamHrefs(user.organization.id, { founder: viewer.founder });
  if (!viewer.seesAll && (viewer.visibleIds?.size ?? 0) <= 1)
    redirect(hrefs.me({ periodo: periodKey }));

  const today = bogotaToday();
  const { report, items, truncated } = await readTeamReport(
    db,
    user.organization.id,
    periodFor(periodKey, today),
    today,
  );
  const screen = buildTeamScreen({
    report,
    items,
    periodKey,
    workType: typeof q.tipo === 'string' ? q.tipo : null,
    today,
    viewer: {
      id: user.id,
      seesAll: viewer.seesAll,
      canReassign: viewer.admin,
      canConfigure: viewer.admin,
    },
    visibleIds: viewer.visibleIds,
    truncated,
    hrefs,
  });
  return (
    <TeamOverview
      screen={screen}
      actions={TEAM_ACTIONS}
      connectHref={workspaceHref(user.organization.id, chatPath(CONNECT_WORK_PROMPT))}
    />
  );
}
