import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays } from '../commitments/shape';
import type { TrackerField } from '../trackers/schema';
import type { ViewRow } from '../views/compute';
import type { PlatformSource } from '../views/sources';
import { canSeeAssignee, scopeAssigneeIds, workScope } from './access';
import { previousPeriod } from './metrics';
import { buildTeamReport } from './report';
import { WORK_SOURCE_LABEL, WORK_STATUS_LABEL, bogotaDayOf, isMeasured } from './shape';
import {
  type WorkRecord,
  listWorkItems,
  listWorkPeople,
  readWorkSettings,
  workItemsForPeriod,
} from './store';
import type { PersonWorkStats, TeamWorkReport, WorkItem, WorkPeriod } from './types';

/**
 * EL REGISTRO DE TRABAJO COMO FUENTE DE UNA VISTA: `cortex.trabajo` (los
 * ítems) y `cortex.equipo` (las cifras de cada persona).
 *
 * Las dos son `internal` —nombran a gente del equipo y su trabajo, así que una
 * vista que las usa no se comparte por enlace— y además dependen de QUIÉN
 * MIRA, con la regla de work/access.ts: cada persona ve lo suyo; quien
 * administra ve a todo el equipo; los demás, lo que la empresa haya abierto.
 * Sin nadie mirando no se lee nada.
 *
 * Viven aquí y no en views/sources.ts para que el registro de trabajo sea
 * dueño de su propia regla de visibilidad; sources.ts sólo las registra.
 */

const field = (
  key: string,
  label: string,
  type: TrackerField['type'],
  options?: string[],
): TrackerField => ({ key, label, type, required: false, ...(options ? { options } : {}) });

type Values = Record<string, string | number>;

function put(values: Values, key: string, value: string | number | null | undefined) {
  if (value === null || value === undefined) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  if (typeof value === 'string' && value.trim() === '') return;
  values[key] = typeof value === 'string' ? value.trim() : value;
}

const dayOf = (v: string | null | undefined): string | null =>
  !v ? null : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : bogotaDayOf(v);

const SI_NO = ['Sí', 'No'];
const SIN_ASIGNAR = 'Sin asignar';

// ---------------------------------------------------------------------------
// cortex.trabajo
// ---------------------------------------------------------------------------

