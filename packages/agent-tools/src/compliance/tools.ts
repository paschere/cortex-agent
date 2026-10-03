import { z } from 'zod';
import { bogotaToday, isoDate } from '../commitments/shape';
import { findClientByName } from '../contracts/resolve';
import { registerTool } from '../index';
import { normalizeRadicado, parseRadicado } from './cases';
import {
  createPqrs,
  isItemOverdue,
  loadCompliance,
  markComplianceItem,
  pqrsDeadline,
  respondPqrs,
  upsertLegalCase,
} from './ops';
import { deadlinePhrase } from './pqrs';
import {
  CASE_ROLES,
  CASE_STATUSES,
  CASE_STATUS_LABEL,
  COMPLIANCE_AREA_LABEL,
  ITEM_STATUSES,
  ITEM_STATUS_LABEL,
  PQRS_CHANNELS,
  PQRS_KINDS,
  PQRS_KIND_LABEL,
  PQRS_MATTERS,
  PQRS_OPEN,
} from './shape';
import { listComplianceItems } from './store';

/**
 * Las herramientas de cumplimiento (0195).
 *
 *   compliance.status        Lectura: cómo va la lista por área, qué vence, las
 *                            PQRS abiertas con su plazo y los procesos.
 *   compliance.mark          Marcar una obligación cumplida / en curso / no
 *                            aplica, con evidencia (con confirmación).
 *   compliance.pqrs_create   Radicar una PQRS llegada por correo, WhatsApp o
 *                            teléfono (con confirmación).
 *   compliance.pqrs_respond  Guardar la respuesta de una PQRS (con confirmación).
 *                            Enviarla es otra cosa: un correo con su aprobación.
 *   compliance.case_update   Crear o actualizar un proceso judicial (con confirmación).
 *
 * NADA DE ESTO ES ASESORÍA LEGAL; los umbrales y fechas «por confirmar» se
 * dicen así.
 */

const DISCLAIMER =
  'Esto no es asesoría legal: lo marcado «por confirmar» se confirma con el abogado, el contador o el oficial de cumplimiento.';

// ---------------------------------------------------------------------------
// compliance.status
// ---------------------------------------------------------------------------

