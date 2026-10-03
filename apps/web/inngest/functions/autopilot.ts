import { autopilotRunDeps } from '@/lib/autopilot/server';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { bogotaHour, bogotaToday, isModuleEnabled, runAutopilot } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * EL PILOTO AUTOMÁTICO, CADA MAÑANA (0176).
 *
 * Qué decide y por qué está en packages/agent-tools/src/autopilot (reglas puras
 * con pruebas); aquí sólo se reparte y se enchufa (lib/autopilot/server.ts).
 * Misma forma que el seguimiento de Gerencia: un cron reparte por empresa y
 * cada empresa corre en su propio trabajo, así un fallo queda contenido.
 *
 *   autopilot/dispatch   cada hora en punto y cinco. Elige las empresas con el
 *                        piloto encendido cuya hora local (Bogotá) es ésta. Los
 *                        días, festivos y días quietos los decide la corrida
 *                        (`runGate`), no el cron.
 *   autopilot/workspace  la corrida de una empresa (`runAutopilot`): una por
 *                        día, idempotente, con el interruptor releído antes de
 *                        cada acción.
 *   autopilot/remind     el recordatorio de `autopilot.remind`: la campana de
 *                        un compañero.
 */

export const AUTOPILOT_CRON = '5 * * * *';

export const autopilotDispatchJob: JobHandler = async ({ step }) => {
  const now = new Date();
  const hour = bogotaHour(now);
  const today = bogotaToday(now);
  // Sin alcance, y sólo aquí: «qué empresas tienen el piloto encendido a esta
  // hora» cruza la instalación. Se lee organization_id y nada más; cada id viaja
  // en su propio evento y la corrida arma todos sus handles a partir de él.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const { data, error } = await getSupabaseServiceClient()
      .from('autopilot_settings')
      .select('organization_id')
      .eq('enabled', true)
      .eq('run_hour', hour)
      .limit(5000);
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
      'autopilot-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'autopilot/workspace' as const,
        data: { organizationId, day: today },
      })),
    );
  return { dispatched: workspaces.length, hour, today };
};

export const autopilotDispatch = inngest.createFunction(
  { id: 'autopilot-dispatch' },
  { cron: AUTOPILOT_CRON },
  async (ctx) => autopilotDispatchJob(ctx as unknown as JobContext),
);

export const autopilotWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };
  // El día viaja en el evento: si la corrida cruza la medianoche, sigue
  // decidiendo por el día en que se repartió.
  const day = (event.data.day as string | undefined) ?? bogotaToday();
  return step.run('run', async () => {
    // Con el módulo apagado (0186) el piloto no corre, aunque su configuración
    // siga encendida: apagar el módulo no le borra los ajustes a nadie.
    if (!(await isModuleEnabled(getOrgScopedClient(organizationId), 'autopilot')))
      return { organizationId, day, skipped: 'módulo del piloto apagado' };
    const deps = await autopilotRunDeps(organizationId, day);
    if (!deps) return { organizationId, day, skipped: 'este espacio no tiene agente' };
    const result = await runAutopilot(deps);
    if (!result.ran) return { organizationId, day, skipped: result.reason };
    logger.info({ organizationId, day, summary: result.summary.message }, 'autopilot run finished');
    return {
      organizationId,
      day,
      done: result.summary.done,
      asked: result.summary.asked,
      failed: result.summary.failed,
      skipped: result.summary.skipped,
    };
  });
};

export const autopilotWorkspace = inngest.createFunction(
  { id: 'autopilot-workspace', concurrency: { limit: 3 } },
  { event: 'autopilot/workspace' },
  async (ctx) => autopilotWorkspaceJob(ctx as unknown as JobContext),
);

export const autopilotRemindJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  const userId = event.data.userId as string | undefined;
  const title = event.data.title as string | undefined;
  if (!organizationId || !userId || !title) return { skipped: 'incomplete event' };
  return step.run('notify', async () => {
    const db = getOrgScopedClient(organizationId);
    const id = await notify(db, {
      userId,
      kind: 'management_attention',
      tone: 'info',
      title,
      body: (event.data.body as string | null | undefined) ?? null,
      href: (event.data.href as string | null | undefined) ?? null,
      dedupeKey: (event.data.dedupeKey as string | undefined) ?? undefined,
    });
    return { organizationId, notified: Boolean(id) };
  });
};

export const autopilotRemind = inngest.createFunction(
  { id: 'autopilot-remind', concurrency: { limit: 5 } },
  { event: 'autopilot/remind' },
  async (ctx) => autopilotRemindJob(ctx as unknown as JobContext),
);
