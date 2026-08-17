import { buildToolContext } from '@/lib/agent';
import { sendEmail } from '@/lib/email';
import { renderApprovalEscalationEmail } from '@/lib/email-templates';
import { sendChatDm, toChatText } from '@/lib/google-chat';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  ACTION_KIND_LABEL,
  type ActionRow,
  type CommitmentRow,
  MAX_ESCALATIONS_PER_RUN,
  REMINDER_COOLDOWN_MS,
  bogotaToday,
  draftOwnerReminder,
  escalationHoursFrom,
  escalationsDue,
  findReply,
  getCommitment,
  gmailReadThread,
  listActions,
  listCommitments,
  loadManagerMap,
  markEscalated,
  orgAdmins,
  outcomeNoteForResolution,
  planOwnerReminders,
  proposeAction,
  recentlyActedOrigins,
  recordOutcome,
  runTool,
  silenceIsFinal,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';

/**
 * The part that makes proposed actions a product rather than a chat feature:
 * nobody has to be looking.
 *
 * Every morning, per workspace, Cortex reads what is lapsing or already lapsed,
 * writes the reminder to whoever answers for it, and leaves it in that person's
 * queue. Then it goes back over everything it sent and finds out what came of
 * it — who answered, what got resolved, and what has been sitting in silence
 * long enough to be worth saying out loud.
 *
 * ── NOTHING HERE SENDS ANYTHING ───────────────────────────────────────────
 * This function's entire output is rows in `state='proposed'`. There is no
 * branch, no configuration flag and no elapsed-time condition that causes an
 * action to execute — approval is a human pressing a button, and that button is
 * on a different surface entirely. That is the posture schedule-run already
 * takes with confirmation-gated tools: skip it, report it, never run it.
 *
 * ── IDEMPOTENCE IS NOT BEST-EFFORT ────────────────────────────────────────
 * Inngest retries steps, deploys restart them, and a cron that fires twice is a
 * normal Tuesday. "Have we already proposed this" is therefore not decided
 * here: it is decided by the partial unique index on
 * (organization_id, kind, origin_kind, origin_id) where state='proposed' in
 * migration 0077. This code writes and either wins or is told it already has.
 * The seven-day cooldown on top of that is a different question — not "did we
 * propose this" but "did we already bother this person about it recently" —
 * and it is why an approved-and-sent reminder does not come back tomorrow.
 *
 * ── SHAPE ─────────────────────────────────────────────────────────────────
 * Cron dispatcher + per-workspace event, the same as schedule-dispatch /
 * schedule-run, memory-derive and commitments-watch: one function decides who
 * is due and fans out, one does the work for a single workspace so a failure is
 * contained and Inngest retries only that workspace.
 */

/**
 * 06:30 in Bogotá, thirty minutes after the commitments watcher.
 *
 * The order matters: the watcher recomputes in-force / lapsing / lapsed against
 * today, and drafting a reminder off yesterday's cached state is how somebody
 * gets an email about a SOAT that was renewed last night. Colombia has no
 * daylight saving, so 11:30 UTC is 06:30 there every day of the year.
 */
const SWEEP_CRON = '30 11 * * *';

/**
 * How many reminders one workspace may be offered per run.
 *
 * Not a performance limit — it is an attention limit. A queue that arrives with
 * sixty drafts in it on the first morning does not get worked through, it gets
 * ignored, and the feature is dead before anyone has approved anything.
 * `planOwnerReminders` sorts by due date, so the cap keeps what already lapsed
 * and defers what has a month left to tomorrow.
 */
const MAX_PROPOSALS_PER_RUN = 15;

/** How many executed actions one run follows up on. Each costs a Gmail read. */
const MAX_FOLLOW_UPS_PER_RUN = 40;

