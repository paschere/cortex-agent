import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import { DRIVE_READONLY_SCOPE } from './drive-excel';
import { FeedCaptureError, captureGoogleSheetFeed } from './feed-capture';
import { describeSheetReadError } from './read-errors';
import { reportMarkdown } from './sheet-spec-sync';
import {
  SYNC_COLUMNS,
  type SyncOutcome,
  type TrackerSyncRow,
  applyTrackerSync,
  latestSheetForSync,
  markSyncRun,
  saveSyncReport,
} from './sync';

/**
 * ENSAYAR Y CORRER A MANO UNA SINCRONIZACIÓN CON RECETA (0248).
 *
 * La puesta al día de una hoja que el equipo sigue editando es la PRIMERA
 * corrida de la misma sincronización que después corre a diario: primero se
 * ENSAYA (lee la hoja de Drive, planea y cuenta —nuevas, cambiadas, conflictos,
 * lo que ya no está— sin escribir nada), y sólo después se corre de verdad y se
 * enciende el ritmo diario. Dos herramientas porque la segunda escribe y pide
 * confirmación; la primera sólo lee.
 */

const SCOPES: Array<{ provider: 'google'; scopes: string[] }> = [
  {
    provider: 'google',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', DRIVE_READONLY_SCOPE],
  },
];

const inputSchema = z.object({
  sync: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('Id de la sincronización (trackers.syncs) o el slug de la tabla que llena (p. ej. "prefacturacion").'),
});

async function findSync(db: SupabaseClient, ref: string): Promise<TrackerSyncRow> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  let id = ref;
  if (!byId) {
    const { data: t, error } = await db.from('trackers').select('id').eq('slug', ref).maybeSingle();
    if (error) throw error;
    if (!t) throw new NotFoundError(`No hay una tabla «${ref}».`);
    const { data: s, error: sErr } = await db
      .from('tracker_syncs')
      .select('id')
      .eq('tracker_id', (t as { id: string }).id)
      .not('spec', 'is', null)
      .limit(2);
    if (sErr) throw sErr;
    const rows = (s ?? []) as Array<{ id: string }>;
    if (rows.length !== 1)
      throw new ValidationError(
        rows.length
          ? 'Esa tabla tiene varias sincronizaciones con receta: pásame el id (trackers.syncs).'
          : `La tabla «${ref}» no tiene una sincronización con receta. La configura el administrador con el script de cortex-ops.`,
      );
    id = rows[0]?.id as string;
  }
  const { data, error } = await db
    .from('tracker_syncs')
    .select(`${SYNC_COLUMNS}, last_report`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Esa sincronización no existe.');
  return data as unknown as TrackerSyncRow;
}

/** Vuelve a leer la fuente (Drive/Hojas) y devuelve la pestaña de la receta. */
async function freshSheet(ctx: ToolContext, sync: TrackerSyncRow) {
  if (!sync.spec) throw new ValidationError('Esta sincronización no tiene receta: no se puede ensayar.');
  if (sync.created_by !== ctx.userId)
    throw new ValidationError(
      'Sólo la persona que creó la sincronización (dueña de la fuente en el Feed) puede ensayarla o correrla a mano.',
    );
  const { data: src, error } = await ctx.db
    .from('feed_sources')
    .select('id, kind, enabled, config')
    .eq('id', sync.source_id)
    .eq('actor_id', ctx.userId)
    .maybeSingle();
  if (error) throw error;
  const source = src as { kind: string; enabled: boolean; config: { spreadsheetId?: string; tabs?: string[] } } | null;
  if (!source?.enabled) throw new ValidationError('La fuente de esta sincronización está desactivada o ya no existe.');
  if (source.kind !== 'google_sheet' || !source.config.spreadsheetId)
    throw new ValidationError('Por ahora el ensayo manual sólo lee fuentes de Google (hoja o Excel en Drive).');
  try {
    await captureGoogleSheetFeed({
      db: ctx.db,
      ctx,
      actorId: ctx.userId,
      spreadsheetId: source.config.spreadsheetId,
      tabs: source.config.tabs,
    });
  } catch (err) {
    if (err instanceof FeedCaptureError) throw new ValidationError(err.message);
    throw await describeSheetReadError(ctx, err);
  }
  const found = await latestSheetForSync(ctx.db, sync);
  if (!found) throw new ValidationError('La fuente no trajo la pestaña de la receta.');
  return found;
}

const outputSchema = z.object({ markdown: z.string(), dryRun: z.boolean(), report: z.unknown() });

export const trackersSyncDryRun = registerTool({
  id: 'trackers.sync_dry_run',
  description:
    'ENSAYO de una sincronización con receta (p. ej. la hoja «GUIAS BBIC FACTURACION 2026» → Prefacturación): vuelve a leer la hoja o el Excel de Drive, compara con la tabla y cuenta cuántas filas serían nuevas, cuántas cambiarían, los conflictos (filas editadas en la app que la hoja sobrescribiría) y las que ya no están en la hoja. NO escribe nada en las tablas (sólo guarda el informe). Úsalo SIEMPRE antes de trackers.sync_run_now. Muestra los conteos y pregunta si aplicar. Si falla por la conexión de Google, di exactamente qué reconectar (Datos y conexiones → Google, con permiso de Drive).',
  inputSchema,
  outputSchema,
  requiredScopes: SCOPES,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    const sync = await findSync(ctx.db, input.sync);
    const found = await freshSheet(ctx, sync);
    const outcome: SyncOutcome = await applyTrackerSync(ctx.db, sync, found.sheet, { dryRun: true });
    if (outcome.report) await saveSyncReport(ctx.db, sync.id, outcome.report);
    return {
      dryRun: true,
      report: outcome.report,
      markdown: outcome.report ? reportMarkdown(outcome.report) : 'Sin informe.',
    };
  },
});

export const trackersSyncRunNow = registerTool({
  id: 'trackers.sync_run_now',
  description:
    'Corre DE VERDAD una sincronización con receta (la puesta al día): agrega las filas nuevas, actualiza las cambiadas (la hoja gana) y NO borra nada; las filas creadas en la app no se tocan. Exige un ensayo previo (trackers.sync_dry_run) y, al terminar bien, enciende la sincronización diaria. Pide confirmación: escribe en las tablas del equipo.',
  inputSchema: inputSchema.extend({
    enableDaily: z
      .boolean()
      .default(true)
      .describe('Dejar la sincronización encendida (cada día) cuando termine bien.'),
  }),
  outputSchema,
  requiresConfirmation: true,
  requiredScopes: SCOPES,
  rateLimit: { perMinute: 2 },
  handler: async (input, ctx) => {
    const sync = await findSync(ctx.db, input.sync);
    if (!sync.last_report)
      throw new ValidationError('Primero ensaya con trackers.sync_dry_run y muéstrale a la persona los conteos.');
    const found = await freshSheet(ctx, sync);
    try {
      const outcome = await applyTrackerSync(ctx.db, sync, found.sheet);
      await markSyncRun(ctx.db, sync, { ok: true, outcome });
      if (input.enableDaily)
        await ctx.db.from('tracker_syncs').update({ enabled: true }).eq('id', sync.id);
      return {
        dryRun: false,
        report: outcome.report,
        markdown: `${outcome.report ? reportMarkdown(outcome.report) : ''}\n${input.enableDaily ? 'La sincronización quedó encendida: corre cada día.' : 'La sincronización queda como estaba (apagada).'}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo sincronizar.';
      await markSyncRun(ctx.db, sync, { ok: false, error: message });
      throw err;
    }
  },
});
