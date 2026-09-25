import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { registerTool } from '../index';
import { trackerSlugSchema } from '../trackers/schema';
import { createTrackerSync, latestSourceSheet, listTrackerSyncs } from './sync';

/**
 * Llenar una tabla de la empresa desde una fuente conectada (migración 0161).
 *
 * «Conecté la API de vuelos / la hoja de llegadas: haz una tabla que se llene
 * sola cada 5 minutos, con vuelo y fecha como clave, y que avise cuando entre
 * uno.» Pide confirmación: copia filas del Feed PRIVADO de la persona a una
 * tabla que ve todo el equipo, y deja un trabajo que corre solo.
 *
 * Si la API responde con la lista dentro de un campo («data», «arrivals») o
 * como listas sin nombres (OpenSky), `recordsPath` y `columns` le dicen a la
 * fuente cómo leerla; en ese caso la primera carga espera al trabajo
 * programado, que vuelve a consultar la API con la forma nueva.
 */

async function resolveSource(db: SupabaseClient, actorId: string, ref: string) {
  const q = db
    .from('feed_sources')
    .select('id, name, kind, config, enabled')
    .eq('actor_id', actorId);
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const { data, error } = await (byId
    ? q.eq('id', ref)
    : q.ilike('name', `%${ref.replace(/[%_]/g, '')}%`)
  ).limit(5);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    kind: string;
    config: Record<string, unknown>;
    enabled: boolean;
  }>;
  if (!rows.length)
    throw new NotFoundError(
      `No encontré una fuente conectada tuya llamada «${ref}». Conéctala primero en el Feed.`,
    );
  if (rows.length > 1 && !byId)
    throw new ValidationError(
      `Hay varias fuentes que se llaman parecido: ${rows.map((r) => `«${r.name}»`).join(', ')}. Dime cuál.`,
    );
  const source = rows[0];
  if (!source?.enabled)
    throw new ValidationError('Esa fuente está desactivada. Actívala en el Feed.');
  return source;
}