/**
 * Cuántas horas parada tiene que llevar una propuesta antes de avisarle al jefe
 * del dueño. `APPROVAL_ESCALATION_HOURS`, 48 por defecto.
 *
 * EL 48 SALE DE LOS NÚMEROS DE ESTE ARCHIVO, no del gusto: la propuesta vive 7
 * días (`PROPOSAL_TTL_MS`) y este barrido corre UNA VEZ AL DÍA, a las 06:30 de
 * Bogotá. 48 h le dejan al dueño DOS MAÑANAS COMPLETAS para contestar lo suyo
 * sin que nadie por encima se entere —una sola no basta: quien propuso el lunes
 * por la tarde y viaja el martes recibiría un escalado por no abrir el correo en
 * un día hábil— y todavía dejan CINCO DÍAS entre el aviso y el vencimiento, que
 * es el margen que hace que escalar sirva para algo.
 *
 * El parseo defensivo (basura → 48, fuera de rango → recortado, con el techo por
 * debajo de los 7 días para que nadie apague el escalado sin querer) vive en
 * `escalationHoursFrom`, que es pura y tiene pruebas.
 */
const ESCALATION_AFTER_MS = escalationHoursFrom(process.env.APPROVAL_ESCALATION_HOURS) * 3_600_000;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** El cuerpo, extraído a la firma de la cola nueva; `event` no se usa. */
export const actionsSweepDispatchJob: JobHandler = async ({ step }) => {
  // Unscoped, and only here. "Which workspaces have anything to sweep" spans
  // the install and there is no session behind a cron. Every workspace id read
  // here rides on its own event, and the per-workspace function below builds
  // every handle from that id — so one company's sweep can only ever read and
  // write that company's rows.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const db = getSupabaseServiceClient();
    const seen = new Set<string>();
    // Three sources: somewhere to propose from, something already sent that is
    // still waiting on an answer, y algo propuesto que nadie ha contestado.
    // La tercera se añadió con el paso 3: una acción propuesta desde el chat
    // (`origin_kind='manual'`) en un espacio sin compromisos ni envíos no
    // aparecía en ninguna de las otras dos, así que era exactamente la clase de
    // fila que se quedaba parada para siempre — y el escalado no la habría
    // visto nunca porque este espacio no recibía evento.
    const [{ data: commitments }, { data: awaiting }, { data: proposed }] = await Promise.all([
      db.from('commitments').select('organization_id').limit(20_000),
      db.from('actions').select('organization_id').eq('outcome', 'awaiting').limit(20_000),
      db.from('actions').select('organization_id').eq('state', 'proposed').limit(20_000),
    ]);
    for (const row of [...(commitments ?? []), ...(awaiting ?? []), ...(proposed ?? [])] as Array<{
      organization_id: string | null;
    }>) {
      if (row.organization_id) seen.add(row.organization_id);
    }
    return [...seen];
  });

  if (workspaces.length > 0) {
    await step.sendEvent(
      'sweep-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'actions/sweep.workspace' as const,
        data: { organizationId },
      })),
    );
  }
  return { dispatched: workspaces.length };
};

export const actionsSweepDispatch = inngest.createFunction(
  { id: 'actions-sweep-dispatch' },
  { cron: SWEEP_CRON },
  async (ctx) => actionsSweepDispatchJob(ctx as unknown as JobContext),
);

// ---------------------------------------------------------------------------
// One workspace
// ---------------------------------------------------------------------------

/**
 * The agent a proposal is attributed to.
 *
 * An action has to name one, because executing it later builds a tool context
 * and every audit row in this product is written against an agent. There is no
 * session here to take it from, so it comes off the workspace: its `cortex`
 * agent if it has one, otherwise whichever it has.
 */
async function defaultAgentId(organizationId: string): Promise<string | null> {
  const db = getOrgScopedClient(organizationId);
  const { data: named } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (named?.id) return named.id as string;
  const { data: any } = await db.from('agents').select('id').limit(1).maybeSingle();
  return (any?.id as string | undefined) ?? null;
}

