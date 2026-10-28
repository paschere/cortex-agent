import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { syncTrm } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * La TRM oficial al día (migración 0241): trae de datos.gov.co las vigencias
 * nuevas —y el histórico completo la primera vez— y las guarda en
 * `platform_trm_rates`. Idempotente (upsert por `vigencia_desde`). Dato público
 * de la plataforma: sin empresa. 14:30 UTC = 9:30 en Bogotá; la
 * Superfinanciera publica la del día siguiente a media tarde, así que una
 * segunda pasada a las 22:30 UTC la recoge el mismo día.
 */
export const TRM_SYNC_CRON = '30 14,22 * * *';

export const trmSyncJob: JobHandler = async ({ step }) =>
  step.run('sync', async () => {
    const res = await syncTrm(getSupabaseServiceClient());
    logger.info('trm sync', res);
    return res;
  });

export const trmSync = inngest.createFunction(
  { id: 'trm-sync' },
  [{ event: 'trm/sync' }, { cron: TRM_SYNC_CRON }],
  async (ctx) => trmSyncJob(ctx as unknown as JobContext),
);
