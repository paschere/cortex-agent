import { sendEmail } from '@/lib/email';
import { renderManagementFollowUpEmail } from '@/lib/email-templates/management-follow-up';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  FOLLOW_UP_STATES,
  type FollowUpStep,
  type PlannedFollowUp,
  bogotaToday,
  claimFollowUpNotice,
  followUpKey,
  followUpReasonText,
  getManagementCase,
  isBusinessDay,
  listDirectory,
  listFollowUpCases,
  listFollowUpNotices,
  personLabel,
  planFollowUps,
  readFollowUpProfile,
  releaseFollowUpNotice,
  settleFollowUpNotice,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * El vigilante de Gerencia: el que persigue a la gente hasta que las cosas se
 * cierran.
 *
 * Qué decide y por qué está en packages/agent-tools/src/management/follow-up.ts
 * (reglas puras, con pruebas); el libro que impide repetir está en la 0158. Aquí
 * sólo se orquesta, con la misma forma que commitments-watch y goals-watch:
 * un cron reparte por empresa, y cada empresa corre en su propio trabajo para
 * que un fallo quede contenido y se reintente sólo esa empresa.
 *
 * ===========================================================================
 * LO QUE HACE, Y NADA MÁS
 * ===========================================================================
 *   1. Avisa al responsable (bandeja de la app + correo).
 *   2. Tras dos días hábiles sin una revisión nueva, avisa a quien está encima
 *      y le cuenta al responsable, en la app, que se escaló.
 *   3. Un asunto sin responsable, una vez, a los administradores.
 *
 * No cambia el asunto, no lo reasigna, no ejecuta nada. Todos los destinatarios
 * salen del directorio de la empresa leído con su handle; nunca de un texto del
 * asunto, nunca alguien de fuera.
 *
 * ===========================================================================
 * IDEMPOTENCIA
 * ===========================================================================
 * Reclamar primero, mandar después (0069). El aviso en la app lleva además una
 * `dedupe_key` estable (0132), así que un reintento no duplica la campana
 * aunque la reclamación se reintente. Antes de reclamar se relee el asunto: si
 * alguien lo guardó entre el plan y el envío, su revisión ya no es la del plan
 * y el aviso no sale — respondió, que es justo lo que se le iba a pedir.
 *
 * EL INTERRUPTOR es `management_profiles.data.followUp`, encendido si falta.
 * Lo apaga un administrador en Gerencia → Configuración.
 */

/**
 * 07:15 en Bogotá, de lunes a viernes. Después de compromisos (06:00), metas
 * (06:30) y cartera (07:00), para que el correo de Gerencia no llegue en el
 * mismo minuto que los urgentes. Colombia no cambia la hora: 12:15 UTC son las
 * 07:15 todo el año. Los festivos se saltan en el código (`isBusinessDay`), no
 * en el cron.
 */
export const FOLLOW_UP_CRON = '15 12 * * 1-5';

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const managementFollowUpDispatchJob: JobHandler = async ({ step }) => {
  const today = bogotaToday();
  if (!isBusinessDay(today)) return { skipped: 'día no hábil', today };

  // Sin alcance, y sólo aquí: «qué empresas tienen asuntos vivos» cruza la
  // instalación. Cada id viaja en su propio evento y el trabajo de abajo arma
  // todos sus handles a partir de él.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const { data, error } = await getSupabaseServiceClient()
      .from('management_cases')
      .select('organization_id')
      .in('data->>state', [...FOLLOW_UP_STATES])
      .limit(50_000);
    if (error) throw error;
    const seen = new Set<string>();
    for (const row of (data ?? []) as Array<{ organization_id: string | null }>) {
      if (row.organization_id) seen.add(row.organization_id);
    }
    return [...seen];
  });

  if (workspaces.length > 0) {
    await step.sendEvent(
      'follow-up-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'management/follow-up.workspace' as const,
        data: { organizationId, today },
      })),
    );
  }
  return { dispatched: workspaces.length, today };
};

export const managementFollowUpDispatch = inngest.createFunction(
  { id: 'management-follow-up-dispatch' },
  { cron: FOLLOW_UP_CRON },
  async (ctx) => managementFollowUpDispatchJob(ctx as unknown as JobContext),
);

// ---------------------------------------------------------------------------
// Una empresa
// ---------------------------------------------------------------------------

interface Person {
  email: string;
  label: string;
}

