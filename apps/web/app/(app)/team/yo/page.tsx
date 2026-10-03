import { MyPayrollCard } from '@/components/payroll/MyPayrollCard';
import { MyTimesheet } from '@/components/projects/MyTimesheet';
import { MyWeek } from '@/components/team/MyWeek';
import { companyModules } from '@/lib/modules/server';
import { timesheetView } from '@/lib/projects/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readPersonHistory, readTeamReport, teamHrefs, teamViewer } from '@/lib/team/read';
import { buildPersonScreen } from '@/lib/team/screen';
import { markableTrackers, periodFor, readPeriodKey } from '@/lib/team/shape';
import {
  bogotaToday,
  listServiceProjects,
  projectPersonTimesheet,
  resolveStepFor,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { logTimeAction } from '../../proyectos/actions';
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
  // «Que Cortex lo resuelva» en lo propio vencido: redactar el aviso de que se
  // demora o proponer a quién pedirle ayuda (0177). Abre el chat; nada se hace
  // sin el sí de la persona.
  const withResolve = {
    ...screen,
    open: screen.open.map((item) => {
      if (!item.overdue) return item;
      const step = resolveStepFor({
        kind: 'work_item_mine',
        title: item.title,
        detail: item.workType,
      });
      return step
        ? { ...item, resolve: { label: step.label, href: hrefs.chat(step.prompt) } }
        : item;
    }),
  };
  const teamHref =
    viewer.seesAll || (viewer.visibleIds?.size ?? 0) > 1
      ? hrefs.team({ periodo: periodKey, tipo: null })
      : null;
  // Mis horas de la semana (0196), sólo con el módulo de proyectos prendido.
  const timesheet = (await companyModules(user.organization.id)).has('service_orders')
    ? await Promise.all([
        projectPersonTimesheet(db, user.id, today),
        listServiceProjects(db, { statuses: ['abierto', 'en_curso', 'en_pausa', 'terminado'] }),
      ])
    : null;
  return (
    <>
      <MyWeek
        screen={withResolve}
        actions={TEAM_ACTIONS}
        askHref={hrefs.chat(ASK_PROMPT)}
        teamHref={teamHref}
      />
      {/* 0194: su último pago y su saldo de vacaciones, sólo suyos. */}
      <MyPayrollCard organizationId={user.organization.id} userId={user.id} />
      {timesheet && (
        <MyTimesheet
          week={timesheetView(
            timesheet[0],
            timesheet[0].rows.map((r) => ({
              key: r.projectId,
              label: timesheet[0].projects[r.projectId]
                ? `${timesheet[0].projects[r.projectId]?.code} · ${timesheet[0].projects[r.projectId]?.title}`
                : 'Proyecto',
              href: `/proyectos/${r.projectId}`,
              days: r.days,
              total: r.total,
            })),
            { today, hrefFor: () => '/team/yo' },
          )}
          projects={timesheet[1].map((p) => ({ id: p.id, label: `${p.code} · ${p.title}` }))}
          today={today}
          logTime={logTimeAction}
        />
      )}
    </>
  );
}
