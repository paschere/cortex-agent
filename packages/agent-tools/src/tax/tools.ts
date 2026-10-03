import { z } from 'zod';
import { addDays, bogotaToday, daysBetween, plural } from '../commitments/shape';
import { registerTool } from '../index';
import { RULE_VERSION } from './calendar-co';
import {
  OBLIGATION_KINDS,
  OBLIGATION_KIND_LABEL,
  OBLIGATION_STATUSES,
  OBLIGATION_STATUS_LABEL,
  type TaxObligation,
  spanishDay,
  taxProfileInputSchema,
} from './shape';
import { listTaxObligations, readTaxProfile, saveTaxProfile } from './store';
import { markTaxObligation, syncTaxCalendar } from './sync';

/**
 * LAS TRES HERRAMIENTAS DEL CALENDARIO TRIBUTARIO.
 *
 *   tax.calendar   lectura: lo que vence (o lo vencido sin marcar), con fuente.
 *   tax.configure  escribe el perfil y regenera las fechas. Confirmación, y
 *                  sólo quien administra o es dueño (lo revisa el store).
 *   tax.mark       marca presentada / pagada / no aplica, con evidencia.
 *                  Confirmación; el responsable de impuestos o quien administra.
 *
 * Ninguna presenta ni paga nada ante la DIAN: eso lo hace una persona, o un
 * trámite del navegador que esa persona enseñó y aprueba cada vez.
 */

const obligationOut = z.object({
  id: z.string(),
  kind: z.enum(OBLIGATION_KINDS),
  title: z.string(),
  period: z.string(),
  authority: z.string(),
  form: z.string().nullable(),
  dueDate: z.string(),
  daysLeft: z.number(),
  status: z.enum(OBLIGATION_STATUSES),
  needsConfirmation: z.boolean(),
});

function adapt(o: TaxObligation, today: string) {
  return {
    id: o.id,
    kind: o.kind,
    title: o.title,
    period: o.period,
    authority: o.authority,
    form: o.form,
    dueDate: o.dueDate,
    daysLeft: daysBetween(today, o.dueDate),
    status: o.status,
    needsConfirmation: o.needsConfirmation,
  };
}

function line(o: TaxObligation, today: string): string {
  const left = daysBetween(today, o.dueDate);
  const when =
    left < 0
      ? `venció hace ${plural(-left, 'día')}`
      : left === 0
        ? 'vence hoy'
        : `vence en ${plural(left, 'día')}`;
  return `- ${o.title} — ${spanishDay(o.dueDate)} (${when})${o.form ? `, formulario ${o.form}` : ''}${o.needsConfirmation ? ' · fecha por confirmar con tu contador' : ''}`;
}

export const taxCalendar = registerTool({
  id: 'tax.calendar',
  description:
    'El calendario tributario de la empresa: las obligaciones con la DIAN, el ICA, la Cámara de Comercio, la PILA y la nómina electrónica que vencen en los próximos días o que ya vencieron sin marcarse, calculadas con el NIT y el perfil tributario. Úsala para «¿qué impuestos vencen este mes?», «¿cuándo toca el IVA?», «¿qué tenemos pendiente con la DIAN?». Sólo lectura. Si no hay perfil tributario, lo dice y explica cómo configurarlo.',
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(400)
      .default(45)
      .describe('Cuántos días hacia adelante mirar.'),
    kind: z.enum(OBLIGATION_KINDS).nullish().describe('Sólo un tipo de obligación.'),
    includeDone: z
      .boolean()
      .default(false)
      .describe('Incluir las ya presentadas, pagadas o que no aplican.'),
  }),
  outputSchema: z.object({
    configured: z.boolean(),
    obligations: z.array(obligationOut),
    overdue: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const days = input.days ?? 45;
    const profile = await readTaxProfile(ctx.db);
    if (!profile) {
      return {
        configured: false,
        obligations: [],
        overdue: 0,
        guidance:
          'Esta empresa todavía no tiene perfil tributario, así que no sé qué le vence. Se configura en Impuestos (menú Más › Finanzas) con el NIT y unas casillas del RUT, o puedo leer el RUT si está en el Cerebro y proponértelo con tax.configure. No inventes fechas.',
      };
    }
    // Un calendario de otra versión de las reglas se pone al día antes de leer.
    const sample = await listTaxObligations(ctx.db, { year: Number(today.slice(0, 4)), limit: 1 });
    if (sample.length === 0 || sample[0]?.ruleVersion !== RULE_VERSION)
      await syncTaxCalendar(ctx.db, { userId: ctx.userId, today, profile }).catch(() => undefined);

    const rows = await listTaxObligations(ctx.db, {
      to: addDays(today, days),
      from: input.includeDone ? today : `${Number(today.slice(0, 4)) - 1}-01-01`,
      statuses: input.includeDone ? undefined : ['pendiente'],
      kinds: input.kind ? [input.kind] : undefined,
      limit: 200,
    });
    const overdue = rows.filter((r) => r.status === 'pendiente' && r.dueDate < today);
    const coming = rows.filter((r) => r.dueDate >= today || r.status !== 'pendiente');
    const lines = [
      overdue.length
        ? `${plural(overdue.length, 'obligación vencida sin marcar', 'obligaciones vencidas sin marcar')}:`
        : null,
      ...overdue.slice(0, 10).map((o) => line(o, today)),
      coming.length
        ? `Lo que viene en ${plural(days, 'día')}:`
        : `Nada vence en los próximos ${plural(days, 'día')}.`,
      ...coming.slice(0, 25).map((o) => line(o, today)),
      rows.some((r) => r.needsConfirmation)
        ? 'Las fechas «por confirmar» no las pude verificar contra la norma: dilo así y pide confirmarlas con el contador.'
        : null,
      'Cortex no presenta ni paga ante la DIAN: eso lo hace la persona (o un trámite del navegador que enseñó y aprueba). Se marca presentada o pagada con tax.mark o en Impuestos.',
    ];
    return {
      configured: true,
      obligations: rows.map((o) => adapt(o, today)),
      overdue: overdue.length,
      guidance: lines.filter(Boolean).join('\n'),
    };
  },
});

