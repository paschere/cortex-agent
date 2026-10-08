import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { fetchCustomToolById } from '../custom-tools/store';
import { registerTool } from '../index';
import type { SheetData } from '../kb/spreadsheets';
import { duplicateRuleSchema } from '../trackers/duplicates';
import { trackerFieldSchema, trackerSlugSchema } from '../trackers/schema';
import { getTrackerBySlug } from '../trackers/store';
import type { ToolContext } from '../types';
import {
  FeedCaptureError,
  captureGoogleSheetFeed,
  hashConfig,
  listGoogleSheetTabs,
  parseGoogleSheetRef,
  readGoogleSheetTab,
  resolveSheetTab,
  sheetSourceConfig,
} from './feed-capture';
import { proposalMarkdown, proposeTableFromSheet } from './propose';
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
      `No hay una fuente conectada llamada «${ref}». Si la persona dio un enlace o id de Google Sheets, vuelve a llamar con ESE enlace en source (más tab con el nombre de la pestaña): esta herramienta lo lee o lo conecta sola. Si era el nombre de otra fuente, mira las del Feed; no mandes a la persona a conectar nada.`,
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

/** El error de Google, dicho como el modelo (y la persona) lo pueden usar. */
async function sheetReadError(ctx: ToolContext, err: unknown): Promise<Error> {
  if (err instanceof FeedCaptureError) return new ValidationError(err.message);
  if (err instanceof ValidationError) return err;
  const hasGoogle = await ctx.integrations
    .hasScopes('google', ['https://www.googleapis.com/auth/spreadsheets.readonly'])
    .catch(() => false);
  if (!hasGoogle)
    return new ValidationError(
      'Google no está conectado en esta empresa (o falta el permiso de Hojas). Conéctalo en Datos y conexiones y vuelve a pegar el enlace; ése es el único paso que no puedo hacer yo.',
    );
  return new ValidationError(
    'No pude leer la hoja con la conexión de Google de la empresa. Revisa que la persona tenga permiso sobre el archivo (compártelo con la cuenta conectada) y que el enlace sea el correcto.',
  );
}

/**
 * La fuente de un enlace de Google Sheets, conectándola si hace falta. Con
 * `tab` conecta SÓLO esa pestaña (la fuente guarda `tabs` y solo esa se
 * relee); sin `tab`, el libro entero como siempre. Si ya hay una fuente con esa
 * misma config y captura vigente, se reutiliza.
 */
async function sheetLinkSource(ctx: ToolContext, spreadsheetId: string, tab?: string) {
  try {
    let tabs: string[] | undefined;
    if (tab !== undefined && tab.trim()) {
      const meta = await listGoogleSheetTabs(ctx, spreadsheetId);
      tabs = [(meta.tabs[resolveSheetTab(meta.tabs, tab)] as { title: string }).title];
    }
    const found = await ctx.db
      .from('feed_sources')
      .select('id')
      .eq('actor_id', ctx.userId)
      .eq('kind', 'google_sheet')
      .eq('config_hash', hashConfig(sheetSourceConfig(spreadsheetId, tabs)))
      .maybeSingle();
    const existingId = (found.data as { id: string } | null)?.id;
    if (existingId && (await latestSourceSheet(ctx.db, existingId, ctx.userId, 0)))
      return await resolveSource(ctx.db, ctx.userId, existingId);
    const captured = await captureGoogleSheetFeed({
      db: ctx.db,
      ctx,
      actorId: ctx.userId,
      spreadsheetId,
      tabs,
    });
    return await resolveSource(ctx.db, ctx.userId, captured.sourceId);
  } catch (err) {
    throw await sheetReadError(ctx, err);
  }
}

const SHEET_SCOPES: Array<{ provider: 'google'; scopes: string[] }> = [
  { provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] },
];

/**
 * Leer la hoja y PROPONER la tabla, sin crear nada. Es el paso obligado antes
 * de trackers.sync_from_source con una tabla nueva (ver propose.ts).
 */
