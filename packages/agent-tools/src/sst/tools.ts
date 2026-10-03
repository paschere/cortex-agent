import { z } from 'zod';
import { bogotaToday, plural } from '../commitments/shape';
import { registerTool } from '../index';
import { findEmployee } from '../payroll/store';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABEL,
  INCIDENT_KINDS,
  INCIDENT_KIND_LABEL,
  INCIDENT_SEVERITIES,
  incidentAlerts,
} from './deadlines';
import { SST_RATING_LABEL, standardsGroup } from './standards';
import {
  listSstActivities,
  listSstIncidents,
  listSstPlan,
  logSstActivity,
  readSstSettings,
  reportSstIncident,
  sstComplianceFor,
} from './store';

/**
 * LAS HERRAMIENTAS DEL SG-SST (0194).
 *
 *   sst.status           lectura: % de cumplimiento de los estándares mínimos,
 *                        lo que falta, actividades próximas y plazos de
 *                        accidentes abiertos.
 *   sst.log_activity     programar o registrar una actividad (capacitación,
 *                        examen, inspección, COPASST, simulacro…). Confirmación;
 *                        el responsable del SG-SST o quien administra.
 *   sst.report_incident  reportar un accidente o incidente: cualquiera del
 *                        equipo. Confirmación. Crea los avisos de FURAT (2 días
 *                        hábiles) e investigación (15 días).
 */