export const trabajoSource: PlatformSource = {
  id: 'cortex.trabajo',
  name: 'Registro de trabajo',
  description:
    'Cada cosa que alguien del equipo tiene que hacer o hizo: responsable, tipo de trabajo, estado, si está vencido, cuándo se abrió, vence y se cerró, cantidad producida y de dónde salió. Cada persona ve lo suyo; quien administra ve a todo el equipo.',
  sensitivity: 'internal',
  fields: [
    field('titulo', 'Trabajo', 'text'),
    field('persona', 'Responsable', 'text'),
    field('equipo', 'Equipo', 'text'),
    field('tipo', 'Tipo de trabajo', 'text'),
    field('estado', 'Estado', 'select', Object.values(WORK_STATUS_LABEL)),
    field('vencido', 'Vencido', 'select', SI_NO),
    field('abierto', 'Abierto', 'date'),
    field('vence', 'Vence', 'date'),
    field('cerrado', 'Cerrado', 'date'),
    field('dias_abierto', 'Días abierto', 'number'),
    field('cantidad', 'Cantidad', 'number'),
    field('unidad', 'Unidad', 'text'),
    field('fuente', 'De dónde viene', 'select', Object.values(WORK_SOURCE_LABEL)),
  ],
  async read(db, cap, today, ctx) {
    const scope = await workScope(db, ctx.viewerId);
    if (scope.visibleIds && scope.visibleIds.size === 0) return { rows: [], truncated: false };
    const [settings, people, { items, truncated }] = await Promise.all([
      readWorkSettings(db),
      listWorkPeople(db),
      listWorkItems(db, { assigneeIds: scopeAssigneeIds(scope), limit: cap }),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const rows: ViewRow[] = items
      .filter((i) => i.status !== 'cancelled' || scope.admin)
      .filter((i) => isMeasured(i.workType, settings.measuredTypes))
      .filter((i) => canSeeAssignee(scope, i.assigneeId))
      .map((i) => trabajoRow(i, today, byId));
    return { rows, truncated };
  },
};

function trabajoRow(
  i: WorkRecord,
  today: string,
  people: ReadonlyMap<string, { name: string; team?: string | null }>,
): ViewRow {
  const values: Values = {};
  const person = i.assigneeId ? people.get(i.assigneeId) : undefined;
  const opened = dayOf(i.openedAt);
  const due = dayOf(i.dueAt);
  const done = dayOf(i.doneAt);
  put(values, 'titulo', i.title);
  put(
    values,
    'persona',
    person?.name ?? (i.assigneeLabel ? `${i.assigneeLabel} (sin cuenta)` : SIN_ASIGNAR),
  );
  put(values, 'equipo', i.team ?? person?.team ?? null);
  put(values, 'tipo', i.workType);
  put(values, 'estado', WORK_STATUS_LABEL[i.status]);
  put(values, 'vencido', i.status === 'open' && due !== null && due < today ? 'Sí' : 'No');
  put(values, 'abierto', opened);
  put(values, 'vence', due);
  put(values, 'cerrado', done);
  if (opened) {
    const end = i.status === 'done' && done ? done : today;
    put(
      values,
      'dias_abierto',
      Math.max(0, Math.round((Date.parse(end) - Date.parse(opened)) / 86_400_000)),
    );
  }
  put(values, 'cantidad', i.quantity ?? null);
  put(values, 'unidad', i.unit ?? null);
  put(values, 'fuente', WORK_SOURCE_LABEL[i.source.kind]);
  return {
    id: i.id,
    label: i.title.slice(0, 120),
    values,
    created_at: i.createdAt || i.openedAt,
    updated_at: i.updatedAt || i.createdAt || i.openedAt,
  };
}

// ---------------------------------------------------------------------------
// cortex.equipo
// ---------------------------------------------------------------------------

/** El período de `cortex.equipo`: los últimos 30 días, hoy incluido. */
export function lastDaysPeriod(today: string, days = 30): WorkPeriod {
  return { from: addDays(today, -(days - 1)), to: today };
}

const TODOS = 'Todos';

/**
 * El reporte del equipo para un período, leído del registro y armado por el
 * motor puro (work/report.ts, `buildTeamReport`): cifras de cada persona en
 * total y por tipo, el período anterior del mismo largo, las medianas del
 * equipo y las señales. Lo cancelado y lo que no se mide no entra.
 *
 * Se arma con TODO el equipo (las medianas necesitan a todos); quién ve qué
 * fila lo decide quien lo muestra, con work/access.ts.
 */
export async function loadTeamReport(
  db: SupabaseClient,
  period: WorkPeriod,
  opts: { today: string },
): Promise<{ report: TeamWorkReport; items: WorkItem[]; truncated: boolean }> {
  const previous = previousPeriod(period);
  const [settings, people, { items, truncated }] = await Promise.all([
    readWorkSettings(db),
    listWorkPeople(db),
    workItemsForPeriod(db, `${previous.from}T00:00:00-05:00`),
  ]);
  const measured: WorkItem[] = items.filter((i) => isMeasured(i.workType, settings.measuredTypes));
  const report = buildTeamReport({
    items: measured,
    people,
    period,
    previous,
    asOf: period.to >= opts.today ? opts.today : null,
  });
  return { report, items: measured, truncated };
}

/**
 * Las filas de `cortex.equipo`: una por persona y tipo de trabajo, más una
 * «Todos» por persona, con sus cifras, lo cerrado en el período anterior y las
 * señales que le tocan. Quien no administra (y sin visibilidad abierta) sólo
 * recibe SUS filas. No hay una nota ni un orden por cifra: cada número se lee
 * por su lado.
 */
export async function teamStatsRows(
  db: SupabaseClient,
  period: WorkPeriod,
  opts: { viewerId: string | null; today: string; cap?: number },
): Promise<{ rows: ViewRow[]; truncated: boolean }> {
  const scope = await workScope(db, opts.viewerId);
  if (scope.visibleIds && scope.visibleIds.size === 0) return { rows: [], truncated: false };
  const { report, truncated } = await loadTeamReport(db, period, { today: opts.today });
  const rows: ViewRow[] = [];
  const stamp = `${period.to}T12:00:00-05:00`;
  for (const entry of report.people) {
    if (!canSeeAssignee(scope, entry.person.id)) continue;
    const stats: PersonWorkStats[] = [entry.current, ...entry.byType];
    for (const s of stats) {
      if (s.sample === 0) continue;
      const type = s.workType === 'all' ? TODOS : s.workType;
      const values: Values = {};
      const units = Object.entries(s.output);
      const signals = report.signals.filter(
        (g) =>
          g.personId === entry.person.id &&
          (s.workType === 'all' ? !g.workType : g.workType === s.workType),
      );
      put(values, 'persona', entry.person.name);
      put(values, 'equipo', entry.person.team ?? null);
      put(values, 'tipo', type);
      put(values, 'abiertos', s.openNow);
      put(values, 'vencidos', s.overdueNow);
      put(values, 'cerrados', s.done);
      put(values, 'cerrados_antes', s.workType === 'all' ? (entry.previous?.done ?? null) : null);
      put(values, 'a_tiempo', s.onTimeRate === null ? null : Math.round(s.onTimeRate * 100));
      put(values, 'ciclo_horas', s.medianCycleHours);
      put(values, 'dias_trabajables', s.workingDays);
      put(
        values,
        'cerrados_por_dia',
        s.workingDays > 0 ? Math.round((s.done / s.workingDays) * 10) / 10 : null,
      );
      if (units.length === 1 && units[0]) {
        put(values, 'producido', units[0][1]);
        put(values, 'unidad', units[0][0]);
      } else if (units.length > 1) {
        put(values, 'unidad', units.map(([u, n]) => `${n} ${u}`).join(' · '));
      }
      put(values, 'muestra', s.sample);
      put(values, 'senales', signals.map((g) => g.message).join(' ') || null);
      put(values, 'desde', report.period.from);
      put(values, 'hasta', report.period.to);
      rows.push({
        id: `equipo:${entry.person.id}:${type}`,
        label: `${entry.person.name} · ${type}`,
        values,
        created_at: stamp,
        updated_at: stamp,
      });
    }
  }
  const cap = opts.cap ?? rows.length;
  return { rows: rows.slice(0, cap), truncated: truncated || rows.length > cap };
}

export const equipoSource: PlatformSource = {
  id: 'cortex.equipo',
  name: 'Trabajo del equipo',
  description:
    'Por persona y tipo de trabajo, en los últimos 30 días: abiertos, vencidos, cerrados (y los del período anterior), % a tiempo, horas de ciclo (mediana), cerrados por día trabajable (sin festivos ni días fuera), lo producido y lo que vale la pena mirar. Una fila «Todos» por persona. Cada persona ve sus cifras; quien administra ve las de todo el equipo. No es una nota: cada cifra se lee por su lado.',
  sensitivity: 'internal',
  fields: [
    field('persona', 'Persona', 'text'),
    field('equipo', 'Equipo', 'text'),
    field('tipo', 'Tipo de trabajo', 'text'),
    field('abiertos', 'Abiertos', 'number'),
    field('vencidos', 'Vencidos', 'number'),
    field('cerrados', 'Cerrados', 'number'),
    field('cerrados_antes', 'Cerrados el período anterior', 'number'),
    field('a_tiempo', '% a tiempo', 'number'),
    field('ciclo_horas', 'Horas de ciclo (mediana)', 'number'),
    field('cerrados_por_dia', 'Cerrados por día trabajable', 'number'),
    field('dias_trabajables', 'Días trabajables', 'number'),
    field('producido', 'Producido', 'number'),
    field('unidad', 'Unidad', 'text'),
    field('muestra', 'Ítems que respaldan', 'number'),
    field('senales', 'Para mirar', 'text'),
    field('desde', 'Desde', 'date'),
    field('hasta', 'Hasta', 'date'),
  ],
  async read(db, cap, today, ctx) {
    return teamStatsRows(db, lastDaysPeriod(today), { viewerId: ctx.viewerId, today, cap });
  },
};