/** El mismo hash que `captureApiFeed` calcula: si no coincide, la fuente se duplica. */
function apiConfigHash(config: Record<string, unknown>): string {
  const ordered = {
    toolId: config.toolId,
    input: config.input,
    ...(config.pagination ? { pagination: config.pagination } : {}),
    ...(config.shape ? { shape: config.shape } : {}),
  };
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export const trackersSyncFromSource = registerTool({
  id: 'trackers.sync_from_source',
  description:
    'Make a company table fill itself from a connected Feed source (a Google Sheet, a web page table or an API such as a flights API): every few minutes it re-reads the source, adds new rows and updates changed ones, identified by key columns (e.g. flight number + date). Creates the table from the source columns if it does not exist. Use it when the person wants a table/view to stay updated from a sheet or an API, or to be alerted when new rows arrive. If an API returns its list inside a field ("data", "arrivals", "flights") pass recordsPath; if it returns rows as arrays without names (OpenSky "states"), pass recordsPath and columns (names in order). Only the owner of the source can do this. Requires confirmation.',
  inputSchema: z.object({
    source: z.string().trim().min(1).max(240).describe('Name or id of the connected Feed source.'),
    table: trackerSlugSchema.describe(
      'Slug of the table to fill (created if it does not exist), e.g. "llegadas".',
    ),
    tableName: z.string().trim().min(1).max(80).optional().describe('Name for a new table.'),
    keyColumns: z
      .array(z.string().trim().min(1).max(120))
      .min(1)
      .max(5)
      .describe('Source column names that identify a row, e.g. ["flight.iata", "flight_date"].'),
    intervalMinutes: z.number().int().min(5).max(1440).default(15),
    notify: z.boolean().default(true).describe('Ring the bell when rows are added or change.'),
    sheet: z.number().int().min(0).max(19).default(0),
    recordsPath: z.string().trim().max(160).optional(),
    columns: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  }),
  outputSchema: z.object({
    status: z.enum(['ready', 'scheduled']),
    table: z.string(),
    inserted: z.number().int(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const source = await resolveSource(ctx.db, ctx.userId, input.source);
    const tableName =
      input.tableName ?? input.table.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const common = {
      sourceId: source.id,
      sheetIndex: input.sheet ?? 0,
      actorId: ctx.userId,
      tracker: { slug: input.table, name: tableName },
      keyColumns: input.keyColumns,
      intervalMinutes: input.intervalMinutes ?? 15,
      notify: input.notify ?? true,
    };

    const reshape = Boolean(input.recordsPath || input.columns?.length);
    if (reshape) {
      if (source.kind !== 'api')
        throw new ValidationError('recordsPath y columns sólo aplican a fuentes de API.');
      const config = {
        ...source.config,
        shape: {
          ...(input.recordsPath ? { recordsPath: input.recordsPath } : {}),
          ...(input.columns?.length ? { columns: input.columns } : {}),
        },
      };
      const { error } = await ctx.db
        .from('feed_sources')
        .update({
          config,
          config_hash: apiConfigHash(config),
          updated_at: new Date().toISOString(),
        })
        .eq('id', source.id)
        .eq('actor_id', ctx.userId);
      if (error) throw error;
    }

    // Con una captura que ya trae la tabla, la primera carga va de una vez.
    const ready =
      !reshape && (await latestSourceSheet(ctx.db, source.id, ctx.userId, common.sheetIndex));
    if (ready) {
      const { tracker, createdTracker, outcome } = await createTrackerSync(ctx.db, common);
      return {
        status: 'ready' as const,
        table: tracker.slug,
        inserted: outcome.inserted,
        markdown: `${createdTracker ? `Creé la tabla **${tracker.name}** (\`${tracker.slug}\`)` : `La tabla **${tracker.name}** ahora`} se llena sola desde «${source.name}» cada ${common.intervalMinutes} minutos. Primera carga: ${outcome.inserted} filas nuevas, ${outcome.updated} actualizadas${outcome.skipped ? `, ${outcome.skipped} sin clave (saltadas)` : ''}. Puedo hacerle una vista con aviso cuando entre algo nuevo.`,
      };
    }

    const queued = await ctx.enqueueJob?.('table-sync/setup', {
      organizationId: ctx.organizationId,
      ...common,
    });
    if (!queued)
      throw new ValidationError(
        'La fuente todavía no tiene una tabla legible y no pude programar la primera lectura. Actualízala en el Feed y vuelve a intentar.',
      );
    return {
      status: 'scheduled' as const,
      table: input.table,
      inserted: 0,
      markdown: `Listo: vuelvo a leer «${source.name}»${reshape ? ' con la forma nueva' : ''}, creo la tabla \`${input.table}\` y la dejo llenándose sola cada ${common.intervalMinutes} minutos. Te aviso en la campana cuando termine la primera carga.`,
    };
  },
});

export const trackersSyncs = registerTool({
  id: 'trackers.syncs',
  description:
    'List the tables that fill themselves from connected sources: which source, how often, last run, how many rows came in, and any error. Read-only.',
  inputSchema: z.object({}),
  outputSchema: z.object({ markdown: z.string(), total: z.number().int() }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const syncs = await listTrackerSyncs(ctx.db);
    if (!syncs.length)
      return {
        total: 0,
        markdown:
          'Ninguna tabla se llena sola todavía. Se configura con trackers.sync_from_source.',
      };
    const lines = syncs.map(
      (s) =>
        `- Cada ${s.interval_minutes} min · ${s.enabled ? 'activa' : 'en pausa'} · última: ${s.last_run_at?.slice(0, 16).replace('T', ' ') ?? 'aún no'} ${s.last_status === 'error' ? `— error: ${s.last_error}` : `(+${s.last_inserted} nuevas, ${s.last_updated} actualizadas)`}`,
    );
    return { total: syncs.length, markdown: lines.join('\n') };
  },
});