export const actionsSweepWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };

  // Computed once and carried through every step, so a run that straddles
  // midnight in Bogotá still agrees with itself about which day it is
  // deciding for. Same reasoning as commitments-watch.
  const today = bogotaToday();

  // 1. What deserves a reminder, and to whom -----------------------------
  const proposed = await step.run('propose-reminders', async () => {
    const db = getOrgScopedClient(organizationId);
    const agentId = await defaultAgentId(organizationId);
    if (!agentId) return { proposed: 0, skipped: 'no agent in this workspace' };

    const commitments = await listCommitments(db, {
      states: ['due_soon', 'overdue'],
      reviewState: 'confirmed',
      today,
      limit: 1000,
    });
    if (commitments.length === 0) return { proposed: 0 };

    const recent = await recentlyActedOrigins(db, new Date(Date.now() - REMINDER_COOLDOWN_MS));
    const candidates = planOwnerReminders({
      commitments,
      today,
      recentOriginIds: recent,
    }).slice(0, MAX_PROPOSALS_PER_RUN);
    if (candidates.length === 0) return { proposed: 0 };

    // Addresses in one query. An owner without an email address on their
    // directory row is skipped rather than guessed at.
    const ownerIds = [
      ...new Set(candidates.map((c) => c.commitment.owner_user_id).filter(Boolean)),
    ] as string[];
    const { data: owners } = await db.from('users').select('id, name, email').in('id', ownerIds);
    const byId = new Map(
      ((owners ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
        u.id,
        u,
      ]),
    );

    let count = 0;
    for (const candidate of candidates) {
      const owner = byId.get(candidate.commitment.owner_user_id as string);
      if (!owner?.email) continue;
      const draft = draftOwnerReminder(
        candidate.commitment as CommitmentRow,
        today,
        owner.name?.trim().split(' ')[0] ?? null,
      );
      try {
        const result = await proposeAction(db, {
          // The action belongs to the person who has to answer for the
          // deadline: they approve it, and it leaves from their Gmail.
          userId: owner.id,
          agentId,
          kind: 'remind_owner',
          toolId: 'gmail.send_message',
          payload: { to: [owner.email], subject: draft.subject, body: draft.body },
          originKind: 'commitment',
          originId: candidate.commitment.id,
          rationale: draft.rationale,
        });
        if (result.outcome === 'proposed') count += 1;
      } catch (err) {
        // One bad row must not cost the workspace its whole sweep.
        logger.warn('actions-sweep: could not propose a reminder', {
          organizationId,
          commitmentId: candidate.commitment.id,
          error: (err as Error).message,
        });
      }
    }
    return { proposed: count, considered: candidates.length };
  });

  // 2. What came of what already went out ---------------------------------
  // Deliberately a separate step: a Gmail outage must not cost the workspace
  // the proposals above, which are the part somebody is waiting for.
  const closed = await step.run('close-the-loop', async () => {
    const db = getOrgScopedClient(organizationId);
    const open = await listActions(db, { outcome: 'awaiting', limit: MAX_FOLLOW_UPS_PER_RUN });
    if (open.length === 0) return { closed: 0 };

    const userIds = [...new Set(open.map((a) => a.user_id))];
    const { data: users } = await db.from('users').select('id, email').in('id', userIds);
    const emailOf = new Map(
      ((users ?? []) as Array<{ id: string; email: string }>).map((u) => [u.id, u.email]),
    );

    let count = 0;
    for (const action of open) {
      try {
        if (await closeOne(organizationId, action, emailOf.get(action.user_id) ?? null)) {
          count += 1;
        }
      } catch (err) {
        logger.warn('actions-sweep: follow-up failed', {
          organizationId,
          actionId: action.id,
          error: (err as Error).message,
        });
      }
    }
    return { closed: count, checked: open.length };
  });

  // 3. Lo que lleva parado y nadie ha contestado --------------------------
  // Un tercer paso, y separado con la misma disciplina que los otros dos: si
  // esto falla —una línea de mando rota, un correo que no sale, Google Chat
  // caído— no puede costarle al espacio ni las propuestas del paso 1 ni el
  // cierre del ciclo del paso 2, que son la parte que alguien está esperando.
  const escalated = await step.run('escalate-stale', async () => escalateStale(organizationId));

  return { proposed, closed, escalated };
};