export const taxConfigure = registerTool({
  id: 'tax.configure',
  description:
    'Guardar el perfil tributario de la empresa (NIT, tipo de persona, gran contribuyente, Régimen Simple, IVA bimestral o cuatrimestral, agente de retención, ciudad del ICA, exógena, nómina electrónica, PILA, Cámara de Comercio y quién responde por los impuestos) y generar su calendario de obligaciones con avisos. Úsala cuando te dicten esos datos o cuando los leas del RUT (source=rut con el documento). Sólo quien administra o es dueño. Requiere confirmación.',
  inputSchema: taxProfileInputSchema,
  outputSchema: z.object({
    nit: z.string(),
    obligations: z.number(),
    nextDue: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const profile = await saveTaxProfile(ctx.db, input, { userId: ctx.userId });
    const sync = await syncTaxCalendar(ctx.db, { userId: ctx.userId, today, profile });
    const pending = await listTaxObligations(ctx.db, {
      from: today,
      statuses: ['pendiente'],
      limit: 400,
    });
    const next = pending[0] ?? null;
    return {
      nit: profile.nit,
      obligations: pending.length,
      nextDue: next?.dueDate ?? null,
      guidance: [
        `Guardé el perfil tributario (NIT ${profile.nit}${profile.dv ? `-${profile.dv}` : ''}).`,
        `Quedan ${plural(pending.length, 'obligación pendiente', 'obligaciones pendientes')} de aquí a fin de año${sync.commitmentsCreated ? `, con ${plural(sync.commitmentsCreated, 'vencimiento nuevo', 'vencimientos nuevos')} y su aviso ${plural(profile.noticeDays, 'día')} antes` : ''}.`,
        next ? `La próxima: ${next.title}, ${spanishDay(next.dueDate)}.` : null,
        profile.ownerUserId
          ? null
          : 'Nadie quedó como responsable de los impuestos: los avisos van a quien administra. Pregunta quién es el contador.',
        pending.some((p) => p.needsConfirmation)
          ? 'Algunas fechas están «por confirmar con tu contador»: no las pude verificar.'
          : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

export const taxMark = registerTool({
  id: 'tax.mark',
  description:
    'Marcar una obligación tributaria del calendario como presentada, pagada o «no aplica», con su evidencia (el formulario o el recibo en el Cerebro, o un enlace). Cierra su vencimiento y deja de avisar. Lo puede hacer el responsable de los impuestos o quien administra. Requiere confirmación.',
  inputSchema: z.object({
    obligationId: z.string().uuid().describe('El id que devolvió tax.calendar.'),
    status: z.enum(OBLIGATION_STATUSES),
    note: z.string().max(500).nullish().describe('Número de formulario, radicado, observación.'),
    evidenceDocumentId: z
      .string()
      .uuid()
      .nullish()
      .describe('El documento del Cerebro con el formulario o el recibo.'),
    evidenceUrl: z.string().url().max(1000).nullish(),
  }),
  outputSchema: z.object({
    id: z.string(),
    status: z.enum(OBLIGATION_STATUSES),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const { obligation, commitmentNote } = await markTaxObligation(ctx.db, {
      id: input.obligationId,
      status: input.status,
      note: input.note,
      evidenceDocumentId: input.evidenceDocumentId,
      evidenceUrl: input.evidenceUrl,
      userId: ctx.userId,
    });
    return {
      id: obligation.id,
      status: obligation.status,
      guidance: [
        `«${obligation.title}» quedó como ${OBLIGATION_STATUS_LABEL[obligation.status].toLowerCase()}.`,
        commitmentNote,
        obligation.status !== 'pendiente' &&
        obligation.status !== 'no_aplica' &&
        !obligation.evidenceDocumentId &&
        !obligation.evidenceUrl
          ? 'No quedó evidencia: si tienen el formulario o el recibo, súbelo al Cerebro y vuelve a marcarla con el documento.'
          : null,
        `(${OBLIGATION_KIND_LABEL[obligation.kind]})`,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});
