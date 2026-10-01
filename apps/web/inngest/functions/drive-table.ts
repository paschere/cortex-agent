import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type DriveAccess,
  type FileResult,
  claimDriveFolderSync,
  createIntegrationsClient,
  markDriveFolderRun,
  noticeFor,
  prepareDriveFolderRun,
  processDriveFile,
  totalsOf,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * CARPETAS DE DRIVE QUE LLENAN TABLAS (migración 0162).
 *
 * Cada 10 minutos —el mismo pulso que drive-sync—: qué carpetas tocan
 * (`next_run_at` vencido). Cada una corre en su propio evento y en su espacio,
 * con las credenciales de Google de quien la conectó:
 *
 *   claim → lista la carpeta → un `step.run` por archivo → anota → campana.
 *
 * Un paso por archivo para que un documento que tarda o falla no obligue a
 * leer (y pagar) otra vez los que ya salieron bien. Diez archivos por corrida
 * como mucho; una carpeta con atraso se pone al día en las siguientes.
 *
 * La campana suena para quien la creó cuando entra o cambia algo, o cuando un
 * archivo no se pudo leer: «Facturas: 3 filas nuevas — FE-4471, … 1 por
 * revisar.» Reutiliza la clase de aviso `table_sync` (0161).
 *
 * La misma toma (`claimDriveFolderSync`) sirve para el cron y para la primera
 * lectura que encola la herramienta: si llegan las dos, sólo una corre.
 */

const DISPATCH_CRON = '*/10 * * * *';
const TIME_BUDGET_MS = 9 * 60_000;

export const driveTableDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí: «qué carpetas tocan» abarca la instalación. Cada
  // una viaja en su evento con su espacio.
  const due = await step.run('find-due', async () => {
    const { data, error } = await getSupabaseServiceClient()
      .from('drive_folder_syncs')
      .select('id, organization_id')
      .eq('enabled', true)
      .lte('next_run_at', new Date().toISOString())
      .limit(200);
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; organization_id: string }>;
  });
  if (due.length)
    await step.sendEvent(
      'run-each',
      due.map((s) => ({
        name: 'drive-table/run' as const,
        data: { organizationId: s.organization_id, syncId: s.id },
      })),
    );
  return { dispatched: due.length };
};

export const driveTableDispatch = inngest.createFunction(
  { id: 'drive-table-dispatch' },
  { cron: DISPATCH_CRON },
  async (ctx) => driveTableDispatchJob(ctx as unknown as JobContext),
);

export const driveTableRunJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  const syncId = event.data.syncId as string | undefined;
  if (!organizationId || !syncId) return { skipped: 'faltan datos en el evento' };

  const db = getOrgScopedClient(organizationId);
  const sync = await step.run('claim', () => claimDriveFolderSync(db, syncId));
  if (!sync) return { skipped: 'no tocaba, o la tomó otra corrida' };
  const drive: DriveAccess = {
    integrations: createIntegrationsClient(db, sync.created_by, logger),
    signal: undefined,
  };

  const prepared = await step.run('list-folder', async () => {
    try {
      return { ok: true as const, run: await prepareDriveFolderRun(db, drive, sync) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo leer la carpeta.';
      await markDriveFolderRun(db, sync.id, { ok: false, error: message });
      return { ok: false as const, error: message };
    }
  });
  if (!prepared.ok) {
    logger.warn({ syncId, error: prepared.error }, 'drive table: folder listing failed');
    return { error: prepared.error };
  }
  const { tracker, files, ledger, backlog } = prepared.run;

  // El puente de pg-boss corre con un techo de 800 s. Pasado este margen no se
  // empieza otro archivo: los que falten siguen vencidos y entran en la
  // siguiente corrida (no están en el libro).
  const started = Date.now();
  const results: FileResult[] = [];
  for (const file of files) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const result = await step.run(`file-${file.id}`, () =>
      processDriveFile(db, drive, {
        sync,
        tracker,
        file,
        ledger: ledger.find((l) => l.file_id === file.id),
      }),
    );
    results.push(result);
  }

  const totals = totalsOf(results);
  await step.run('finish', async () => {
    await markDriveFolderRun(db, sync.id, { ok: true, totals });
    const notice = sync.notify ? noticeFor(tracker.name, totals) : null;
    if (notice)
      await notify(getOrgScopedClient(organizationId), {
        userId: sync.created_by,
        kind: 'table_sync',
        title: notice.title,
        body: notice.body,
        href: `/trackers/${tracker.slug}`,
      }).catch((err) => logger.warn({ err, organizationId }, 'drive table notice failed'));
  });
  return {
    files: totals.files,
    inserted: totals.inserted,
    updated: totals.updated,
    needsReview: totals.needsReview,
    failed: totals.failed,
    backlog,
  };
};

export const driveTableRun = inngest.createFunction(
  {
    id: 'drive-table-run',
    // Una corrida por carpeta a la vez; la toma ya lo garantiza, esto evita
    // que Inngest despierte dos para nada.
    concurrency: [{ key: 'event.data.syncId', limit: 1 }],
  },
  { event: 'drive-table/run' },
  async (ctx) => driveTableRunJob(ctx as unknown as JobContext),
);
