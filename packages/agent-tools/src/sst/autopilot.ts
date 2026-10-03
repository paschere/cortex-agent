import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlanItem } from '../autopilot/types';
import { addDays, daysBetween, plural } from '../commitments/shape';
import { INCIDENT_KIND_LABEL, type IncidentKind, incidentAlerts } from './deadlines';
import { listSstActivities, listSstIncidents, readSstSettings } from './store';

/**
 * EL PILOTO MIRA EL SG-SST (0194): sólo AVISA (tell).
 *
 *   - Plazos de un accidente abierto: FURAT (2 días hábiles) e investigación
 *     (15 días) vencidos o que vencen en los próximos 3 días.
 *   - Actividades programadas que ya pasaron sin registrarse como hechas.
 *
 * Nada de esto lo puede hacer Cortex solo: el FURAT se radica en el portal de
 * la ARL y la investigación la hace el COPASST o el vigía.
 */

export interface SnapshotSst {
  incidents: Array<{
    id: string;
    kind: IncidentKind;
    occurredOn: string;
    furatDue: string | null;
    furatReportedOn: string | null;
    investigationDue: string;
    investigationDoneOn: string | null;
  }>;
  overdueActivities: Array<{ id: string; title: string; plannedDate: string }>;
}

export function collectSst(s: SnapshotSst | undefined, today: string): PlanItem[] {
  if (!s) return [];
  const out: PlanItem[] = [];
  for (const i of s.incidents) {
    for (const a of incidentAlerts(i, today)) {
      const left = daysBetween(today, a.due);
      if (!a.overdue && left > 3) continue;
      const what = a.what === 'furat' ? 'el FURAT a la ARL' : 'la investigación';
      out.push({
        area: 'vencimientos',
        title: `${a.overdue ? 'Venció' : 'Vence'} ${what} del ${INCIDENT_KIND_LABEL[i.kind].toLowerCase()} del ${i.occurredOn}`,
        why: a.overdue
          ? `El plazo era el ${a.due} (hace ${plural(-left, 'día')}). ${a.what === 'furat' ? 'Reportarlo tarde a la ARL puede costar la cobertura y una multa.' : 'La Resolución 1401 de 2007 pide investigarlo en 15 días con el COPASST o el vigía.'}`
          : `Vence el ${a.due} (${left === 0 ? 'hoy' : `en ${plural(left, 'día')}`}). ${a.what === 'furat' ? 'Se radica en el portal de la ARL; luego márcalo en SG-SST.' : 'Con el COPASST o el vigía; sube el informe a SG-SST.'}`,
        proposedAction: null,
        effect: null,
        risk: a.overdue || a.what === 'furat' ? 'high' : 'medium',
        dedupeKey: `sst:${a.what}:${i.id}`,
        href: '/sst?tab=incidentes',
      });
    }
  }
  if (s.overdueActivities.length) {
    const first = s.overdueActivities[0];
    out.push({
      area: 'vencimientos',
      title: `${plural(s.overdueActivities.length, 'actividad', 'actividades')} del SG-SST sin registrar`,
      why: `Estaban programadas y no tienen evidencia de que se hicieron; la más vieja, «${first?.title}», era para el ${first?.plannedDate}. Si se hizo, regístrala con su evidencia; si no, reprográmala.`,
      proposedAction: null,
      effect: null,
      risk: 'low',
      dedupeKey: `sst:actividades:${first?.id}`,
      href: '/sst?tab=actividades',
    });
  }
  return out;
}

export async function loadSstSnapshot(db: SupabaseClient, today: string): Promise<SnapshotSst> {
  const settings = await readSstSettings(db);
  if (!settings.configured) return { incidents: [], overdueActivities: [] };
  const [incidents, activities] = await Promise.all([
    listSstIncidents(db, { open: true, limit: 30 }),
    listSstActivities(db, { status: ['programada'], to: addDays(today, -1), limit: 100 }),
  ]);
  return {
    incidents: incidents.map((i) => ({
      id: i.id,
      kind: i.kind,
      occurredOn: i.occurredOn,
      furatDue: i.furatDue,
      furatReportedOn: i.furatReportedOn,
      investigationDue: i.investigationDue,
      investigationDoneOn: i.investigationDoneOn,
    })),
    overdueActivities: activities
      .filter((a) => a.plannedDate && a.plannedDate < today)
      .sort((a, b) => ((a.plannedDate ?? '') < (b.plannedDate ?? '') ? -1 : 1))
      .map((a) => ({ id: a.id, title: a.title, plannedDate: a.plannedDate as string })),
  };
}
