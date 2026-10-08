import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { closeStaleShifts, parseLocationSettings, purgeLocationHistory } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * LA RETENCIÓN DE LA UBICACIÓN DEL EQUIPO (migración 0216).
 *
 * Dónde estuvo una persona no se guarda para siempre: cada app dice cuántos
 * días conserva el rastro (`custom_apps.location.retentionDays`, 30 por
 * defecto) y este trabajo, cada hora, borra lo que pasó ese plazo. "Dejamos de
 * guardarlo" sólo es cierto si los bytes se fueron, no si se esconden al leer.
 *
 * Además cierra los turnos que se quedaron abiertos (el teléfono se apagó, se
 * olvidó terminar) pasadas 16 horas y borra la posición actual de quien ya no
 * está en turno.
 *
 * SIN ALCANCE, Y SÓLO PARA ENUMERAR. «Qué apps tienen ubicación» abarca la
 * instalación; con el handle crudo se leen únicamente (id, organization_id,
 * location) de las apps que la tienen encendida o aún tienen datos. El borrado y
 * el cierre de turnos corren después con el handle de SU empresa.
 */

const SWEEP_CRON = '5 * * * *';

export const appLocationSweepJob: JobHandler = async ({ step }) => {
  const apps = await step.run('find-apps', async () => {
    const raw = getSupabaseServiceClient();
    const { data, error } = await raw
      .from('custom_apps')
      .select('id, organization_id, location')
      .limit(5000);
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; organization_id: string; location: unknown }>;
  });
  return step.run('sweep', async () => {
    let purged = 0;
    let closed = 0;
    const now = new Date();
    for (const app of apps) {
      const settings = parseLocationSettings(app.location);
      try {
        const db = getOrgScopedClient(app.organization_id);
        // Apagada o no, lo viejo se va con la retención que la app tenía.
        purged += await purgeLocationHistory(db, app.id, settings.retentionDays, now);
        if (settings.enabled) closed += await closeStaleShifts(db, app.id, now);
      } catch (err) {
        logger.warn({ err, appId: app.id }, 'app location sweep failed');
      }
    }
    logger.info('app location retention sweep', { purged, closed });
    return { purged, closed };
  });
};

export const appLocationSweep = inngest.createFunction(
  { id: 'app-location-sweep' },
  { cron: SWEEP_CRON },
  async (ctx) => appLocationSweepJob(ctx as unknown as JobContext),
);
