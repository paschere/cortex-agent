import { ProjectsScreen } from '@/components/projects/ProjectsScreen';
import { loadProjectsPage } from '@/lib/projects/read';
import { parseProjectsTab } from '@/lib/projects/shape';
import {
  projectColumns,
  projectPresets,
  projectRow,
  projectTiles,
  rateViews,
  timesheetView,
  wonOpportunityViews,
} from '@/lib/projects/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, isCompanyManager } from '@cortex/agent-tools';
import {
  bulkEditProjects,
  createProjectAction,
  createProjectRow,
  editProjectCell,
  logTimeAction,
  openFromOpportunity,
  setRateAction,
} from './actions';

/**
 * Proyectos y órdenes de servicio (migración 0196): la lista, el tablero por
 * estado y el calendario de entregas (DataGrid), las horas de la semana de
 * todo el equipo y el costo por hora de cada persona.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Proyectos · Cortex' };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab = parseProjectsTab(q.tab);
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const weekOf =
    typeof q.semana === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.semana) && q.semana <= today
      ? q.semana
      : today;
  const [data, canManage] = await Promise.all([
    loadProjectsPage(db, today, weekOf),
    isCompanyManager(db, user.id),
  ]);
  const people = data.people.map((p) => ({ value: p.id, label: p.name }));
  const open = data.projects.filter(
    (s) => !['cerrado', 'cancelado', 'facturado'].includes(s.project.status),
  );

  return (
    <ProjectsScreen
      tab={tab}
      today={today}
      tiles={projectTiles(data.projects, data.week.sheet.total)}
      columns={projectColumns(data.people.map((p) => p.name))}
      rows={data.projects.map(projectRow)}
      presets={projectPresets()}
      choices={open.map((s) => ({
        id: s.project.id,
        label: `${s.project.code} · ${s.project.title}`,
      }))}
      people={people}
      week={timesheetView(data.week.sheet, data.week.rows, {
        today,
        hrefFor: (start) => `/proyectos?tab=horas&semana=${start}`,
      })}
      rates={rateViews(data.people, data.rates, data.monthHours)}
      won={wonOpportunityViews(data.won)}
      canManage={canManage}
      handlers={{
        onEdit: editProjectCell,
        onBulkEdit: bulkEditProjects,
        onCreate: createProjectRow,
        createProject: createProjectAction,
        logTime: logTimeAction,
        setRate: setRateAction,
        openFromOpportunity,
      }}
    />
  );
}
