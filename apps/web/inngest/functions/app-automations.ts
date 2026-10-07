import { buildAutomationDeps } from '@/lib/apps/automation-deps';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  automationTriggerSchema,
  executeRun,
  queueScheduled,
  scheduleDue,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * LAS AUTOMATIZACIONES DE LAS APPS (migración 0210).
 *
 * Dos trabajos:
 *
 *   apps/automation.dispatch (cada minuto)
 *     1. Horarios: qué reglas `schedule` tocan ahora (franja diaria o semanal en
 *        hora de Bogotá; la franja se reclama con un UPDATE condicionado, así que
 *        dos vueltas del reloj dejan UNA corrida) y las deja en cola.
 *     2. Libera las corridas que quedaron «running» (el proceso murió).
 *     3. Reparte lo que está en cola y ya venció su espera: lo recién emitido
 *        que no pudo despertar al trabajo y los REINTENTOS con espera.
 *
 *   apps/automation.run ({ runId, organizationId })
 *     Ejecuta UNA corrida con el handle de su empresa. Reclamar la corrida es
 *     atómico: si llegan dos veces, corre una.
 *
 * Los eventos de fila NO pasan por el reloj: quien escribe la fila deja la
 * corrida en cola y despierta a `apps/automation.run` de inmediato (menos de un
 * minuto de punta a punta; el barrido es la red de seguridad).
 */

const DISPATCH_CRON = '* * * * *';
const MAX_PER_SWEEP = 200;

export const appAutomationDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí: «qué reglas de horario tocan» y «qué corridas
  // están en cola» abarcan la instalación. Se leen ids y el disparador; cada
  // corrida se ejecuta después con el handle de SU empresa.
  const scheduled = await step.run('schedules', async () => {
    const raw = getSupabaseServiceClient();
    const { data, error } = await raw
      .from('custom_app_automations')
      .select('id, organization_id, app_id, trigger, schedule_last_slot')
      .eq('enabled', true)
      .eq('trigger_kind', 'schedule')
      .limit(2000);
    if (error) throw error;
    const now = new Date();
    let queued = 0;
    for (const a of (data ?? []) as Array<{
      id: string;
      organization_id: string;
      app_id: string;
      trigger: unknown;
      schedule_last_slot: string | null;
    }>) {
      const trigger = automationTriggerSchema.safeParse(a.trigger);
      if (!trigger.success || trigger.data.type !== 'schedule') continue;
      const slot = scheduleDue(
        trigger.data,
        a.schedule_last_slot ? new Date(a.schedule_last_slot) : null,
        now,
      );
      if (!slot) continue;
      const db = getOrgScopedClient(a.organization_id);
      // Se reclama la franja ANTES: gana un solo intento.
      let claim = db
        .from('custom_app_automations')
        .update({ schedule_last_slot: slot.toISOString() })
        .eq('id', a.id);
      claim = a.schedule_last_slot
        ? claim.lt('schedule_last_slot', slot.toISOString())
        : claim.is('schedule_last_slot', null);
      const { data: won, error: claimError } = await claim.select('id');
      if (claimError) throw claimError;
      if (!won?.length) continue;
      queued += await queueScheduled(db, { id: a.id, app_id: a.app_id }, slot);
    }
    return queued;
  });

  const due = await step.run('find-due', async () => {
    const raw = getSupabaseServiceClient();
    const now = new Date();
    // Corridas que quedaron «running» hace más de 10 minutos: de vuelta a la cola.
    await raw
      .from('custom_app_automation_runs')
      .update({ status: 'queued', next_attempt_at: now.toISOString() })
      .eq('status', 'running')
      .lt('started_at', new Date(now.getTime() - 10 * 60_000).toISOString());
    const { data, error } = await raw
      .from('custom_app_automation_runs')
      .select('id, organization_id')
      .eq('status', 'queued')
      .lte('next_attempt_at', now.toISOString())
      .order('next_attempt_at', { ascending: true })
      .limit(MAX_PER_SWEEP);
    if (error) throw error;
    return ((data ?? []) as Array<{ id: string; organization_id: string }>).map((r) => ({
      runId: r.id,
      organizationId: r.organization_id,
    }));
  });
  if (due.length)
    await step.sendEvent(
      'run-each',
      due.map((d) => ({ name: 'apps/automation.run' as const, data: d })),
    );
  return { scheduled, dispatched: due.length };
};

export const appAutomationDispatch = inngest.createFunction(
  { id: 'app-automation-dispatch' },
  { cron: DISPATCH_CRON },
  async (ctx) => appAutomationDispatchJob(ctx as unknown as JobContext),
);

export const appAutomationRunJob: JobHandler = async ({ event, step }) => {
  const d = event.data as { runId?: string; organizationId?: string };
  if (!d.runId || !d.organizationId) return { skipped: 'sin corrida o empresa' };
  const { runId, organizationId } = d;
  return step.run('execute', async () => {
    const db = getOrgScopedClient(organizationId);
    try {
      return await executeRun(db, runId, organizationId, buildAutomationDeps());
    } catch (err) {
      // Un fallo del propio motor (no de una acción): la corrida vuelve a la
      // cola con una espera corta y el barrido la retoma.
      logger.error({ err, runId, organizationId }, 'app automation run crashed');
      await db
        .from('custom_app_automation_runs')
        .update({
          status: 'queued',
          next_attempt_at: new Date(Date.now() + 2 * 60_000).toISOString(),
          error: err instanceof Error ? err.message.slice(0, 300) : 'error del motor',
        })
        .eq('id', runId)
        .eq('status', 'running');
      throw err;
    }
  });
};

export const appAutomationRun = inngest.createFunction(
  { id: 'app-automation-run', concurrency: { limit: 5 } },
  { event: 'apps/automation.run' },
  async (ctx) => appAutomationRunJob(ctx as unknown as JobContext),
);