export const managementFollowUpWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };
  // El día viaja en el evento: si el trabajo corre pasada la medianoche, sigue
  // decidiendo por el día en que se repartió.
  const today = (event.data.today as string | undefined) ?? bogotaToday();
  if (!isBusinessDay(today)) return { skipped: 'día no hábil', today };

  const planned = await step.run('plan', async () => {
    const db = getOrgScopedClient(organizationId);
    const profile = await readFollowUpProfile(db);
    if (!profile.enabled) return { enabled: false as const, plan: [] as PlannedFollowUp[] };
    const cases = await listFollowUpCases(db);
    if (cases.length === 0) return { enabled: true as const, plan: [] as PlannedFollowUp[] };
    const [notices, people] = await Promise.all([
      listFollowUpNotices(
        db,
        cases.map((c) => c.id),
      ),
      listDirectory(db),
    ]);
    const plan = planFollowUps({
      cases,
      notices,
      people: people.map((p) => ({ id: p.id, role: p.role, managerId: p.manager_id })),
      escalationOwnerId: profile.escalationOwnerId,
      today,
    });
    return { enabled: true as const, plan };
  });
  if (!planned.enabled) return { organizationId, today, skipped: 'seguimiento apagado' };

  const sent = await step.run('send', async () => {
    const db = getOrgScopedClient(organizationId);
    const directory = new Map<string, Person>(
      (await listDirectory(db)).map((p) => [p.id, { email: p.email, label: personLabel(p) }]),
    );
    let delivered = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of planned.plan) {
      // Releer ANTES de reclamar: si alguien guardó el asunto después del plan,
      // ya respondió y este aviso sobra.
      const current = await getManagementCase(db, item.caseId).catch(() => null);
      if (
        !current ||
        current.revision !== item.caseRevision ||
        !(FOLLOW_UP_STATES as readonly string[]).includes(current.data.state)
      ) {
        skipped += 1;
        continue;
      }
      const recipients = item.recipients.filter((id) => directory.has(id));
      const cc = item.cc.filter((id) => directory.has(id) && !recipients.includes(id));
      if (recipients.length === 0) {
        skipped += 1;
        continue;
      }

      const claim = await claimFollowUpNotice(db, {
        caseId: item.caseId,
        caseRevision: item.caseRevision,
        step: item.step,
        reasons: item.reasons,
        sentOn: today,
        recipientUserIds: recipients,
        via: item.via,
      });
      if (claim.outcome === 'taken') {
        skipped += 1;
        continue;
      }

      const data = current.data;
      const reasons = item.reasons.map((r) => followUpReasonText(r, data, item.touchedOn));
      const ownerName = data.ownerId ? (directory.get(data.ownerId)?.label ?? null) : null;
      const href = `/management?case=${encodeURIComponent(item.caseId)}`;
      const key = followUpKey(item.caseId, item.caseRevision, item.step);
      const copy = inAppCopy(item.step, data.title, ownerName);

      // La app primero: es la que no depende de un proveedor de correo.
      let inApp = 0;
      for (const userId of recipients) {
        const id = await notify(db, {
          userId,
          kind: 'management_attention',
          title: copy.title,
          body: `${reasons.join(' ')} Próximo paso: ${data.nextAction}`,
          href,
          dedupeKey: key,
        });
        if (id) inApp += 1;
      }
      if (item.step === 'escalation') {
        const target = recipients[0] ? (directory.get(recipients[0])?.label ?? null) : null;
        for (const userId of cc) {
          await notify(db, {
            userId,
            kind: 'management_attention',
            title: `Se escaló «${data.title}»`,
            body: `Pasaron dos días hábiles sin avances desde el aviso${target ? `; se le avisó a ${target}` : ''}. Registra el avance para cerrar el escalado.`,
            href,
            dedupeKey: `${key}:cc`,
          });
        }
      }

      const mail = renderManagementFollowUpEmail({
        step: item.step,
        caseId: item.caseId,
        title: data.title,
        nextAction: data.nextAction,
        blocker: data.blocker,
        dueOn: data.dueOn,
        nextReviewOn: data.nextReviewOn,
        reasons,
        ownerName,
        firstNoticeOn: item.firstNoticeOn,
      });
      const emails = recipients
        .map((id) => directory.get(id)?.email ?? '')
        .filter((e) => e.includes('@'));
      // Un correo por persona: nadie ve la dirección de otro en el «Para».
      let mailed = 0;
      let mailNote: string | null = null;
      for (const to of emails) {
        const outcome = await sendEmail({
          to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        if (outcome.sent) mailed += 1;
        else mailNote = outcome.reason ?? 'No se pudo enviar el correo.';
      }

      const ok = inApp > 0 || mailed > 0;
      if (!ok && claim.outcome === 'claimed') {
        // Nada llegó por ningún canal: se suelta para que mañana sea un intento
        // de verdad y no una fila que bloquea el aviso para siempre.
        await releaseFollowUpNotice(db, claim.id);
        failed += 1;
        continue;
      }
      await settleFollowUpNotice(db, {
        id: claim.id,
        delivered: ok,
        note: ok ? mailNote && `Correo: ${mailNote}` : (mailNote ?? 'Sin entrega.'),
        sentOn: today,
      });
      if (ok) delivered += 1;
      else failed += 1;
    }
    return { planned: planned.plan.length, delivered, skipped, failed };
  });

  logger.info({ organizationId, today, sent }, 'management follow-up finished');
  return { organizationId, today, notices: sent };
};

export const managementFollowUpWorkspace = inngest.createFunction(
  { id: 'management-follow-up-workspace', concurrency: { limit: 5 } },
  { event: 'management/follow-up.workspace' },
  async (ctx) => managementFollowUpWorkspaceJob(ctx as unknown as JobContext),
);

function inAppCopy(step: FollowUpStep, title: string, ownerName: string | null) {
  switch (step) {
    case 'owner':
      return { title: `Te toca mover «${title}»` };
    case 'escalation':
      return {
        title: `Escalado: «${title}» sigue sin avance${ownerName ? ` (${ownerName})` : ''}`,
      };
    case 'unowned':
      return { title: `«${title}» no tiene responsable` };
  }
}
