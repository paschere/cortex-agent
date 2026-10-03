import 'server-only';
import type { getOrgScopedClient } from '@/lib/supabase/service';
import {
  listDirectory,
  listProjectRates,
  loadProjectsOverview,
  personLabel,
  projectWeekStartOf,
  projectWeekTimesheet,
  wonOpportunitiesWithoutProject,
} from '@cortex/agent-tools';

type Db = ReturnType<typeof getOrgScopedClient>;

/**
 * LO QUE /proyectos LEE (migración 0196): el tablero con su cuenta, la gente,
 * las horas de la semana de todo el equipo, el costo por hora y lo ganado en
 * el embudo sin proyecto. Cada lectura revisa su error.
 */
export async function loadProjectsPage(db: Db, today: string, weekOf: string) {
  const start = projectWeekStartOf(weekOf);
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [{ projects, names }, people, rates, won, week, month] = await Promise.all([
    loadProjectsOverview(db, today, {}),
    listDirectory(db),
    listProjectRates(db),
    wonOpportunitiesWithoutProject(db),
    db
      .from('time_entries')
      .select('project_id, user_id, person_label, worked_on, hours')
      .gte('worked_on', start)
      .lte('worked_on', end),
    db
      .from('time_entries')
      .select('user_id, hours')
      .gte('worked_on', monthStart)
      .lte('worked_on', today),
  ]);
  if (week.error) throw week.error;
  if (month.error) throw month.error;

  const entries = (week.data ?? []) as Array<{
    project_id: string;
    user_id: string | null;
    person_label: string | null;
    worked_on: string;
    hours: number | string;
  }>;
  // La semana del equipo: una fila por persona.
  const byPerson = new Map<string, Array<{ projectId: string; workedOn: string; hours: number }>>();
  const labelOf = new Map<string, string>();
  for (const e of entries) {
    const key = e.user_id ?? `label:${e.person_label ?? ''}`;
    labelOf.set(
      key,
      e.user_id ? (names[e.user_id] ?? 'Alguien') : (e.person_label ?? 'Sin nombre'),
    );
    const list = byPerson.get(key) ?? [];
    // Por persona: se suma todo en una «fila» única usando el id de la persona.
    list.push({ projectId: key, workedOn: String(e.worked_on), hours: Number(e.hours) || 0 });
    byPerson.set(key, list);
  }
  const all = projectWeekTimesheet([...byPerson.values()].flat(), start);
  const teamRows = all.rows.map((r) => ({
    key: r.projectId,
    label: labelOf.get(r.projectId) ?? 'Alguien',
    days: r.days,
    total: r.total,
  }));

  const monthHours = new Map<string, number>();
  for (const r of (month.data ?? []) as Array<{ user_id: string | null; hours: number | string }>)
    if (r.user_id)
      monthHours.set(r.user_id, (monthHours.get(r.user_id) ?? 0) + (Number(r.hours) || 0));

  return {
    projects,
    names,
    people: people.map((p) => ({ id: p.id, name: personLabel(p) })),
    rates,
    won,
    week: { sheet: all, rows: teamRows },
    monthHours,
  };
}