export const trackersProposeFromSource = registerTool({
  id: 'trackers.propose_from_source',
  description:
    'Read a Google Sheet (paste its docs.google.com/spreadsheets link or id straight into source — nothing needs to be connected first) or a connected Feed source, and PROPOSE the company table that will be filled from it, without creating anything: fields with type (text, long text, number, money, date, time, yes/no, list with its options), which ones are required, formats it detected (email, phone, NIT, plate, AWB), which column(s) identify each row, and a duplicate rule when the same code appears with different dates. For a workbook with several tabs pass tab = the tab name (case, accents and double spaces do not matter; a wrong name returns the list of real tabs) — only that tab is read, its first 300 rows. ALWAYS call this before trackers.sync_from_source creates a new table (and before building a view on a sheet), show the returned markdown to the person and wait for their approval or changes; then pass the approved fields to trackers.sync_from_source with the same link and tab. Read-only; never answer that the sheet must be connected first.',
  inputSchema: z.object({
    source: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe(
        'Google Sheets link or spreadsheet id, or the name or id of a connected Feed source.',
      ),
    tab: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('Tab name, e.g. "VUELOS DIARIOS DE MERFLEX". Wins over sheet.'),
    sheet: z
      .number()
      .int()
      .min(0)
      .max(19)
      .optional()
      .describe('Tab index when you do not know the name (default 0).'),
  }),
  outputSchema: z.object({
    /** null cuando se leyó directo desde un enlace, sin conectar nada. */
    sourceId: z.string().nullable(),
    spreadsheetId: z.string().nullable(),
    tab: z.string().nullable(),
    fields: z.array(z.record(z.unknown())),
    keyColumns: z.array(z.string()),
    duplicates: z.record(z.unknown()).nullable(),
    rows: z.number().int(),
    markdown: z.string(),
  }),
  requiredScopes: SHEET_SCOPES,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const spreadsheetId = parseGoogleSheetRef(input.source);
    let sourceId: string | null = null;
    let tab: string | null = null;
    let sheet: SheetData;
    let sourceName: string;
    let prefix = '';
    if (spreadsheetId) {
      try {
        const read = await readGoogleSheetTab(ctx, spreadsheetId, {
          tab: input.tab ?? input.sheet,
        });
        sheet = read.sheet;
        tab = read.tab;
        sourceName = `${read.title} › ${read.tab}`;
        const total = read.tabs.find((t) => t.title === read.tab)?.rows ?? 0;
        prefix = `Leí la pestaña «${read.tab}» de «${read.title}»: ${total} filas en total${read.truncated ? `; analicé el encabezado y las primeras ${Math.max(0, sheet.rows.length - 1)}` : ''}. Pestañas de ese libro: ${read.tabs.map((t) => `«${t.title}»`).join(', ')}.\n\n`;
      } catch (err) {
        throw await sheetReadError(ctx, err);
      }
    } else {
      const source = await resolveSource(ctx.db, ctx.userId, input.source);
      const found = await latestSourceSheet(
        ctx.db,
        source.id,
        ctx.userId,
        input.tab ?? input.sheet ?? 0,
      );
      if (!found)
        throw new ValidationError(
          'Esa fuente no tiene una captura vigente con esa pestaña. Si es una hoja de Google, llama de nuevo con su enlace en source (y tab) para leerla directo.',
        );
      sourceId = source.id;
      sheet = found.sheet;
      sourceName = found.sourceName;
      tab = found.sheet.name;
    }
    if (sheet.rows.length < 2)
      throw new ValidationError(
        `La pestaña «${tab ?? sheet.name}» está vacía o sólo tiene encabezado. Revisa que sea la correcta: llama de nuevo con otro tab.`,
      );
    const proposal = proposeTableFromSheet(sheet);
    const { why: _why, ...duplicates } = proposal.duplicates ?? { why: '' };
    return {
      sourceId,
      spreadsheetId: spreadsheetId ?? null,
      tab,
      fields: proposal.fields as unknown as Record<string, unknown>[],
      keyColumns: proposal.keyColumns,
      duplicates: proposal.duplicates ? (duplicates as Record<string, unknown>) : null,
      rows: proposal.rows,
      markdown: prefix + proposalMarkdown(proposal, sourceName),
    };
  },
});

