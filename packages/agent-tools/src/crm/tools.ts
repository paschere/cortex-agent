import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { listContacts, searchClients } from '../clients/store';
import { addDays, bogotaToday } from '../commitments/shape';
import { personLabel } from '../directory/line';
import { listDirectory } from '../directory/store';
import { gmailFetch } from '../gmail/client';
import { b64url, buildRfc822 } from '../gmail/draft';
import { registerTool } from '../index';
import { GRAPH_SCOPES, graphFetch } from '../msgraph/client';
import { appBaseUrl } from '../reports/store';
import { resolveSalesDocument } from '../sales/tools';
import type { ToolContext } from '../types';
import { atRiskList } from './churn';
import { assessClientRisk, loadCrmBoard } from './read';
import {
  ACTIVITY_LABEL,
  LOGGABLE_KINDS,
  LOST_REASONS,
  LOST_REASON_LABEL,
  RISK_LABEL,
  SOURCES,
  type StageDef,
  effectiveProbability,
  formatAmount,
  isClosedStage,
  stageOf,
} from './shape';
import {
  createOpportunity,
  createSurvey,
  loadStages,
  logActivity,
  markSurveySent,
  resolveOpportunity,
  updateOpportunity,
} from './store';
import { reconcileQuoteStages } from './sync';

/**
 * EL EMBUDO DESDE EL CHAT (migración 0193).
 *
 *   crm.pipeline             el embudo: cuánto hay por etapa, el pronóstico
 *                            ponderado por mes, lo quieto y mis tareas. Lee.
 *   crm.create_opportunity   un negocio nuevo. Confirma.
 *   crm.update_opportunity   moverlo de etapa, cambiar valor, cierre, siguiente
 *                            paso, darlo por perdido (con razón). Confirma.
 *   crm.log_activity         una llamada, reunión, correo, nota o tarea. Confirma.
 *   crm.at_risk              los clientes que se pueden perder, con la evidencia
 *                            y qué hacer. Lee.
 *   crm.send_nps             la encuesta de satisfacción por correo (Gmail u
 *                            Outlook) o sólo el enlace. Confirma (sale de la
 *                            empresa cuando va por correo).
 */

export function surveyPublicUrl(token: string): string {
  return `${appBaseUrl()}/encuesta/${token}`;
}

function stageRef(stages: readonly StageDef[], raw: string): StageDef {
  const clean = raw.trim().toLowerCase();
  const found =
    stages.find((s) => s.key === clean) ??
    stages.find((s) => s.label.toLowerCase() === clean) ??
    stages.find((s) => s.label.toLowerCase().startsWith(clean));
  if (!found)
    throw new ValidationError(
      `No conozco la etapa «${raw}». Las etapas son: ${stages.map((s) => s.label).join(', ')}.`,
    );
  return found;
}

async function resolveClientRef(
  db: SupabaseClient,
  raw: string,
): Promise<{ clientId: string | null; clientName: string; note: string | null }> {
  const hits = await searchClients(db, raw, 5);
  const exact = hits.filter(
    (h) => h.matchedOn === 'nit' || h.client.name.toLowerCase() === raw.trim().toLowerCase(),
  );
  const chosen = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  if (chosen) return { clientId: chosen.client.id, clientName: chosen.client.name, note: null };
  if (hits.length > 1)
    throw new ValidationError(
      `Hay varios clientes que se parecen a «${raw}»: ${hits.map((h) => h.client.name).join(', ')}. ¿Cuál?`,
    );
  return {
    clientId: null,
    clientName: raw.trim(),
    note: `«${raw.trim()}» no está en Clientes: queda como prospecto, a ese nombre.`,
  };
}

async function resolvePerson(db: SupabaseClient, raw: string): Promise<string> {
  const people = await listDirectory(db);
  const q = raw.trim().toLowerCase();
  const hits = people.filter(
    (p) => p.email.toLowerCase() === q || personLabel(p).toLowerCase().includes(q),
  );
  if (hits.length === 1) return (hits[0] as { id: string }).id;
  if (hits.length === 0) throw new ValidationError(`No encuentro a «${raw}» en el equipo.`);
  throw new ValidationError(
    `Hay varias personas que se parecen a «${raw}»: ${hits
      .slice(0, 5)
      .map(personLabel)
      .join(', ')}. ¿Quién?`,
  );
}

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD (Bogotá).');