export const sstStatus = registerTool({
  id: 'sst.status',
  description:
    'Cómo va el Sistema de Gestión de Seguridad y Salud en el Trabajo (SG-SST): el porcentaje de cumplimiento de los estándares mínimos de la Resolución 0312 de 2019 (7, 21 o 60 según tamaño y riesgo), qué estándares faltan, las actividades programadas (capacitaciones, exámenes, inspecciones, COPASST o vigía, simulacros) y los plazos de accidentes abiertos (FURAT, investigación). Úsala para «¿cómo vamos en SST?», «¿qué nos falta del SG-SST?», «¿cuándo es el próximo simulacro?». Sólo lectura.',
  inputSchema: z.object({ year: z.number().int().min(2019).max(2100).nullish() }),
  outputSchema: z.object({
    configured: z.boolean(),
    score: z.number().nullable(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const year = input.year ?? Number(today.slice(0, 4));
    const settings = await readSstSettings(ctx.db);
    if (!settings.configured)
      return {
        configured: false,
        score: null,
        guidance:
          'El SG-SST todavía no está configurado en Cortex: falta decir cuántos trabajadores tiene la empresa y su clase de riesgo más alta (en la pantalla SG-SST). Con eso salen los estándares mínimos que le aplican. No inventes porcentajes.',
      };
    const group = standardsGroup(settings.workers, settings.maxRiskClass);
    const [plan, compliance, activities, incidents] = await Promise.all([
      listSstPlan(ctx.db, year),
      sstComplianceFor(ctx.db, year),
      listSstActivities(ctx.db, { status: ['programada'], limit: 50 }),
      listSstIncidents(ctx.db, { open: true, limit: 20 }),
    ]);
    const missing = plan.filter((p) => p.status === 'no_cumple' || p.status === 'pendiente');
    const upcoming = activities
      .filter((a) => a.plannedDate)
      .sort((a, b) => ((a.plannedDate ?? '') < (b.plannedDate ?? '') ? -1 : 1));
    const lines = [
      plan.length
        ? `Autoevaluación ${year} (${group} estándares por ${settings.workers} trabajadores, riesgo máximo ${settings.maxRiskClass}): ${compliance.score} % — ${SST_RATING_LABEL[compliance.rating].toLowerCase()}. ${compliance.action}`
        : `Le aplican ${group} estándares mínimos, pero la autoevaluación de ${year} no se ha empezado (pantalla SG-SST).`,
      compliance.withoutEvidence
        ? `${plural(compliance.withoutEvidence, 'estándar marcado', 'estándares marcados')} «cumple» sin evidencia: en una visita no contarían.`
        : null,
      missing.length
        ? `Faltan: ${missing
            .slice(0, 8)
            .map((m) => `${m.code} ${m.title}`)
            .join('; ')}${missing.length > 8 ? '…' : ''}.`
        : null,
      upcoming.length
        ? `Próximas actividades: ${upcoming
            .slice(0, 5)
            .map(
              (a) =>
                `${a.title} (${a.plannedDate}${(a.plannedDate ?? '') < today ? ', vencida' : ''})`,
            )
            .join('; ')}.`
        : 'No hay actividades programadas.',
      ...incidents.flatMap((i) =>
        incidentAlerts(i, today).map(
          (al) =>
            `${INCIDENT_KIND_LABEL[i.kind]} del ${i.occurredOn}: ${al.what === 'furat' ? 'FURAT a la ARL' : 'investigación'} ${al.overdue ? 'VENCIDA desde' : 'vence'} el ${al.due}.`,
        ),
      ),
      'Cortex lleva el registro y los avisos; el SG-SST lo firma y responde el responsable con licencia en SST.',
    ];
    return {
      configured: true,
      score: plan.length ? compliance.score : null,
      guidance: lines.filter(Boolean).join('\n'),
    };
  },
});

export const sstLogActivity = registerTool({
  id: 'sst.log_activity',
  description:
    'Programar o registrar una actividad del SG-SST: capacitación, examen médico ocupacional (sólo que se hizo y de qué tipo, nunca el resultado), inspección, reunión del COPASST o del vigía, comité de convivencia, simulacro o entrega de elementos de protección. Con fecha futura queda programada y con aviso; con fecha pasada, realizada (adjunta la evidencia del Cerebro o un enlace). Lo hace el responsable del SG-SST o quien administra. Requiere confirmación.',
  inputSchema: z.object({
    kind: z.enum(ACTIVITY_KINDS),
    title: z.string().max(200).nullish(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Cuándo se hizo o cuándo se hará.'),
    participants: z.number().int().min(0).nullish(),
    person: z.string().nullish().describe('Para un examen médico: a quién.'),
    examType: z.enum(['ingreso', 'periodico', 'retiro', 'post_incapacidad']).nullish(),
    evidenceDocumentId: z.string().uuid().nullish(),
    evidenceUrl: z.string().url().max(1000).nullish(),
    notes: z.string().max(1000).nullish(),
  }),
  outputSchema: z.object({ id: z.string(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    let employeeId: string | null = null;
    if (input.person) {
      const { employee } = await findEmployee(ctx.db, input.person).catch(() => ({
        employee: null,
      }));
      employeeId = employee?.id ?? null;
    }
    const past = input.date <= today;
    const a = await logSstActivity(
      ctx.db,
      {
        kind: input.kind,
        title: input.title,
        plannedDate: past ? null : input.date,
        doneDate: past ? input.date : null,
        participants: input.participants,
        employeeId,
        examType: input.examType,
        evidenceDocumentId: input.evidenceDocumentId,
        evidenceUrl: input.evidenceUrl,
        notes: input.notes,
      },
      { userId: ctx.userId },
    );
    return {
      id: a.id,
      guidance:
        a.status === 'realizada'
          ? `Registré ${ACTIVITY_KIND_LABEL[a.kind].toLowerCase()} «${a.title}» del ${a.doneDate}${a.evidenceDocumentId || a.evidenceUrl ? ' con su evidencia' : '. Falta la evidencia (lista de asistencia, acta, certificado): súbela en SG-SST'}.${a.standardCode ? ` Soporta el estándar ${a.standardCode}.` : ''}`
          : `Programé ${ACTIVITY_KIND_LABEL[a.kind].toLowerCase()} «${a.title}» para el ${a.plannedDate}, con aviso en Vencimientos.`,
    };
  },
});

export const sstReportIncident = registerTool({
  id: 'sst.report_incident',
  description:
    'Reportar un accidente de trabajo, un incidente (casi accidente) o una enfermedad laboral. Cualquier persona del equipo puede hacerlo. Calcula y deja como vencimientos los plazos legales: FURAT a la ARL y la EPS en 2 días hábiles y la investigación en 15 días (y MinTrabajo si es mortal). No reporta nada a la ARL por sí mismo: eso lo hace la persona en el portal de la ARL. Requiere confirmación.',
  inputSchema: z.object({
    kind: z.enum(INCIDENT_KINDS),
    severity: z.enum(INCIDENT_SEVERITIES).default('leve'),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    person: z.string().nullish().describe('A quién le pasó (si es del equipo).'),
    place: z.string().max(200).nullish(),
    description: z.string().min(3).max(2000),
    daysLost: z.number().int().min(0).nullish(),
  }),
  outputSchema: z.object({ id: z.string(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    let employeeId: string | null = null;
    if (input.person) {
      const { employee } = await findEmployee(ctx.db, input.person).catch(() => ({
        employee: null,
      }));
      employeeId = employee?.id ?? null;
    }
    const r = await reportSstIncident(
      ctx.db,
      {
        kind: input.kind,
        severity: input.severity,
        occurredOn: input.occurredOn,
        employeeId,
        place: input.place,
        description: input.description,
        daysLost: input.daysLost,
      },
      { userId: ctx.userId },
    );
    return {
      id: r.incident.id,
      guidance: [
        `Quedó reportado: ${INCIDENT_KIND_LABEL[r.incident.kind].toLowerCase()} del ${r.incident.occurredOn}.`,
        ...r.notes,
        'Los avisos quedaron en Vencimientos para el responsable del SG-SST.',
      ].join(' '),
    };
  },
});
