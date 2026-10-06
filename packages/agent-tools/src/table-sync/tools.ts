import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { fetchCustomToolById } from '../custom-tools/store';
import { registerTool } from '../index';
import { trackerSlugSchema } from '../trackers/schema';
import { FeedCaptureError, captureGoogleSheetFeed, parseGoogleSheetRef } from './feed-capture';
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

export async function resolveSource(db: SupabaseClient, actorId: string, ref: string) {
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
      `No hay una fuente conectada llamada «${ref}». Si la persona dio un enlace de Google Sheets, conéctala tú con feed_connect_google_sheet (pasa el enlace) y vuelve a llamar con el id que devuelve; no la mandes al Feed.`,
    );
  if (rows.length > 1 && !byId)
    throw new ValidationError(
      `Hay varias fuentes que se llaman parecido: ${rows.map((r) => `«${r.name}»`).join(', ')}. Dime cuál.`,
    );
  const source = rows[0];
  if (!source?.enabled)
    throw new ValidationError(
      'Esa fuente está desactivada: sólo la persona dueña puede reactivarla, desde el interruptor de la fuente en el Feed. Dile que la active y vuelve a intentar; no la conectes de nuevo.',
    );
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

const QUERY_CREDENTIAL = /(^|_)(token|secret|password|passwd|api_?key|authorization|cookie)($|_)/i;

/**
 * Los parámetros fijos de una fuente de API de LISTA («aeropuerto = BOG»,
 * «fecha = {hoy:YYYY-MM-DD}»), que se leen una vez por corrida. Se mezclan en
 * `config.input` de la fuente; `{hoy}` / `{ahora}` se resuelven al consultar
 * (ver `renderInputTokens`), y el hash de la fuente queda sobre la plantilla,
 * así que no nace una fuente nueva cada día. Los nombres tienen que ser
 * parámetros de la herramienta propia de la fuente, y una llave no va aquí.
 */
export async function setSourceQuery(
  db: SupabaseClient,
  actorId: string,
  source: { id: string; kind: string; config: Record<string, unknown> },
  query: Record<string, string>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (source.kind !== 'api')
    throw new ValidationError('Los parámetros de consulta sólo aplican a fuentes de API.');
  const toolId = typeof source.config.toolId === 'string' ? source.config.toolId : null;
  const tool = toolId ? await fetchCustomToolById(db, toolId) : null;
  if (!tool) throw new ValidationError('La herramienta de esa fuente ya no existe.');
  const names = new Set((tool.input_schema?.fields ?? []).map((f) => f.name));
  for (const key of Object.keys(query)) {
    if (QUERY_CREDENTIAL.test(key))
      throw new ValidationError(
        `«${key}» parece una llave: va en la credencial, no en la consulta.`,
      );
    if (!names.has(key))
      throw new ValidationError(
        `«${key}» no es un parámetro de «${tool.name}». Parámetros: ${[...names].join(', ') || 'ninguno'}.`,
      );
  }
  const config = {
    ...source.config,
    ...extra,
    input: { ...((source.config.input as Record<string, unknown> | undefined) ?? {}), ...query },
  };
  const { error } = await db
    .from('feed_sources')
    .update({ config, config_hash: apiConfigHash(config), updated_at: new Date().toISOString() })
    .eq('id', source.id)
    .eq('actor_id', actorId);
  if (error) throw error;
}

export const trackersSyncFromSource = registerTool({
  id: 'trackers.sync_from_source',
  description:
    'Make a company table fill itself from a connected Feed source (a Google Sheet — if the person gave a Google Sheets link and it is not connected yet, connect it first with feed_connect_google_sheet and pass the returned source id here — a web page table or an API such as a flights API): every few minutes it re-reads the source, adds new rows and updates changed ones, identified by key columns (e.g. flight number + date). Creates the table from the source columns if it does not exist. Use it when the person wants a table/view to stay updated from a sheet or an API, or to be alerted when new rows arrive. If the API needs fixed query parameters (airport, date) pass query (values may use {hoy:YYYY-MM-DD}). If an API returns its list inside a field ("data", "arrivals", "flights") pass recordsPath; if it returns rows as arrays without names (OpenSky "states"), pass recordsPath and columns (names in order). Only the owner of the source can do this. Requires confirmation.',
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
    query: z
      .record(z.string().max(60), z.string().max(200))
      .optional()
      .describe(
        'Fixed query parameters of an API source that returns a list, e.g. {"airport":"BOG","date":"{hoy:YYYY-MM-DD}"}. {hoy} and {ahora} (optionally with a format) are resolved each time the API is read.',
      ),
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

    const hasQuery = Boolean(input.query && Object.keys(input.query).length);
    const reshape = Boolean(input.recordsPath || input.columns?.length || hasQuery);
    if (reshape) {
      if (source.kind !== 'api')
        throw new ValidationError('recordsPath, columns y query sólo aplican a fuentes de API.');
      const shape =
        input.recordsPath || input.columns?.length
          ? {
              shape: {
                ...(input.recordsPath ? { recordsPath: input.recordsPath } : {}),
                ...(input.columns?.length ? { columns: input.columns } : {}),
              },
            }
          : {};
      if (hasQuery) await setSourceQuery(ctx.db, ctx.userId, source, input.query ?? {}, shape);
      else {
        const config = { ...source.config, ...shape };
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
        'La fuente todavía no tiene una tabla legible y no pude programar la primera lectura. Si es una hoja de Google, vuelve a llamar a feed_connect_google_sheet con su enlace para traer una captura fresca y reintenta; si es otra fuente, la persona la actualiza desde el Feed.',
      );
    return {
      status: 'scheduled' as const,
      table: input.table,
      inserted: 0,
      markdown: `Listo: vuelvo a leer «${source.name}»${reshape ? ' con la forma nueva' : ''}, creo la tabla \`${input.table}\` y la dejo llenándose sola cada ${common.intervalMinutes} minutos. Te aviso en la campana cuando termine la primera carga.`,
    };
  },
});

