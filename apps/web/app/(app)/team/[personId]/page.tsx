import { PersonDetail } from '@/components/team/PersonDetail';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readPersonHistory, readTeamReport, teamHrefs, teamViewer } from '@/lib/team/read';
import { buildPersonScreen } from '@/lib/team/screen';
import { markableTrackers, periodFor, readPeriodKey } from '@/lib/team/shape';
import { bogotaToday } from '@cortex/agent-tools';
import { notFound, redirect } from 'next/navigation';
import { TEAM_ACTIONS } from '../team-actions';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El detalle de una persona: lo ve quien ve a todo el equipo, quien la
 * empresa haya dejado ver (visibilidad `team`/`all`) y la persona misma, que
 * va a «Mi semana». Los días fuera los edita ella o quien administra (o es
 * dueño); las filas de tabla conectadas las marca hechas ella o quien
 * administra.
 */
export default async function TeamPersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ personId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const { personId } = await params;
  if (!UUID_RE.test(personId)) notFound();
  const q = await searchParams;
  const periodKey = readPeriodKey(q.periodo);
  const db = getOrgScopedClient(user.organization.id);
  const viewer = await teamViewer(db, user);
  const hrefs = teamHrefs(user.organization.id, { founder: viewer.founder });
  if (personId === user.id) redirect(hrefs.me({ periodo: periodKey }));
  if (!viewer.seesAll && !viewer.visibleIds?.has(personId)) notFound();

  const today = bogotaToday();
  const [{ report, settings }, history] = await Promise.all([
    readTeamReport(db, user.organization.id, periodFor(periodKey, today), today),
    readPersonHistory(db, personId, today),
  ]);
  const screen = buildPersonScreen({
    report,
    history,
    personId,
    periodKey,
    today,
    viewer: {
      id: user.id,
      seesAll: viewer.seesAll,
      canEditAway: viewer.admin,
      manages: viewer.admin,
    },
    markableTrackers: markableTrackers(settings.trackerMappings),
    hrefs,
  });
  if (!screen) notFound();
  return <PersonDetail screen={screen} actions={TEAM_ACTIONS} />;
}