export const trackersSyncFromSource = registerTool({
  id: 'trackers.sync_from_source',
  description:
    'Make a company table fill itself from a Google Sheet or another Feed source (a web page table or an API such as a flights API). For a Google Sheet pass its link or id straight in source plus tab = the tab name (e.g. "VUELOS DIARIOS DE MERFLEX"): if it is not connected yet this connects ONLY that tab by itself and keeps re-reading only it — never answer that it must be connected first: every few minutes it re-reads the source, adds new rows and updates changed ones, identified by key columns (e.g. flight number + date). For a table that does not exist yet you MUST first call trackers.propose_from_source, show the proposal and pass the approved fields here. Use it when the person wants a table/view to stay updated from a sheet or an API, or to be alerted when new rows arrive. If the API needs fixed query parameters (airport, date) pass query (values may use {hoy:YYYY-MM-DD}). If an API returns its list inside a field ("data", "arrivals", "flights") pass recordsPath; if it returns rows as arrays without names (OpenSky "states"), pass recordsPath and columns (names in order). Only the owner of the source can do this. Requires confirmation (it creates a table the whole team sees and a recurring job).',
  inputSchema: z.object({
    source: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe('Google Sheets link or id, or the name or id of a connected Feed source.'),
    tab: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Tab name of the sheet (case and accents do not matter; a wrong name returns the real tabs). With a link, only this tab is connected and read.',
      ),
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
    sheet: z
      .number()
      .int()
      .min(0)
      .max(19)
      .default(0)
      .describe('Index among the tabs saved on the source (ignored when tab is given).'),
    fields: z
      .array(
        trackerFieldSchema.and(z.object({ sourceColumn: z.string().trim().max(120).optional() })),
      )
      .min(1)
      .max(20)
      .optional()
      .describe(
        'REQUIRED when the table does not exist yet: the fields the person approved from trackers.propose_from_source (with any changes they asked for), each with its sourceColumn (sheet header; omit for a field the sheet does not fill, e.g. a status used to flag duplicates).',
      ),
    duplicates: duplicateRuleSchema
      .optional()
      .describe('Duplicate rule the person approved (from the proposal), for a new table.'),
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
    /** Dónde quedó la tabla en la app (ruta relativa: «Quedó en Tablas → …»). */
    url: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const spreadsheetId = parseGoogleSheetRef(input.source);
    const source = spreadsheetId
      ? await sheetLinkSource(ctx, spreadsheetId, input.tab)
      : await resolveSource(ctx.db, ctx.userId, input.source);
    // Con un enlace y una pestaña, la fuente sólo guardó esa: es la 0. Con una
    // fuente ya conectada, `tab` se busca por nombre entre las guardadas.
    let sheetIndex = input.sheet ?? 0;
    if (input.tab) {
      if (spreadsheetId) sheetIndex = 0;
      else {
        const found = await latestSourceSheet(ctx.db, source.id, ctx.userId, input.tab);
        if (found) sheetIndex = found.index;
      }
    }
    const tableName =
      input.tableName ?? input.table.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const common = {
      sourceId: source.id,
      sheetIndex,
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
    // Una tabla NUEVA no se crea a ciegas: primero se lee la hoja y se le
    // propone a la persona (trackers.propose_from_source). Sin campos
    // aprobados, esta llamada se devuelve al modelo con el paso que falta.
    if (ready && !input.fields?.length && !(await getTrackerBySlug(ctx.db, input.table)))
      throw new ValidationError(
        `La tabla «${input.table}» no existe todavía. Primero llama a trackers.propose_from_source con esta fuente, muéstrale la propuesta a la persona y, cuando la apruebe (o la corrija), vuelve aquí con fields (y duplicates si aplica).`,
      );
    if (ready) {
      const { tracker, createdTracker, outcome } = await createTrackerSync(ctx.db, {
        ...common,
        ...(input.fields?.length
          ? { fields: input.fields.map((f) => ({ ...f, required: f.required ?? false })) }
          : {}),
        ...(input.duplicates ? { duplicates: duplicateRuleSchema.parse(input.duplicates) } : {}),
      });
      return {
        status: 'ready' as const,
        table: tracker.slug,
        inserted: outcome.inserted,
        url: `/trackers/${tracker.slug}`,
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
      url: `/trackers/${input.table}`,
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
    "Connect a Google Sheet to the person's Feed in one step and return its tabs with headers and row counts plus the source id. Use it as soon as the person pastes a docs.google.com/spreadsheets link (or sheet id) to analyse it, build a table or a view from it, or keep it synced — never tell them to go to the Feed to connect it. Pass tabs (tab names; case and accents do not matter) to connect ONLY the tab(s) that will be used — needed for a big operational workbook with several large tabs, which cannot be connected whole; a wrong name returns the real tabs. Safe to repeat: an already connected sheet is refreshed, not duplicated. Next steps: by default OFFER to keep it up to date — trackers.sync_from_source (source = the returned sourceId, sheet = tab index) creates a company table in Tablas that re-reads the sheet every 15 minutes, instead of leaving it as a one-off snapshot — or feed_table_query. Needs the company Google connection (Datos y conexiones). For a Google Drive FOLDER use trackers.sync_from_drive_folder instead. No confirmation: it only READS the sheet into the person's own private Feed (nothing is written to the sheet or shared), so connect it right away when they paste a link.",
  inputSchema: z.object({
    sheet: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe('Google Sheets link (docs.google.com/spreadsheets/d/...) or the spreadsheet id.'),
    tabs: z
      .array(z.string().trim().min(1).max(120))
      .min(1)
      .max(20)
      .optional()
      .describe('Tab names to connect (only these are stored and re-read). Omit for all tabs.'),
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
  requiredScopes: SHEET_SCOPES,
  // Sin confirmación (decisión del dueño, 2026-10-08): sólo LEE la hoja hacia
  // el Feed privado de quien la pega; nada se escribe en la hoja ni se
  // comparte. Crear la tabla del equipo (trackers.sync_from_source) sí confirma.
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
        tabs: input.tabs,
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
        markdown: `${captured.deduplicated ? 'Ya estaba conectada; la actualicé.' : 'Conecté'} «${captured.name}» al Feed (fuente \`${captured.sourceId}\`).${captured.truncated ? ` La captura es parcial (máximo ${input.tabs?.length ? '20.000' : '1.000'} filas y 52 columnas por pestaña).` : ''}\n${tabs.join('\n')}`,
      };
    } catch (err) {
      throw await sheetReadError(ctx, err);
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
