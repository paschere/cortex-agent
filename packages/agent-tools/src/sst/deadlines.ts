import { isTaxBusinessDay } from '../tax/calendar-co';

/**
 * LOS PLAZOS DE UN ACCIDENTE O INCIDENTE DE TRABAJO — puro.
 *
 *   FURAT (reporte a la ARL y la EPS)  dentro de los 2 días HÁBILES siguientes
 *                                      al accidente o al diagnóstico de la
 *                                      enfermedad (Decreto 1295 de 1994 art. 62;
 *                                      Resolución 156 de 2005).
 *   Investigación                      dentro de los 15 días CALENDARIO
 *                                      siguientes (Resolución 1401 de 2007,
 *                                      art. 4), con el COPASST o el vigía.
 *   Accidente grave o mortal           además, la investigación se remite a la
 *                                      ARL, que la manda a MinTrabajo; y el
 *                                      mortal se reporta a MinTrabajo en 2 días
 *                                      hábiles (Decreto 472 de 2015).
 *
 * Los días hábiles son de lunes a viernes sin festivos (el mismo calendario
 * de días hábiles que usa el calendario tributario).
 */

export const INCIDENT_KINDS = ['accidente', 'incidente', 'enfermedad_laboral'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const INCIDENT_KIND_LABEL: Record<IncidentKind, string> = {
  accidente: 'Accidente de trabajo',
  incidente: 'Incidente (casi accidente)',
  enfermedad_laboral: 'Enfermedad laboral',
};

export const INCIDENT_SEVERITIES = ['leve', 'grave', 'mortal'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INVESTIGATION_DAYS = 15;
export const FURAT_BUSINESS_DAYS = 2;

function addDays(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** El n-ésimo día hábil DESPUÉS de `day`. */
export function addBusinessDays(day: string, n: number): string {
  let d = day;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isTaxBusinessDay(d)) left--;
  }
  return d;
}

export interface IncidentDeadlines {
  /** FURAT a la ARL y EPS. Nulo para un incidente sin lesión. */
  furatDue: string | null;
  investigationDue: string;
  /** MinTrabajo, sólo si es mortal. */
  ministryDue: string | null;
  notes: string[];
}

export function incidentDeadlines(input: {
  kind: IncidentKind;
  severity: IncidentSeverity;
  occurredOn: string;
}): IncidentDeadlines {
  const notes: string[] = [];
  const furatDue =
    input.kind === 'incidente' ? null : addBusinessDays(input.occurredOn, FURAT_BUSINESS_DAYS);
  if (furatDue)
    notes.push(
      `Reporte FURAT${input.kind === 'enfermedad_laboral' ? ' (FUREL)' : ''} a la ARL y a la EPS a más tardar el ${furatDue} (2 días hábiles).`,
    );
  const investigationDue = addDays(input.occurredOn, INVESTIGATION_DAYS);
  notes.push(
    `Investigación con el COPASST o el vigía a más tardar el ${investigationDue} (15 días).`,
  );
  let ministryDue: string | null = null;
  if (input.severity === 'mortal') {
    ministryDue = addBusinessDays(input.occurredOn, 2);
    notes.push(`Accidente mortal: reporte a MinTrabajo a más tardar el ${ministryDue}.`);
  }
  if (input.severity !== 'leve')
    notes.push(
      'Accidente grave o mortal: la investigación se envía a la ARL en los 15 días, que la remite a MinTrabajo.',
    );
  return { furatDue, investigationDue, ministryDue, notes };
}

/** ¿Qué plazo de un incidente está vencido o por vencer? */
export function incidentAlerts(
  i: {
    furatDue: string | null;
    furatReportedOn: string | null;
    investigationDue: string;
    investigationDoneOn: string | null;
  },
  today: string,
): Array<{ what: 'furat' | 'investigacion'; due: string; overdue: boolean }> {
  const out: Array<{ what: 'furat' | 'investigacion'; due: string; overdue: boolean }> = [];
  if (i.furatDue && !i.furatReportedOn)
    out.push({ what: 'furat', due: i.furatDue, overdue: today > i.furatDue });
  if (!i.investigationDoneOn)
    out.push({
      what: 'investigacion',
      due: i.investigationDue,
      overdue: today > i.investigationDue,
    });
  return out;
}

export const ACTIVITY_KINDS = [
  'capacitacion',
  'examen_medico',
  'inspeccion',
  'reunion_copasst',
  'reunion_vigia',
  'reunion_convivencia',
  'simulacro',
  'entrega_epp',
  'otra',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  capacitacion: 'Capacitación',
  examen_medico: 'Examen médico ocupacional',
  inspeccion: 'Inspección',
  reunion_copasst: 'Reunión del COPASST',
  reunion_vigia: 'Reunión del vigía',
  reunion_convivencia: 'Reunión del Comité de Convivencia',
  simulacro: 'Simulacro de emergencia',
  entrega_epp: 'Entrega de elementos de protección',
  otra: 'Otra actividad',
};

/** El estándar de la 0312 que suele soportar cada actividad (para sugerir la evidencia). */
export const ACTIVITY_STANDARD: Record<ActivityKind, string | null> = {
  capacitacion: '1.2.1',
  examen_medico: '3.1.4',
  inspeccion: '4.2.4',
  reunion_copasst: '1.1.6',
  reunion_vigia: '1.1.6',
  reunion_convivencia: '1.1.8',
  simulacro: '5.1.1',
  entrega_epp: '4.2.6',
  otra: null,
};
