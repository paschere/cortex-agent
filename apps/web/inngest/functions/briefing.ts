import { sendEmail } from '@/lib/email';
import { renderBriefingEmail } from '@/lib/email-templates/briefing';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notificationExists, notify } from '@/lib/notifications/notify';
import { pushToPeople } from '@/lib/notifications/push';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  briefingInputFor,
  buildBriefing,
  isBusinessDay,
  isCompanyManager,
  listWorkPeopleMeta,
  loadBriefingData,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * «TU DÍA»: CORTEX HABLA PRIMERO (0220).
 *
 * Cada día hábil a las 07:00 de Bogotá, a cada persona de la empresa le llega
 * un resumen corto de lo que merece su atención: al dueño y a los
 * administradores, el de la empresa (decisiones del piloto, fuentes que se
 * quedaron mudas, cartera, vencidos); a los demás, sólo lo suyo. Si no hay nada
 * que decir, no se manda nada.
 *
 *   briefing/dispatch   cron 12:00 UTC (= 07:00 Bogotá todo el año: Colombia no
 *                       cambia la hora). Reparte las empresas con agente.
 *   briefing/workspace  una empresa: lee UNA vez, arma el de cada persona
 *                       (packages/agent-tools/src/briefing, reglas puras) y lo
 *                       entrega.
 *
 * Entrega, en este orden:
 *   1. campana (siempre; con botones si el piloto tiene algo aprobable con un
 *      clic). La clave de deduplicación lleva el día: correr esto diez veces
 *      manda un solo resumen, y el correo y el push sólo salen si la campana es
 *      NUEVA.
 *   2. Web Push, si hay llaves VAPID y la persona activó los avisos.
 *   3. correo, SÓLO si el push no le llegó: un resumen por dos canales a la vez
 *      es el ruido que enseña a no abrirlos. El correo lleva un enlace, nunca
 *      una acción.
 *   4. WhatsApp: TODO. No existe hoy un envío de Cortex a una PERSONA del equipo
 *      (sólo a grupos permitidos —whatsapp/group-send— y respuestas a clientes);
 *      cuando exista, con el permiso «Permitir mensajes de Cortex» de la
 *      empresa, se engancha aquí. No se inventa un remitente.
 *
 * Quien tiene el día marcado como fuera (registro de trabajo) no recibe nada.
 */

export const BRIEFING_CRON = '0 12 * * *';

export const briefingDispatchJob: JobHandler = async ({ step }) => {
  const today = bogotaToday();
  if (!isBusinessDay(today)) return { skipped: 'día no hábil', today };
  // Sin alcance, y sólo aquí: «qué empresas tienen un agente» cruza la
  // instalación. Se lee organization_id y nada más; cada id viaja en su propio
  // evento y el trabajo de la empresa arma todos sus handles a partir de él.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const { data, error } = await getSupabaseServiceClient()
      .from('agents')
      .select('organization_id')
      .limit(50_000);
    if (error) throw error;
    return [
      ...new Set(
        ((data ?? []) as Array<{ organization_id: string | null }>)
          .map((r) => r.organization_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
  });
  if (workspaces.length > 0)
    await step.sendEvent(
      'briefing-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'briefing/workspace' as const,
        data: { organizationId, today },
      })),
    );
  return { dispatched: workspaces.length, today };
};

export const briefingDispatch = inngest.createFunction(
  { id: 'briefing-dispatch' },
  { cron: BRIEFING_CRON },
  async (ctx) => briefingDispatchJob(ctx as unknown as JobContext),
);

/** Quién recibe: a lo sumo esta cantidad por empresa y día (techo de seguridad). */
const MAX_PEOPLE = 300;

export const briefingWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };
  const today = (event.data.today as string | undefined) ?? bogotaToday();
  if (!isBusinessDay(today)) return { skipped: 'día no hábil', today };

  return step.run('deliver', async () => {
    const db = getOrgScopedClient(organizationId);
    const now = new Date();
    const data = await loadBriefingData(db, { today, now });
    const meta = await listWorkPeopleMeta(db).catch(() => new Map());
    const tally = { people: 0, sent: 0, email: 0, push: 0, skipped: 0 };

    for (const person of data.people.slice(0, MAX_PEOPLE)) {
      tally.people += 1;
      const away = (meta.get(person.id)?.awayDays ?? []) as string[];
      if (away.includes(today)) {
        tally.skipped += 1;
        continue;
      }
      const manager = await isCompanyManager(db, person.id);
      const briefing = buildBriefing(briefingInputFor(data, person, manager));
      if (!briefing.send) {
        tally.skipped += 1;
        continue;
      }
      const dedupeKey = `briefing:${person.id}:${today}`;
      // ¿Ya se mandó hoy? Entonces ni campana, ni push, ni correo.
      if (await notificationExists(db, person.id, dedupeKey)) {
        tally.skipped += 1;
        continue;
      }
      const href =
        manager && briefing.actions.length ? '/piloto' : manager ? '/overview' : '/commitments';
      const id = await notify(db, {
        userId: person.id,
        kind: 'briefing',
        tone: briefing.tone,
        title: briefing.title,
        body: briefing.body,
        href,
        actions: briefing.actions,
        dedupeKey,
      });
      if (!id) continue;
      tally.sent += 1;

      const pushed = await pushToPeople(db, [person.id], {
        title: briefing.title,
        body: briefing.bullets[0],
        url: '/notifications',
        tag: dedupeKey,
      }).catch((err) => {
        logger.warn({ err, organizationId }, 'briefing: el push no salió');
        return [] as string[];
      });
      if (pushed.length) {
        tally.push += 1;
        continue;
      }
      if (person.email.includes('@')) {
        const mail = renderBriefingEmail({
          title: briefing.title,
          bullets: briefing.bullets,
          href,
          scope: manager ? 'company' : 'person',
        });
        const out = await sendEmail({
          to: person.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        }).catch(() => ({ sent: false }));
        if (out.sent) tally.email += 1;
      }
    }
    if (data.errors.length)
      logger.warn(
        { organizationId, errors: data.errors },
        'briefing: fuentes que no se pudieron leer',
      );
    logger.info({ organizationId, today, ...tally }, 'briefing finished');
    return { organizationId, today, ...tally, sourceErrors: data.errors.length };
  });
};

export const briefingWorkspace = inngest.createFunction(
  { id: 'briefing-workspace', concurrency: { limit: 3 } },
  { event: 'briefing/workspace' },
  async (ctx) => briefingWorkspaceJob(ctx as unknown as JobContext),
);
