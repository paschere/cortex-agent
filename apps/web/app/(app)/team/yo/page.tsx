import { MyWeek } from '@/components/team/MyWeek';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readPersonHistory, readTeamReport, teamHrefs, teamViewer } from '@/lib/team/read';
import { buildPersonScreen } from '@/lib/team/screen';
import { markableTrackers, periodFor, readPeriodKey } from '@/lib/team/shape';
import { bogotaToday } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { TEAM_ACTIONS } from '../team-actions';

export const dynamic = 'force-dynamic';

const ASK_PROMPT =
  'Mira lo que tengo pendiente en el registro de trabajo (work.query) y ayúdame a ordenar mi semana: qué hago primero, qué puedo pedir que me ayuden y qué conviene avisar que se va a demorar.';

/**
 * «MI SEMANA», para cada persona del equipo: lo suyo y nada de nadie más con
 * nombre. El reporte se arma con todo el equipo (las medianas lo necesitan),
 * pero de aquí sólo salen sus cifras y la mediana sin nombres.
 */
export default async function MyWeekPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const q = await searchParams;
  const periodKey = readPeriodKey(q.periodo);
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const [viewer, { report, settings }, history] = await Promise.all([
    teamViewer(db, user),
    readTeamReport(db, user.organization.id, periodFor(periodKey, today), today),
    readPersonHistory(db, user.id, today),
  ]);
  const hrefs = teamHrefs(user.organization.id, { founder: viewer.founder });
  const screen = buildPersonScreen({
    report,
    history,
    personId: user.id,
    periodKey,
    today,
    viewer: { id: user.id, seesAll: false, canEditAway: true },
    markableTrackers: markableTrackers(settings.trackerMappings),
    hrefs,
    mode: 'self',
    fallback: { id: user.id, name: user.name?.trim() || user.email },
  });
  if (!screen) notFound();
  const teamHref =
    viewer.seesAll || (viewer.visibleIds?.size ?? 0) > 1
      ? hrefs.team({ periodo: periodKey, tipo: null })
      : null;
  return (
    <MyWeek
      screen={screen}
      actions={TEAM_ACTIONS}
      askHref={hrefs.chat(ASK_PROMPT)}
      teamHref={teamHref}
    />
  );
}