export const actionsSweepWorkspace = inngest.createFunction(
  { id: 'actions-sweep-workspace', concurrency: { limit: 5 } },
  { event: 'actions/sweep.workspace' },
  async (ctx) => actionsSweepWorkspaceJob(ctx as unknown as JobContext),
);

/**
 * Decide, for one sent action, whether the loop has closed.
 *
 * The order is what makes the answers honest. A reply is the strongest evidence
 * and is checked first. The commitment being met is next, and it is checked
 * even when the mailbox cannot be read — a payment recorded as received closes
 * the cobro whether or not anybody wrote back. Silence is last, and only
 * counts once the window has genuinely passed.
 */
async function closeOne(
  organizationId: string,
  action: ActionRow,
  ourEmail: string | null,
): Promise<boolean> {
  const db = getOrgScopedClient(organizationId);

  // Did anybody answer?
  if (action.thread_id && action.executed_at && ourEmail && action.agent_id) {
    try {
      const ctx = buildToolContext({
        organizationId,
        userId: action.user_id,
        agentId: action.agent_id,
        surface: 'schedule',
      });
      const read = await runTool(gmailReadThread, { threadId: action.thread_id }, ctx);
      const verdict = findReply(read.thread.messages, {
        executedAt: new Date(action.executed_at),
        ourAddresses: [ourEmail],
      });
      if (verdict.replied) {
        await recordOutcome(db, { id: action.id, outcome: 'replied', note: verdict.note });
        return true;
      }
    } catch (err) {
      // A missing scope, a revoked token, a deleted thread. None of those are a
      // reason to stop asking the other two questions.
      logger.debug('actions-sweep: could not read the thread', {
        actionId: action.id,
        error: (err as Error).message,
      });
    }
  }

  // Did the thing it was about get closed?
  if (action.origin_kind === 'commitment' && action.origin_id) {
    const commitment = await getCommitment(db, action.origin_id);
    if (commitment && (commitment.state === 'met' || commitment.state === 'dropped')) {
      await recordOutcome(db, {
        id: action.id,
        outcome: 'resolved',
        note: outcomeNoteForResolution(
          commitment.state === 'met' ? 'commitment_met' : 'commitment_dropped',
        ),
      });
      return true;
    }
  }

  // Has the silence gone on long enough to be a finding?
  if (silenceIsFinal(action.executed_at)) {
    await recordOutcome(db, {
      id: action.id,
      outcome: 'no_reply',
      note: 'Nadie contestó en diez días. Puede que valga la pena insistir o llamar.',
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Escalación por línea de mando
// ---------------------------------------------------------------------------

/**
 * Avisarle al jefe de lo que lleva N horas parado en la cola de su gente.
 *
 * ===========================================================================
 * EL HUECO QUE ESTO TAPA
 * ===========================================================================
 * El paso 1 propone y el paso 2 cierra lo que ya se envió. Entre los dos no
 * había NADA, y ese hueco era el modo de fallo entero de esta función: una
 * propuesta que nadie mira se queda quieta sus siete días y expira sin que se
 * entere un alma. La fila existe, el barrido corrió las siete mañanas, todos los
 * registros dicen «ok», y la factura sigue sin cobrarse. Un silencio que no deja
 * rastro es indistinguible de un «no hacía falta».
 *
 * ===========================================================================
 * ESCALAR ES AVISAR, NO TRANSFERIR. `user_id` NO SE TOCA
 * ===========================================================================
 * `claimAction` sólo deja aprobar al dueño de la fila, y así se queda: el correo
 * sale de SU Gmail y va firmado con SU nombre, de modo que «lo aprobó su jefe»
 * sería una firma falsificada con traza de auditoría. Lo que hace este paso es
 * mandarle al jefe un «esto lleva N horas sin moverse», y el propio correo le
 * dice que no es él quien lo aprueba — sin esa frase, el jefe entra a Cortex, no
 * encuentra ningún botón y concluye que el producto está roto.
 *
 * ===========================================================================
 * LA OTRA COLA NO SE ESCALA, Y ES A PROPÓSITO
 * ===========================================================================
 * `public.mcp_pending_actions` (0033/0047) es la otra cola de aprobaciones de
 * este producto, y expira a los QUINCE MINUTOS (`APPROVAL_TTL_MS`,
 * apps/web/lib/approval-email.ts). Un barrido diario NO PUEDE escalar algo que
 * muere en quince minutos: cuando este cron mira la tabla, todo lo que había
 * expiró hace horas, y lo único que se conseguiría es mandarle al jefe un correo
 * sobre una llamada que ya nadie puede aprobar. Eso es ruido puro y encima
 * desprestigia el canal: un jefe con tres avisos inútiles no abre el cuarto, que
 * era el que importaba. Esa cola ya responde al silencio como toca a su escala
 * —correo y DM de Google Chat a la vez, para alcanzar la superficie que la
 * persona tenga abierta AHORA— y si hay que mejorarla se mejora ahí, en
 * segundos, no aquí con un cron diario.
 *
 * ===========================================================================
 * EL AVISO PRIMERO, LA MARCA DESPUÉS
 * ===========================================================================
 * `markEscalated` se llama SÓLO si el correo salió, y lleva `escalated_at is
 * null` en su WHERE para que dos corridas simultáneas manden un aviso y no dos.
 * El orden importa en la dirección que importa: si el correo falla, la fila se
 * queda sin marcar y mañana se reintenta. Un rastro que dice «escalado» sin que
 * nadie haya recibido nada es la única forma de que esto mienta, y mentir es
 * peor que llegar un día tarde.
 */
async function escalateStale(organizationId: string) {
  const db = getOrgScopedClient(organizationId);

  const open = await listActions(db, { states: ['proposed'], limit: 500 });
  if (open.length === 0) return { escalated: 0 };

  // Los dos se resuelven AHORA y no se congelan en ninguna fila: un cambio de
  // jefe o un administrador nuevo tienen efecto esta misma mañana. Mismo
  // razonamiento que commitments-watch, y el `order by` de `orgAdmins` es lo que
  // impide que el último recurso lo elija el planificador de Postgres.
  const [admins, managers] = await Promise.all([orgAdmins(db), loadManagerMap(db)]);

  const due = escalationsDue({
    actions: open,
    now: new Date(),
    afterMs: ESCALATION_AFTER_MS,
    managers,
    admins,
    limit: MAX_ESCALATIONS_PER_RUN,
  });
  if (due.length === 0) return { escalated: 0, waiting: open.length };

  // Nombres y direcciones de todos los implicados en una sola consulta: los
  // dueños para poder nombrarlos en el texto, los jefes para poder escribirles.
  const byId = new Map(open.map((a) => [a.id, a]));
  const peopleIds = [
    ...new Set(due.flatMap((e) => [e.toUserId, byId.get(e.actionId)?.user_id ?? ''])),
  ].filter(Boolean);
  // `mustReadList` y no una desestructuración a secas: quedarse con las filas
  // sin mirar el error convierte una base caída en un mapa vacío, o sea «ningún
  // jefe tiene correo», o sea CERO ESCALADOS Y NINGUNA FILA MARCADA — un barrido
  // verde que no avisó a nadie y que tampoco deja rastro de no haber avisado. Es
  // la forma de fallo que documenta lib/unchecked-reads.test.ts, y aquí el
  // silencio es justo lo único que este paso existe para impedir. Levantar rompe
  // el paso, que se reintenta; los otros dos ya corrieron en sus propios pasos.
  const people = mustReadList<{ id: string; name: string | null; email: string }>(
    await db.from('users').select('id, name, email').in('id', peopleIds),
    'las direcciones de la línea de mando',
  );
  const person = new Map(people.map((u) => [u.id, u]));

  let escalated = 0;
  let unreachable = 0;
  for (const item of due) {
    const action = byId.get(item.actionId);
    const manager = person.get(item.toUserId);
    const owner = action ? person.get(action.user_id) : undefined;
    // Un jefe sin correo en su fila de directorio se salta SIN marcar la acción,
    // para que mañana —cuando alguien le ponga la dirección— se vuelva a
    // intentar. Marcarla ahora sería archivar como avisado a quien no recibió.
    if (!action || !manager?.email) {
      unreachable += 1;
      continue;
    }

    const ownerLabel = owner?.name?.trim() || owner?.email || 'quien la tiene asignada';
    const mail = renderApprovalEscalationEmail({
      managerFirstName: manager.name?.trim().split(' ')[0] ?? null,
      ownerLabel,
      kindLabel: ACTION_KIND_LABEL[action.kind] ?? action.kind,
      recipient: action.recipient,
      subject: action.subject,
      rationale: action.rationale,
      hoursWaiting: item.hoursWaiting,
      expiresAt: action.expires_at,
      via: item.via,
    });

    try {
      const sent = await sendEmail({
        to: manager.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      // El correo es el canal que decide. Si no salió, NO se marca la fila.
      if (!sent.sent) {
        unreachable += 1;
        logger.warn('actions-sweep: no se pudo escalar por correo', {
          organizationId,
          actionId: action.id,
          reason: sent.reason,
        });
        continue;
      }

      // Segundo canal, no reemplazo, igual que en las aprobaciones: quien vive
      // en Chat no debería tener que fijarse en un correo. Sin tarjeta a
      // propósito —el jefe no puede aprobar nada, así que un botón sería
      // mentira— y `sendChatDm` es un no-op para quien nunca enlazó Chat.
      const chat = await sendChatDm({
        organizationId,
        userId: item.toUserId,
        text: toChatText(
          [
            `⏳ **Lleva ${item.hoursWaiting} horas sin aprobarse**`,
            '',
            `${mail.subject}`,
            '',
            `Responsable: ${ownerLabel}. Sólo ${ownerLabel} puede aprobarlo — el correo sale de su Gmail. Te aviso para que lo puedas mover.`,
          ].join('\n'),
        ),
      });
      if (!chat.sent && chat.reason !== 'not linked') {
        logger.debug('actions-sweep: DM de escalado no entregado', {
          actionId: action.id,
          reason: chat.reason,
        });
      }

      // La marca va la última y es condicional. Si la pierde (otra corrida se
      // adelantó), lo peor que pasó es un correo duplicado; si fuera al revés,
      // lo que se perdería es el aviso entero.
      const marked = await markEscalated(db, {
        id: action.id,
        toUserId: item.toUserId,
        via: item.via,
      });
      if (!marked) continue;
      escalated += 1;

      // La auditoría se escribe bajo el DUEÑO y no bajo el jefe: es su acción y
      // es su rastro el que tiene que poder explicar por qué salió un correo
      // por encima de su cabeza. A quién se le avisó va en los metadatos.
      await writeAuditEvent({
        db,
        userId: action.user_id as UUID,
        agentId: (action.agent_id ?? undefined) as UUID | undefined,
        toolId: '__approval_escalation',
        input: { actionId: action.id, hoursWaiting: item.hoursWaiting },
        status: 'ok',
        latencyMs: 0,
        surface: 'schedule',
        decision: 'allowed',
        riskReason: `Nadie contestó esta aprobación en ${item.hoursWaiting} horas.`,
        metadata: {
          actionId: action.id,
          kind: action.kind,
          escalatedTo: item.toUserId,
          via: item.via,
          hoursWaiting: item.hoursWaiting,
          chatDm: chat.sent,
        },
      });
    } catch (err) {
      // Una fila mala no puede costarle al espacio las demás escalaciones.
      unreachable += 1;
      logger.warn('actions-sweep: falló una escalación', {
        organizationId,
        actionId: action.id,
        error: (err as Error).message,
      });
    }
  }

  return { escalated, considered: due.length, unreachable, waiting: open.length };
}