// ---------------------------------------------------------------------------
// crm.pipeline
// ---------------------------------------------------------------------------

export const crmPipeline = registerTool({
  id: 'crm.pipeline',
  description:
    'Read the sales pipeline (embudo comercial): open opportunities by stage with value and probability, the weighted forecast by month (value × probability), stale deals with no activity and what to do, and open follow-up tasks. «¿cómo va el embudo?», «¿qué negocios tenemos en negociación?», «¿cuánto vamos a vender este trimestre según el embudo?», «¿qué tengo que hacer hoy en ventas?». Read only. Screens: /comercial.',
  inputSchema: z.object({
    client: z.string().max(200).optional().describe('Only this client (name or NIT).'),
    mine: z.boolean().optional().describe('Only opportunities and tasks owned by the caller.'),
    stage: z.string().max(60).optional().describe('Only this stage (name).'),
  }),
  outputSchema: z.object({
    stages: z.array(
      z.object({ stage: z.string(), count: z.number(), value: z.number(), weighted: z.number() }),
    ),
    opportunities: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        client: z.string(),
        stage: z.string(),
        value: z.number(),
        currency: z.string(),
        probability: z.number(),
        expectedClose: z.string().nullable(),
        nextStep: z.string().nullable(),
      }),
    ),
    forecast: z.array(z.object({ month: z.string(), weighted: z.number(), total: z.number() })),
    stale: z.array(
      z.object({ id: z.string(), title: z.string(), why: z.string(), suggestion: z.string() }),
    ),
    tasksDue: z.array(
      z.object({ id: z.string(), title: z.string(), dueOn: z.string().nullable() }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const board = await loadCrmBoard(ctx.db, { today });
    let opps = board.opportunities.filter((o) => !isClosedStage(board.stages, o.stage));
    if (input.client) {
      const c = await resolveClientRef(ctx.db, input.client);
      opps = opps.filter((o) =>
        c.clientId
          ? o.client_id === c.clientId
          : o.client_name.toLowerCase() === c.clientName.toLowerCase(),
      );
    }
    if (input.mine) opps = opps.filter((o) => o.owner_user_id === ctx.userId);
    if (input.stage) {
      const s = stageRef(board.stages, input.stage);
      opps = opps.filter((o) => o.stage === s.key);
    }
    const ids = new Set(opps.map((o) => o.id));
    const stages = board.stages
      .filter((s) => s.role !== 'won' && s.role !== 'lost')
      .map((s) => {
        const mine = opps.filter((o) => o.stage === s.key && o.currency === 'COP');
        return {
          stage: s.label,
          count: mine.length,
          value: mine.reduce((a, o) => a + o.value, 0),
          weighted: Math.round(
            mine.reduce((a, o) => a + (o.value * effectiveProbability(o, board.stages)) / 100, 0),
          ),
        };
      });
    const stale = board.stale.filter((d) => ids.has(d.id)).slice(0, 10);
    const tasks = board.tasks
      .filter(
        (t) => (!input.mine || t.owner_user_id === ctx.userId) && (!t.due_on || t.due_on <= today),
      )
      .slice(0, 20);
    const lines = [
      `**Embudo abierto:** ${opps.length} negocio${opps.length === 1 ? '' : 's'} por ${formatAmount(
        stages.reduce((a, s) => a + s.value, 0),
      )}; ponderado ${formatAmount(stages.reduce((a, s) => a + s.weighted, 0))}.`,
      ...stages
        .filter((s) => s.count > 0)
        .map((s) => `- ${s.stage}: ${s.count} · ${formatAmount(s.value)}`),
      '',
      `**Pronóstico ponderado:** ${board.forecast.months
        .slice(0, 3)
        .map((m) => `${m.month} ${formatAmount(m.weighted)}`)
        .join(
          ' · ',
        )}${board.forecast.undated.count ? ` (+${board.forecast.undated.count} sin fecha de cierre)` : ''}.`,
      stale.length ? `\n**Quietos:** ${stale.map((d) => `«${d.title}» — ${d.why}`).join(' ')}` : '',
    ];
    return {
      stages,
      opportunities: opps.slice(0, 40).map((o) => ({
        id: o.id,
        title: o.title,
        client: o.client_name,
        stage: stageOf(board.stages, o.stage)?.label ?? o.stage,
        value: o.value,
        currency: o.currency,
        probability: effectiveProbability(o, board.stages),
        expectedClose: o.expected_close,
        nextStep: o.next_step,
      })),
      forecast: board.forecast.months.map((m) => ({
        month: m.month,
        weighted: m.weighted,
        total: m.total,
      })),
      stale: stale.map((d) => ({ id: d.id, title: d.title, why: d.why, suggestion: d.suggestion })),
      tasksDue: tasks.map((t) => ({ id: t.id, title: t.title, dueOn: t.due_on })),
      markdown: lines.filter(Boolean).join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// crm.create_opportunity
// ---------------------------------------------------------------------------

export const crmCreateOpportunity = registerTool({
  id: 'crm.create_opportunity',
  description:
    'Create a sales opportunity (oportunidad / negocio) in the pipeline: «abre un negocio con Nexa por 40 millones, cierre en noviembre», «Coltrans quiere cotizar fletes a Cali, unos $12M». Resolves the client from Clientes (an unknown name stays as a prospect). Stage defaults to the first one; probability defaults to the stage’s. Requires confirmation. Link a quote with `quote` (COT-12) so the stage follows the quote automatically.',
  inputSchema: z.object({
    client: z.string().trim().min(1).max(200).describe('Client name or NIT.'),
    title: z.string().trim().min(1).max(200),
    value: z.coerce
      .number()
      .finite()
      .min(0)
      .max(1e14)
      .optional()
      .describe('Expected value in COP (before IVA).'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    stage: z.string().max(60).optional(),
    probability: z.number().int().min(0).max(100).optional(),
    expectedClose: DATE.optional(),
    owner: z
      .string()
      .max(200)
      .optional()
      .describe('Team member name or email; defaults to the caller.'),
    source: z.enum(SOURCES).optional(),
    nextStep: z.string().max(500).optional(),
    nextStepDue: DATE.optional(),
    quote: z.string().max(80).optional().describe('Quote number (COT-12) to link.'),
  }),
  outputSchema: z.object({ id: z.string(), href: z.string(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 12 },
  handler: async (input, ctx) => {
    const { stages } = await loadStages(ctx.db);
    const client = await resolveClientRef(ctx.db, input.client);
    const stage = input.stage ? stageRef(stages, input.stage) : stages[0];
    const quote = input.quote ? await resolveSalesDocument(ctx.db, input.quote) : null;
    if (quote && quote.kind !== 'quote')
      throw new ValidationError(`${input.quote} no es una cotización.`);
    const opp = await createOpportunity(
      ctx.db,
      {
        clientId: client.clientId ?? quote?.client_id ?? null,
        clientName: client.clientName,
        title: input.title,
        value: input.value ?? (quote ? Number(quote.total) : 0),
        currency: input.currency,
        stage: stage?.key,
        probability: input.probability ?? null,
        expectedClose: input.expectedClose ?? null,
        ownerUserId: input.owner ? await resolvePerson(ctx.db, input.owner) : ctx.userId,
        source: input.source,
        nextStep: input.nextStep ?? null,
        nextStepDue: input.nextStepDue ?? null,
        quoteId: quote?.id ?? null,
      },
      { userId: ctx.userId },
    );
    if (quote) {
      await reconcileQuoteStages(ctx.db, { quoteId: quote.id }).catch(() => []);
    }
    return {
      id: opp.id,
      href: `/comercial?tab=oportunidades&abrir=${opp.id}`,
      markdown: `Listo: «${opp.title}» con ${opp.client_name} por ${formatAmount(opp.value, opp.currency)} en ${stage?.label ?? opp.stage}.${client.note ? ` ${client.note}` : ''}`,
    };
  },
});

// ---------------------------------------------------------------------------
// crm.update_opportunity
// ---------------------------------------------------------------------------

export const crmUpdateOpportunity = registerTool({
  id: 'crm.update_opportunity',
  description:
    'Update an opportunity: move it to another stage («pasa lo de Nexa a negociación», «ganamos lo de Coltrans»), mark it lost WITH a reason («lo perdimos por precio»), change value, probability, expected close, owner or next step, or link a quote. Requires confirmation. To mark lost always pass lostReasonKind.',
  inputSchema: z.object({
    opportunity: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('Opportunity id, title or client name.'),
    stage: z.string().max(60).optional(),
    value: z.coerce.number().finite().min(0).max(1e14).optional(),
    probability: z.number().int().min(0).max(100).optional(),
    expectedClose: DATE.optional(),
    owner: z.string().max(200).optional(),
    nextStep: z.string().max(500).optional(),
    nextStepDue: DATE.optional(),
    lostReasonKind: z.enum(LOST_REASONS).optional(),
    lostReason: z.string().max(1000).optional(),
    quote: z.string().max(80).optional(),
    title: z.string().max(200).optional(),
  }),
  outputSchema: z.object({ id: z.string(), stage: z.string(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const opp = await resolveOpportunity(ctx.db, input.opportunity);
    const { stages } = await loadStages(ctx.db);
    const stage = input.stage ? stageRef(stages, input.stage) : null;
    if (stage?.role === 'lost' && !input.lostReasonKind && !opp.lost_reason_kind)
      throw new ValidationError(
        `¿Por qué se perdió «${opp.title}»? (${LOST_REASONS.map((r) => LOST_REASON_LABEL[r].toLowerCase()).join(', ')}). Así el análisis de pérdidas sirve.`,
      );
    const quote = input.quote ? await resolveSalesDocument(ctx.db, input.quote) : null;
    const next = await updateOpportunity(
      ctx.db,
      opp.id,
      {
        ...(stage ? { stage: stage.key } : {}),
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.probability !== undefined ? { probability: input.probability } : {}),
        ...(input.expectedClose ? { expectedClose: input.expectedClose } : {}),
        ...(input.owner ? { ownerUserId: await resolvePerson(ctx.db, input.owner) } : {}),
        ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}),
        ...(input.nextStepDue ? { nextStepDue: input.nextStepDue } : {}),
        ...(input.lostReasonKind ? { lostReasonKind: input.lostReasonKind } : {}),
        ...(input.lostReason !== undefined ? { lostReason: input.lostReason } : {}),
        ...(quote ? { quoteId: quote.id } : {}),
        ...(input.title ? { title: input.title } : {}),
      },
      { userId: ctx.userId, origin: 'agent' },
    );
    if (quote) {
      await reconcileQuoteStages(ctx.db, { quoteId: quote.id }).catch(() => []);
    }
    const label = stageOf(stages, next.stage)?.label ?? next.stage;
    return {
      id: next.id,
      stage: label,
      markdown: `Listo: «${next.title}» (${next.client_name}) quedó en ${label}, ${formatAmount(next.value, next.currency)} al ${effectiveProbability(next, stages)} %.`,
    };
  },
});

// ---------------------------------------------------------------------------
// crm.log_activity
// ---------------------------------------------------------------------------

export const crmLogActivity = registerTool({
  id: 'crm.log_activity',
  description:
    'Log a sales activity on an opportunity or a client: a call, meeting, email or note that happened («hablé con Nexa, quieren descuento»), or a follow-up task with a due date («recuérdame llamar a Coltrans el jueves»). A task is assigned to the opportunity owner (or the client owner) unless `owner` is given. Requires confirmation.',
  inputSchema: z.object({
    opportunity: z.string().max(200).optional().describe('Opportunity id, title or client name.'),
    client: z.string().max(200).optional().describe('Client, when there is no opportunity.'),
    kind: z.enum(LOGGABLE_KINDS),
    title: z.string().trim().min(1).max(300),
    body: z.string().max(4000).optional(),
    dueOn: DATE.optional().describe('Tasks: when it is due.'),
    owner: z.string().max(200).optional(),
    done: z.boolean().optional().describe('Tasks: already done.'),
  }),
  outputSchema: z.object({ id: z.string(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    if (!input.opportunity && !input.client)
      throw new ValidationError('¿Sobre qué negocio o qué cliente es?');
    const opp = input.opportunity ? await resolveOpportunity(ctx.db, input.opportunity) : null;
    let clientId = opp?.client_id ?? null;
    let clientOwner: string | null = null;
    if (!opp && input.client) {
      const c = await resolveClientRef(ctx.db, input.client);
      if (!c.clientId) throw new ValidationError(`«${input.client}» no está en Clientes.`);
      clientId = c.clientId;
    }
    if (clientId && !opp?.owner_user_id) {
      const { data, error } = await ctx.db
        .from('clients')
        .select('owner_user_id')
        .eq('id', clientId)
        .maybeSingle();
      if (error) throw error;
      clientOwner = (data as { owner_user_id?: string | null } | null)?.owner_user_id ?? null;
    }
    const owner = input.owner
      ? await resolvePerson(ctx.db, input.owner)
      : input.kind === 'task'
        ? (opp?.owner_user_id ?? clientOwner ?? ctx.userId)
        : ctx.userId;
    const activity = await logActivity(ctx.db, {
      opportunityId: opp?.id ?? null,
      clientId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      dueOn: input.kind === 'task' ? (input.dueOn ?? bogotaToday()) : null,
      doneAt: input.kind === 'task' && input.done ? new Date().toISOString() : null,
      ownerUserId: owner,
      origin: ctx.surface === 'schedule' ? 'autopilot' : 'agent',
      createdBy: ctx.userId,
    });
    return {
      id: activity.id,
      markdown: `Anotado: ${ACTIVITY_LABEL[activity.kind].toLowerCase()} «${activity.title}»${
        opp ? ` en «${opp.title}»` : ''
      }${activity.kind === 'task' && activity.due_on ? ` para el ${activity.due_on}` : ''}.`,
    };
  },
});

// ---------------------------------------------------------------------------
// crm.at_risk
// ---------------------------------------------------------------------------

export const crmAtRisk = registerTool({
  id: 'crm.at_risk',
  description:
    'Clients at risk of being lost (riesgo de perder clientes / churn): for each one the risk level, the evidence sentences (buying less often than their own history, revenue drop, paying later, no contact, WhatsApp complaints, NPS detractor) and a suggested action. «¿qué clientes se nos están yendo?», «¿Nexa está contento?», «¿a quién debería llamar?». Relay the evidence as written; never invent a reason. Read only.',
  inputSchema: z.object({
    client: z
      .string()
      .max(200)
      .optional()
      .describe('Only this client (shows its signals even if low).'),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  outputSchema: z.object({
    clients: z.array(
      z.object({
        clientId: z.string(),
        client: z.string(),
        level: z.string(),
        score: z.number(),
        evidence: z.array(z.string()),
        action: z.string().nullable(),
        owner: z.string().nullable(),
        revenue12m: z.number(),
      }),
    ),
    missing: z.array(z.string()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    let clientIds: string[] | undefined;
    if (input.client) {
      const c = await resolveClientRef(ctx.db, input.client);
      if (!c.clientId) throw new ValidationError(`«${input.client}» no está en Clientes.`);
      clientIds = [c.clientId];
    }
    const risk = await assessClientRisk(ctx.db, { today, clientIds });
    const list = (clientIds ? risk.assessments : atRiskList(risk.assessments)).slice(
      0,
      input.limit ?? 10,
    );
    const markdown = list.length
      ? list
          .map(
            (a) =>
              `**${a.clientName}** — ${RISK_LABEL[a.level]} (${a.score}/100). ${a.signals.map((s) => s.evidence).join(' ') || 'Sin señales.'}${a.action ? ` → ${a.action}` : ''}`,
          )
          .join('\n')
      : 'Ningún cliente activo muestra señales de que se esté yendo.';
    return {
      clients: list.map((a) => ({
        clientId: a.clientId,
        client: a.clientName,
        level: a.level,
        score: a.score,
        evidence: a.signals.map((s) => s.evidence),
        action: a.action,
        owner: risk.owners.get(a.clientId) ?? null,
        revenue12m: a.revenue12m,
      })),
      missing: risk.missing,
      markdown: risk.missing.length
        ? `${markdown}\n\n_No pude leer: ${risk.missing.join(', ')}._`
        : markdown,
    };
  },
});

// ---------------------------------------------------------------------------
// crm.send_nps
// ---------------------------------------------------------------------------

async function sendMail(
  ctx: ToolContext,
  mail: { to: string[]; subject: string; body: string },
): Promise<'gmail' | 'outlook' | null> {
  const gmail = await ctx.integrations
    .hasScopes('google', ['https://www.googleapis.com/auth/gmail.compose'])
    .catch(() => false);
  if (gmail) {
    await gmailFetch(ctx, '/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: b64url(buildRfc822(mail)) }),
    });
    return 'gmail';
  }
  const outlook = await ctx.integrations
    .hasScopes('microsoft', [GRAPH_SCOPES.MAIL_SEND])
    .catch(() => false);
  if (outlook) {
    await graphFetch<void>(ctx, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: 'Text', content: mail.body },
          toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
    });
    return 'outlook';
  }
  return null;
}

export function surveyEmail(input: {
  company: string;
  contactName: string | null;
  link: string;
  message?: string | null;
}): { subject: string; body: string } {
  const company = input.company || 'nuestra empresa';
  return {
    subject: `¿Cómo te ha ido con ${company}? (una pregunta)`.slice(0, 300),
    body: [
      input.contactName ? `Hola ${input.contactName.split(' ')[0]},` : 'Hola,',
      '',
      input.message?.trim() ||
        `Queremos saber cómo te ha ido trabajando con ${company}. Es una sola pregunta, de 0 a 10, y un comentario si quieres:`,
      '',
      input.link,
      '',
      'Gracias por tu tiempo.',
    ].join('\n'),
  };
}

export const crmSendNps = registerTool({
  id: 'crm.send_nps',
  description:
    "Send a satisfaction survey (NPS, 0–10 «¿qué tan probable es que nos recomiende?» plus a comment) to a client: by email from the user's Gmail or Outlook, or just create the private link (`linkOnly`) for the person to send by WhatsApp. Defaults `to` to the client's primary contact email. Requires confirmation. A detractor answer (0–6) creates a follow-up task for the client's owner.",
  inputSchema: z.object({
    client: z.string().trim().min(1).max(200),
    to: z.array(z.string().email()).min(1).max(3).optional(),
    contactName: z.string().max(200).optional(),
    message: z.string().max(1000).optional(),
    linkOnly: z.boolean().optional().describe('Only create the link; do not email it.'),
  }),
  outputSchema: z.object({
    surveyId: z.string(),
    link: z.string(),
    sentTo: z.array(z.string()),
    via: z.enum(['gmail', 'outlook', 'link']),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const client = await resolveClientRef(ctx.db, input.client);
    let to = input.to ?? [];
    let contactName = input.contactName ?? null;
    if (!input.linkOnly && to.length === 0 && client.clientId) {
      const contacts = await listContacts(ctx.db, client.clientId);
      const primary =
        contacts.find((c) => c.is_primary && c.email && c.status !== 'left') ??
        contacts.find((c) => c.email && c.status !== 'left');
      if (primary?.email) {
        to = [primary.email];
        contactName = contactName ?? primary.full_name;
      }
    }
    if (!input.linkOnly && to.length === 0)
      throw new ValidationError(
        `${client.clientName} no tiene un correo de contacto. ¿A qué correo la mando? (O pide sólo el enlace para mandarlo por WhatsApp.)`,
      );
    const survey = await createSurvey(
      ctx.db,
      {
        clientId: client.clientId,
        clientName: client.clientName,
        contactName,
        contactEmail: to[0] ?? null,
        channel: input.linkOnly ? 'link' : 'email',
        expiresOn: addDays(bogotaToday(), 60),
      },
      { userId: ctx.userId },
    );
    const link = surveyPublicUrl(survey.token);
    if (input.linkOnly)
      return {
        surveyId: survey.id,
        link,
        sentTo: [],
        via: 'link' as const,
        markdown: `Este es el enlace de la encuesta para ${client.clientName}: ${link}\nMándalo por donde prefieras; la respuesta llega a /comercial.`,
      };
    const { data: brand, error: brandError } = await ctx.db
      .from('company_branding')
      .select('display_name')
      .maybeSingle();
    const company = brandError
      ? ''
      : ((brand as { display_name?: string | null } | null)?.display_name ?? '').trim();
    const via = await sendMail(ctx, {
      to,
      ...surveyEmail({ company, contactName, link, message: input.message }),
    });
    if (!via)
      throw new ValidationError(
        `Para mandar la encuesta por correo conecta Gmail u Outlook en Integraciones. El enlace ya existe: ${link}`,
      );
    await markSurveySent(ctx.db, survey.id);
    return {
      surveyId: survey.id,
      link,
      sentTo: to,
      via,
      markdown: `Listo: le mandé la encuesta a ${to.join(', ')} desde tu ${via === 'gmail' ? 'Gmail' : 'Outlook'}. Si califica de 0 a 6, le queda una tarea de seguimiento a su responsable.`,
    };
  },
});