export const complianceStatus = registerTool({
  id: 'compliance.status',
  description:
    'The company legal/corporate compliance picture: the checklist by area (societario — asamblea ordinaria, libros, matrícula; datos personales — política, RNBD de la SIC, habeas data; PQRS; SAGRILAFT/PTEE applicability; procesos judiciales) with % done, what is due or overdue and the legal basis of each, plus open PQRS with their legal deadline in Colombian business days and the lawsuits with their next hearing. Answers «¿cómo vamos en cumplimiento?», «¿nos aplica SAGRILAFT?», «¿qué PQRS están por vencer?», «¿cuándo es la próxima audiencia?». Thresholds and dates marked por confirmar must be said that way.',
  inputSchema: z.object({
    area: z
      .enum([
        'societario',
        'datos_personales',
        'consumidor',
        'lavado_activos',
        'transparencia',
        'litigios',
        'otro',
      ])
      .optional(),
  }),
  outputSchema: z.object({
    configured: z.boolean(),
    progress: z.array(
      z.object({
        area: z.string(),
        label: z.string(),
        percent: z.number(),
        done: z.number(),
        total: z.number(),
        overdue: z.number(),
      }),
    ),
    items: z.array(
      z.object({
        id: z.string(),
        key: z.string(),
        title: z.string(),
        area: z.string(),
        status: z.string(),
        applies: z.string(),
        dueOn: z.string().nullable(),
        dueNeedsConfirmation: z.boolean(),
        overdue: z.boolean(),
        legalBasis: z.string().nullable(),
        note: z.string().nullable(),
      }),
    ),
    pqrs: z.array(
      z.object({
        id: z.string(),
        radicado: z.string(),
        kind: z.string(),
        subject: z.string(),
        requester: z.string(),
        due: z.string(),
        businessDaysLeft: z.number(),
      }),
    ),
    cases: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        radicado: z.string().nullable(),
        status: z.string(),
        lastAction: z.string().nullable(),
        nextHearingOn: z.string().nullable(),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const snap = await loadCompliance(ctx.db, today);
    const items = snap.items
      .filter((i) => !input.area || i.area === input.area)
      .map((i) => ({
        id: i.id,
        key: i.item_key,
        title: i.title,
        area: i.area,
        status: i.status,
        applies: i.applies,
        dueOn: i.due_on,
        dueNeedsConfirmation: i.due_needs_confirmation,
        overdue: isItemOverdue(i, today),
        legalBasis: i.legal_basis,
        note: i.applicability_note,
      }));
    const pqrs = snap.pqrs
      .filter((p) => PQRS_OPEN.includes(p.status))
      .map((p) => {
        const d = pqrsDeadline(p, today);
        return {
          id: p.id,
          radicado: p.radicado,
          kind: p.kind,
          subject: p.subject,
          requester: p.requester_name,
          due: d.due,
          businessDaysLeft: d.left,
        };
      })
      .sort((a, b) => a.businessDaysLeft - b.businessDaysLeft);
    const cases = snap.cases
      .filter((c) => c.status === 'activo' || c.status === 'suspendido')
      .map((c) => ({
        id: c.id,
        title: c.title,
        radicado: c.radicado,
        status: c.status,
        lastAction: c.last_action,
        nextHearingOn: c.next_hearing_on,
      }));

    const lines: string[] = [];
    if (!snap.profile) {
      lines.push(
        'La empresa todavía no tiene perfil de cumplimiento: llénalo en /cumplimiento (pestaña «Perfil») y sale la lista.',
      );
    } else {
      for (const a of snap.progress) {
        lines.push(
          `${COMPLIANCE_AREA_LABEL[a.area]}: ${a.done}/${a.total} (${a.percent} %)${a.overdue ? `, ${a.overdue} vencida(s)` : ''}`,
        );
      }
      const pending = items.filter(
        (i) => i.applies !== 'no' && (i.status === 'pendiente' || i.status === 'en_curso'),
      );
      for (const i of pending.slice(0, 12)) {
        lines.push(
          `- ${i.title}${i.dueOn ? ` — ${i.overdue ? 'VENCIDA' : 'vence'} ${i.dueOn}${i.dueNeedsConfirmation ? ' (fecha por confirmar)' : ''}` : ''}${i.applies === 'revisar' ? ' — aplicabilidad POR CONFIRMAR' : ''}. ${i.legalBasis ?? ''}`,
        );
      }
    }
    if (pqrs.length) {
      lines.push(`PQRS ABIERTAS (${pqrs.length}):`);
      for (const p of pqrs.slice(0, 10)) {
        lines.push(
          `- ${p.radicado} ${PQRS_KIND_LABEL[p.kind as keyof typeof PQRS_KIND_LABEL]} de ${p.requester}: «${p.subject}» — ${deadlinePhrase(p.businessDaysLeft).text} (plazo ${p.due})`,
        );
      }
    }
    if (cases.length) {
      lines.push(`PROCESOS JUDICIALES ACTIVOS (${cases.length}):`);
      for (const c of cases.slice(0, 10)) {
        lines.push(
          `- ${c.title}${c.radicado ? ` (${c.radicado})` : ''}: ${CASE_STATUS_LABEL[c.status as keyof typeof CASE_STATUS_LABEL]}${c.nextHearingOn ? `; próxima diligencia ${c.nextHearingOn}` : ''}${c.lastAction ? `; última actuación: ${c.lastAction.slice(0, 140)}` : ''}`,
        );
      }
    }
    lines.push(DISCLAIMER);
    return {
      configured: !!snap.profile,
      progress: snap.progress.map((a) => ({
        area: a.area,
        label: COMPLIANCE_AREA_LABEL[a.area],
        percent: a.percent,
        done: a.done,
        total: a.total,
        overdue: a.overdue,
      })),
      items: items.slice(0, 60),
      pqrs: pqrs.slice(0, 30),
      cases: cases.slice(0, 30),
      guidance: lines.join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// compliance.mark
// ---------------------------------------------------------------------------

export const complianceMark = registerTool({
  id: 'compliance.mark',
  description:
    'Mark an item of the compliance checklist as cumplido (done — needs evidence: a document id, a link or a note of what was done), en_curso, no_aplica (needs the reason as a note) or back to pendiente. Use the id or key from compliance.status (e.g. asamblea_ordinaria, rnbd_inscripcion, politica_datos). Requires confirmation.',
  inputSchema: z.object({
    item: z
      .string()
      .min(3)
      .max(80)
      .describe('Item id, or its key (the current year is used for yearly items)'),
    status: z.enum(ITEM_STATUSES),
    evidenceNote: z.string().max(1000).optional(),
    evidenceUrl: z.string().url().max(500).optional(),
    evidenceDocumentId: z.string().uuid().optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const items = await listComplianceItems(ctx.db, { limit: 1000 });
    const year = today.slice(0, 4);
    const target =
      items.find((i) => i.id === input.item) ??
      items
        .filter((i) => i.item_key === input.item.trim())
        .sort((a, b) => {
          const score = (p: string) => (p === year ? 0 : p.startsWith(year) ? 1 : p === '' ? 2 : 3);
          return (
            score(a.period) - score(b.period) || (a.due_on ?? '').localeCompare(b.due_on ?? '')
          );
        })[0];
    if (!target)
      throw new Error(
        `No encontré «${input.item}» en la lista. Pide compliance.status para ver las claves.`,
      );
    const row = await markComplianceItem(
      ctx.db,
      {
        id: target.id,
        status: input.status,
        evidenceNote: input.evidenceNote ?? null,
        evidenceUrl: input.evidenceUrl ?? null,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
      },
      { userId: ctx.userId, today },
    );
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      guidance: `«${row.title}» quedó ${ITEM_STATUS_LABEL[row.status].toLowerCase()}${row.status === 'cumplido' ? ' con su evidencia' : ''}. ${DISCLAIMER}`,
    };
  },
});

// ---------------------------------------------------------------------------
// compliance.pqrs_create
// ---------------------------------------------------------------------------

export const compliancePqrsCreate = registerTool({
  id: 'compliance.pqrs_create',
  description:
    'Register (radicar) a petición, queja, reclamo, sugerencia or felicitación that arrived by email, WhatsApp, phone or in person — e.g. «radica este correo como un reclamo», «el cliente llamó a quejarse de…». Assigns the next radicado (PQRS-2026-000123) and computes the legal deadline in Colombian business days from the receipt date (15 general, 10 for documents/information or a data-subject consulta, 30 for a consulta, 15 for a data reclamo; consumer complaints 15, marked por confirmar). Use the receipt date of the message, not today, when known. Requires confirmation.',
  inputSchema: z.object({
    kind: z.enum(PQRS_KINDS),
    matter: z.enum(PQRS_MATTERS).default('general'),
    channel: z
      .enum(PQRS_CHANNELS)
      .describe('Where it came from (not «formulario»: that one files itself)'),
    subject: z.string().min(3).max(200),
    body: z
      .string()
      .min(1)
      .max(8000)
      .describe('What the person asked or complained about, in their words'),
    requesterName: z.string().min(2).max(160),
    requesterEmail: z.string().email().optional(),
    requesterPhone: z.string().max(40).optional(),
    requesterIdNumber: z.string().max(40).optional(),
    clientName: z
      .string()
      .max(200)
      .optional()
      .describe('The client company, if the requester belongs to one'),
    receivedAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('When it arrived (ISO). Defaults to now.'),
    sourceRef: z
      .string()
      .max(300)
      .optional()
      .describe('Email message id or WhatsApp conversation id, to find it again'),
    assigneeEmail: z.string().email().optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    radicado: z.string(),
    dueOn: z.string(),
    deadlineBasis: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    if (input.channel === 'formulario')
      throw new Error('Las del formulario público se radican solas.');
    const client = input.clientName ? await findClientByName(ctx.db, input.clientName) : null;
    let assignee: string | null = null;
    if (input.assigneeEmail) {
      const { data, error } = await ctx.db
        .from('users')
        .select('id')
        .eq('email', input.assigneeEmail.toLowerCase())
        .maybeSingle();
      if (error) throw error;
      assignee = (data as { id: string } | null)?.id ?? null;
    }
    const row = await createPqrs(
      ctx.db,
      {
        channel: input.channel,
        kind: input.kind,
        matter: input.matter ?? 'general',
        subject: input.subject,
        body: input.body,
        requesterName: input.requesterName,
        requesterEmail: input.requesterEmail ?? null,
        requesterPhone: input.requesterPhone ?? null,
        requesterIdNumber: input.requesterIdNumber ?? null,
        clientId: client?.id ?? null,
        receivedAt: input.receivedAt ?? null,
        sourceRef: input.sourceRef ?? null,
        assignedUserId: assignee,
      },
      { userId: ctx.userId },
    );
    const d = pqrsDeadline(row, bogotaToday());
    return {
      id: row.id,
      radicado: row.radicado,
      dueOn: row.due_on,
      deadlineBasis: row.deadline_basis,
      guidance: `Radicada ${row.radicado} (${PQRS_KIND_LABEL[row.kind]}). Plazo: ${row.due_on}, ${deadlinePhrase(d.left).text}. ${row.deadline_basis} Se responde desde /cumplimiento?tab=pqrs o con compliance.pqrs_respond; ofrece mandar el acuse de recibo con el radicado.`,
    };
  },
});

// ---------------------------------------------------------------------------
// compliance.pqrs_respond
// ---------------------------------------------------------------------------

export const compliancePqrsRespond = registerTool({
  id: 'compliance.pqrs_respond',
  description:
    'Record the answer to a PQRS (by radicado like PQRS-2026-000012 or id) and mark it respondida (or cerrada). The text must be the actual, complete answer the person approved — never invent facts, refunds or commitments. This only RECORDS it: sending it to the requester is a separate email the person approves (gmail.send_message). Requires confirmation.',
  inputSchema: z.object({
    pqrs: z.string().min(3).max(60),
    text: z.string().min(10).max(12000),
    channel: z.enum(PQRS_CHANNELS).optional(),
    close: z.boolean().default(false),
  }),
  outputSchema: z.object({
    radicado: z.string(),
    status: z.string(),
    onTime: z.boolean(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const row = await respondPqrs(
      ctx.db,
      {
        id: input.pqrs,
        text: input.text,
        channel: input.channel ?? null,
        close: input.close ?? false,
      },
      { userId: ctx.userId, today },
    );
    const d = pqrsDeadline(row, today);
    return {
      radicado: row.radicado,
      status: row.status,
      onTime: !d.overdue,
      guidance: `Respuesta guardada en ${row.radicado}${d.overdue ? ' — FUERA del plazo legal' : ' dentro del plazo'}. ${
        row.requester_email
          ? `Falta enviarla a ${row.requester_email}: ofrécele redactar el correo con gmail.send_message (lo aprueba la persona).`
          : 'No hay correo de quien la presentó: confirma por qué canal se le entrega.'
      }`,
    };
  },
});

// ---------------------------------------------------------------------------
// compliance.case_update
// ---------------------------------------------------------------------------

export const complianceCaseUpdate = registerTool({
  id: 'compliance.case_update',
  description:
    'Create or update a lawsuit (proceso judicial) the company is party to: radicado of 23 digits, court (despacho), parties, status, the latest action (actuación) with its date and the next hearing (diligencia/audiencia), which becomes a watched deadline with an owner. Matches an existing case by id or radicado. Use it to record what the person or the learned Rama Judicial «Consulta de Procesos» trámite reported (checkedVia=rama_judicial) — never invent an actuación. Requires confirmation.',
  inputSchema: z.object({
    id: z.string().uuid().optional(),
    radicado: z.string().max(40).optional().describe('23-digit número único de radicación'),
    title: z.string().min(3).max(200).optional(),
    court: z.string().max(300).optional(),
    city: z.string().max(120).optional(),
    processType: z
      .string()
      .max(160)
      .optional()
      .describe('Clase de proceso: ejecutivo, laboral ordinario, verbal…'),
    role: z.enum(CASE_ROLES).optional(),
    counterparty: z.string().max(300).optional(),
    status: z.enum(CASE_STATUSES).optional(),
    lastActionOn: isoDate.optional(),
    lastAction: z.string().max(1000).optional(),
    nextHearingOn: isoDate.optional(),
    nextHearing: z.string().max(600).optional(),
    lawyer: z.string().max(200).optional(),
    checkedVia: z.enum(['manual', 'rama_judicial']).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    title: z.string(),
    created: z.boolean(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    if (input.radicado && !parseRadicado(normalizeRadicado(input.radicado))) {
      throw new Error('El radicado de la Rama Judicial tiene 23 dígitos; revisa el número.');
    }
    const { row, created, actionAdded } = await upsertLegalCase(
      ctx.db,
      {
        id: input.id,
        radicado: input.radicado,
        title: input.title,
        court: input.court,
        city: input.city,
        processType: input.processType,
        role: input.role,
        counterparty: input.counterparty,
        status: input.status,
        lastActionOn: input.lastActionOn,
        lastAction: input.lastAction,
        nextHearingOn: input.nextHearingOn,
        nextHearing: input.nextHearing,
        lawyer: input.lawyer,
        checkedVia: input.checkedVia,
      },
      { userId: ctx.userId },
    );
    return {
      id: row.id,
      title: row.title,
      created,
      guidance: `${created ? 'Registré' : 'Actualicé'} el proceso «${row.title}»${row.radicado ? ` (${row.radicado})` : ''}.${actionAdded ? ' La actuación quedó en su historia.' : ''}${
        row.next_hearing_on
          ? ` La próxima diligencia (${row.next_hearing_on}) queda vigilada con aviso a su responsable.`
          : ''
      } Los términos procesales los confirma el apoderado: esto no es asesoría legal.`,
    };
  },
});
