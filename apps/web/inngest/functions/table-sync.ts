import { refreshFeedSource } from '@/lib/feed/api-source';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  SYNC_COLUMNS,
  type SyncOutcome,
  type TrackerSyncRow,
  applyTrackerSync,
  createTrackerSync,
  latestSourceSheet,
  markSyncRun,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * TABLAS QUE SE LLENAN SOLAS (migración 0161).
 *
 * Cada 5 minutos: qué sincronizaciones tocan (`next_run_at` vencido). Cada una
 * corre en su propio evento y en su espacio: vuelve a leer la fuente con la
 * identidad de quien la creó (la API, la hoja), aplica la captura a la tabla
 * y, si entró o cambió algo, suena la campana de esa persona. Una fuente que
 * falla deja la sincronización en error con el motivo —visible en
 * `trackers.syncs`— y vuelve a intentar en el siguiente intervalo.
 *
 * `table-sync/setup` es la primera carga cuando hubo que cambiar cómo se lee
 * una API (la lista dentro de «data», columnas sin nombre): refresca con la
 * forma nueva, crea la tabla y avisa.
 */

const DISPATCH_CRON = '*/5 * * * *';

export const tableSyncDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí: «qué sincronizaciones tocan» abarca la
  // instalación. Cada una viaja en su evento con su espacio.
  const due = await step.run('find-due', async () => {
    const { data, error } = await getSupabaseServiceClient()
      .from('tracker_syncs')
      .select('id, organization_id')
      .eq('enabled', true)
      .lte('next_run_at', new Date().toISOString())
      .limit(500);
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; organization_id: string }>;
  });
  if (due.length)
    await step.sendEvent(
      'sync-each',
      due.map((s) => ({
        name: 'table-sync/run' as const,
        data: { organizationId: s.organization_id, syncId: s.id },
      })),
    );
  return { dispatched: due.length };
};

export const tableSyncDispatch = inngest.createFunction(
  { id: 'table-sync-dispatch' },
  { cron: DISPATCH_CRON },
  async (ctx) => tableSyncDispatchJob(ctx as unknown as JobContext),
);

async function ring(
  organizationId: string,
  userId: string,
  title: string,
  body: string,
  href: string,
  dedupeKey?: string,
) {
  await notify(getOrgScopedClient(organizationId), {
    userId,
    kind: 'table_sync',
    title,
    body,
    href,
    ...(dedupeKey ? { dedupeKey } : {}),
  }).catch((err) => logger.warn({ err, organizationId }, 'table sync notice failed'));
}

function summary(outcome: SyncOutcome): string {
  const parts = [
    outcome.inserted ? `${outcome.inserted} nuevas` : '',
    outcome.updated ? `${outcome.updated} cambiaron` : '',
  ].filter(Boolean);
  const sample = [...outcome.newLabels, ...outcome.changedLabels].slice(0, 3).join(', ');
  return `${parts.join(', ')}${sample ? `: ${sample}` : ''}.`;
}

export const tableSyncRunJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  const syncId = event.data.syncId as string | undefined;
  if (!organizationId || !syncId) return { skipped: 'faltan datos en el evento' };

  return step.run('sync', async () => {
    const db = getOrgScopedClient(organizationId);
    const { data, error } = await db
      .from('tracker_syncs')
      .select(SYNC_COLUMNS)
      .eq('id', syncId)
      .maybeSingle();
    if (error) throw error;
    const sync = data as unknown as TrackerSyncRow | null;
    if (!sync?.enabled) return { skipped: 'desactivada' };
    try {
      await refreshFeedSource(db, sync.created_by, sync.source_id, organizationId).catch((err) => {
        // Una API que no respondió esta vez no borra la última captura buena:
        // se sincroniza con lo que hay y el error queda anotado.
        logger.warn({ err, syncId }, 'source refresh failed; using latest capture');
      });
      const found = await latestSourceSheet(db, sync.source_id, sync.created_by, sync.sheet_index);
      if (!found) throw new Error('La fuente no tiene una captura vigente con esa hoja.');
      const outcome = await applyTrackerSync(db, sync, found.sheet);
      await markSyncRun(db, sync, { ok: true, outcome });
      if (sync.notify && (outcome.inserted || outcome.updated)) {
        const { data: t } = await db
          .from('trackers')
          .select('name, slug')
          .eq('id', sync.tracker_id)
          .maybeSingle();
        const tracker = t as { name: string; slug: string } | null;
        await ring(
          organizationId,
          sync.created_by,
          `${tracker?.name ?? 'Tabla'}: ${outcome.inserted ? `${outcome.inserted} ${outcome.inserted === 1 ? 'fila nueva' : 'filas nuevas'}` : `${outcome.updated} ${outcome.updated === 1 ? 'fila cambió' : 'filas cambiaron'}`}`,
          summary(outcome),
          tracker ? `/trackers/${tracker.slug}` : '/trackers',
        );
      }
      return { inserted: outcome.inserted, updated: outcome.updated };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo sincronizar.';
      await markSyncRun(db, sync, { ok: false, error: message });
      return { error: message };
    }
  });
};

export const tableSyncRun = inngest.createFunction(
  { id: 'table-sync-run' },
  { event: 'table-sync/run' },
  async (ctx) => tableSyncRunJob(ctx as unknown as JobContext),
);

export const tableSyncSetupJob: JobHandler = async ({ event, step }) => {
  const d = event.data as {
    organizationId?: string;
    sourceId: string;
    sheetIndex: number;
    actorId: string;
    tracker: { slug: string; name: string };
    keyColumns: string[];
    intervalMinutes: number;
    notify: boolean;
  };
  if (!d.organizationId) return { skipped: 'sin espacio' };
  const organizationId = d.organizationId;
  return step.run('setup', async () => {
    const db = getOrgScopedClient(organizationId);
    try {
      await refreshFeedSource(db, d.actorId, d.sourceId, organizationId);
      const { tracker, outcome } = await createTrackerSync(db, {
        sourceId: d.sourceId,
        sheetIndex: d.sheetIndex,
        actorId: d.actorId,
        tracker: d.tracker,
        keyColumns: d.keyColumns,
        intervalMinutes: d.intervalMinutes,
        notify: d.notify,
      });
      await ring(
        organizationId,
        d.actorId,
        `La tabla ${tracker.name} ya se llena sola`,
        `Primera carga: ${outcome.inserted} filas. Se actualiza cada ${d.intervalMinutes} minutos.`,
        `/trackers/${tracker.slug}`,
      );
      return { inserted: outcome.inserted };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo preparar la sincronización.';
      await ring(
        organizationId,
        d.actorId,
        'No pude llenar la tabla desde la fuente',
        message,
        '/feed',
      );
      return { error: message };
    }
  });
};

export const tableSyncSetup = inngest.createFunction(
  { id: 'table-sync-setup' },
  { event: 'table-sync/setup' },
  async (ctx) => tableSyncSetupJob(ctx as unknown as JobContext),
);