/**
 * CONECTAR UNA HOJA DE GOOGLE DESDE EL CHAT.
 *
 * Antes la persona pegaba el enlace y Cortex contestaba «conéctala primero en el
 * Feed»: no existía ninguna herramienta que creara la fuente, sólo el botón del
 * Feed. Ésta hace el mismo trabajo que ese botón (misma captura, mismos topes,
 * misma huella y mismo `config_hash`, así que no duplica una hoja ya conectada:
 * la refresca) y devuelve las pestañas con encabezados y filas para que el
 * modelo siga solo con `trackers.sync_from_source` o con una vista.
 *
 * Pide confirmación aunque sólo lee: crea una fuente y una entrada en el Feed
 * privado de la persona, con una copia de la hoja que vive siete días.
 */
export const feedConnectGoogleSheet = registerTool({
  id: 'feed.connect_google_sheet',
  description:
    "Connect a Google Sheet to the person's Feed in one step and return its tabs with headers and row counts plus the source id. Use it as soon as the person pastes a docs.google.com/spreadsheets link (or sheet id) to analyse it, build a table or a view from it, or keep it synced — never tell them to go to the Feed to connect it. Safe to repeat: an already connected sheet is refreshed, not duplicated. Next steps: trackers.sync_from_source (source = the returned sourceId, sheet = tab index) to fill a company table from it, or feed_table_query. Needs the company Google connection (Datos y conexiones). For a Google Drive FOLDER use trackers.sync_from_drive_folder instead. Requires confirmation.",
  inputSchema: z.object({
    sheet: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe('Google Sheets link (docs.google.com/spreadsheets/d/...) or the spreadsheet id.'),
  }),
  outputSchema: z.object({
    sourceId: z.string(),
    attachmentId: z.string(),
    name: z.string(),
    url: z.string(),
    refreshed: z.boolean(),
    partial: z.boolean(),
    tabs: z.array(
      z.object({
        sheet: z.number().int(),
        name: z.string(),
        headers: z.array(z.string()),
        rows: z.number().int(),
      }),
    ),
    markdown: z.string(),
  }),
  // Igual que gsheets.read_range: sin Google conectado, el registro responde
  // con el error de integración de siempre en vez de uno del handler.
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] },
  ],
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const spreadsheetId = parseGoogleSheetRef(input.sheet);
    if (!spreadsheetId)
      throw new ValidationError(
        'Eso no parece un enlace de Google Sheets. Pide el enlace completo (docs.google.com/spreadsheets/d/...). Si es una carpeta de Drive usa trackers.sync_from_drive_folder.',
      );
    try {
      const captured = await captureGoogleSheetFeed({
        db: ctx.db,
        ctx,
        actorId: ctx.userId,
        spreadsheetId,
      });
      const tabs = captured.tables.map(
        (t) =>
          `- Pestaña ${t.sheet} «${t.name}»: ${t.rows} filas · ${t.headers.filter(Boolean).join(', ') || 'sin encabezados'}`,
      );
      return {
        sourceId: captured.sourceId,
        attachmentId: captured.attachmentId,
        name: captured.name,
        url: captured.url,
        refreshed: captured.deduplicated,
        partial: captured.truncated,
        tabs: captured.tables,
        markdown: `${captured.deduplicated ? 'Ya estaba conectada; la actualicé.' : 'Conecté'} «${captured.name}» al Feed (fuente \`${captured.sourceId}\`).${captured.truncated ? ' La captura es parcial (máximo 1.000 filas y 52 columnas por pestaña).' : ''}\n${tabs.join('\n')}`,
      };
    } catch (err) {
      if (err instanceof FeedCaptureError) throw new ValidationError(err.message);
      const hasGoogle = await ctx.integrations
        .hasScopes('google', ['https://www.googleapis.com/auth/spreadsheets.readonly'])
        .catch(() => false);
      if (!hasGoogle)
        throw new ValidationError(
          'Google no está conectado en esta empresa (o falta el permiso de Hojas). Conéctalo en Datos y conexiones y vuelve a pegar el enlace; ése es el único paso que no puedo hacer yo.',
        );
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        'No pude leer la hoja con la conexión de Google de la empresa. Revisa que la persona tenga permiso sobre el archivo (compártelo con la cuenta conectada) y que el enlace sea el correcto.',
      );
    }
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
