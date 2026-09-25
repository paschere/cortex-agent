import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { buildToolContext } from '@/lib/agent';
import { feedFingerprint } from '@/lib/feed/fingerprint';
import { readGoogleSheetFeed } from '@/lib/feed/google-sheets';
import { FEED_COLUMNS, ownedFeed } from '@/lib/feed/store';
import {
  type CustomToolResult,
  customToolDef,
  fetchCustomToolById,
  runTool,
} from '@cortex/agent-tools';
import type { SheetData, SheetValue } from '@cortex/agent-tools/src/kb/spreadsheets';
import { webScrape } from '@cortex/agent-tools/src/web/scrape';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  type FeedPagination,
  collectFeedPages,
  feedPaginationSchema,
  valueAtPath,
} from './pagination';

const MAX_ROWS = 1000;
const MAX_COLUMNS = 50;
const MAX_CELL_CHARS = 4000;
const MAX_TEXT = 200_000;

function cell(value: unknown): SheetValue {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_CELL_CHARS);
  return JSON.stringify(value).slice(0, MAX_CELL_CHARS);
}

/**
 * CÓMO SE LEE UNA RESPUESTA DE API COMO TABLA.
 *
 * Antes sólo una lista de registros en la raíz (`[{…},{…}]`) se volvía tabla, y
 * casi ninguna API real responde así: AviationStack y Flightradar24 meten la
 * lista en `data`, FlightAware en `arrivals`, OpenSky manda `states` como
 * listas SIN nombres de campo. Todas esas quedaban como texto y ninguna vista
 * podía mostrarlas.
 *
 * Ahora, en este orden:
 *   1. `shape.recordsPath` si la fuente lo dice («data», «response.flights»).
 *   2. La lista en la raíz.
 *   3. Si la raíz es un objeto, la propiedad que es una lista de registros (o
 *      de filas) más larga — sin adivinar entre dos del mismo tamaño.
 * Una lista de listas usa `shape.columns` como encabezados, o c1, c2… En las
 * listas que vienen dentro de un objeto, un objeto anidado se aplana UN nivel
 * con punto («origin.code»): lo bastante para aeropuertos, horas y estados.
 * Una lista en la raíz no se aplana, para no mover columnas de las que ya
 * dependen activaciones guardadas.
 */
export const apiShapeSchema = z.object({
  recordsPath: z
    .string()
    .trim()
    .max(160)
    .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
    .refine((v) => !v.split('.').some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)))
    .optional(),
  columns: z.array(z.string().trim().min(1).max(80)).max(MAX_COLUMNS).optional(),
});
export type ApiShape = z.infer<typeof apiShapeSchema>;

type Records = Array<Record<string, unknown>> | unknown[][];

function isRecordList(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((row) => row && typeof row === 'object' && !Array.isArray(row))
  );
}

function isRowList(v: unknown): v is unknown[][] {
  return Array.isArray(v) && v.length > 0 && v.every((row) => Array.isArray(row));
}

function findRecords(data: unknown, shape?: ApiShape): Records | null {
  if (shape?.recordsPath) {
    const at = valueAtPath(data, shape.recordsPath);
    return isRecordList(at) || isRowList(at) ? at : null;
  }
  if (isRecordList(data) || isRowList(data)) return data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidates = Object.values(data as Record<string, unknown>).filter(
    (v): v is Records => isRecordList(v) || isRowList(v),
  );
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.length - a.length);
  // Dos listas igual de largas: no hay cómo saber cuál es la buena.
  if (sorted.length > 1 && sorted[0]?.length === sorted[1]?.length) return null;
  return sorted[0] ?? null;
}

/** Un nivel de aplanado: { origin: { code } } → { "origin.code" }. */
function flatten(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, v] of Object.entries(value as Record<string, unknown>))
        out[`${key}.${inner}`] = v;
    } else out[key] = value;
  }
  return out;
}

export function normalizeApiFeed(
  data: unknown,
  shape?: ApiShape,
): {
  text: string;
  tables?: SheetData[];
  truncated: boolean;
} {
  const found = findRecords(data, shape);
  if (found) {
    const records: Array<Record<string, unknown>> = isRowList(found)
      ? found.map((row) =>
          Object.fromEntries(row.map((v, i) => [shape?.columns?.[i] ?? `c${i + 1}`, v])),
        )
      : // Una lista en la raíz conserva su forma de siempre (anidados como
        // JSON): las activaciones ya guardadas dependen del orden de esas
        // columnas. Sólo se aplanan las respuestas que antes no daban tabla.
        found === data
        ? (found as Array<Record<string, unknown>>)
        : (found as Array<Record<string, unknown>>).map(flatten);
    const headers: string[] = [];
    const seen = new Set<string>();
    let truncated = records.length > MAX_ROWS;
    for (const row of records.slice(0, MAX_ROWS)) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key) && headers.length < MAX_COLUMNS) {
          seen.add(key);
          headers.push(key);
        } else if (!seen.has(key)) {
          truncated = true;
        }
        const value = row[key];
        if (
          typeof value === 'string'
            ? value.length > MAX_CELL_CHARS
            : value != null &&
              typeof value === 'object' &&
              JSON.stringify(value).length > MAX_CELL_CHARS
        )
          truncated = true;
      }
    }
    const rows: SheetValue[][] = [
      headers,
      ...records.slice(0, MAX_ROWS).map((row) => headers.map((h) => cell(row[h]))),
    ];
    const table = { name: 'API', rows };
    return {
      text: `Respuesta API tabular: ${records.length} filas, ${headers.length} columnas.`,
      tables: [table],
      truncated,
    };
  }
  const serialized = typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? '');
  return { text: serialized.slice(0, MAX_TEXT), truncated: serialized.length > MAX_TEXT };
}

function hashConfig(config: object) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export async function registerFeedSourceCapture(options: {
  db: SupabaseClient;
  actorId: string;
  kind: 'file' | 'text' | 'url' | 'google_sheet';
  name: string;
  config: Record<string, unknown>;
  attachmentId: string;
  targetSourceId?: string;
}) {
  const now = new Date().toISOString();
  const configHash = hashConfig(options.config);
  if (options.targetSourceId) {
    if (!['file', 'text'].includes(options.kind))
      throw new Error('Sólo archivos y textos aceptan versiones manuales.');
    const target = await options.db
      .from('feed_sources')
      .select('id,kind')
      .eq('id', options.targetSourceId)
      .eq('actor_id', options.actorId)
      .maybeSingle();
    if (target.error || !target.data) throw new Error('La fuente de destino no existe.');
    if (target.data.kind !== options.kind)
      throw new Error('La nueva versión debe ser del mismo tipo que la fuente.');
    const updated = await options.db
      .from('feed_sources')
      .update({
        latest_attachment_id: options.attachmentId,
        enabled: true,
        last_checked_at: now,
        last_changed_at: now,
        status: 'ok',
        error: null,
        updated_at: now,
      })
      .eq('id', options.targetSourceId)
      .eq('actor_id', options.actorId);
    if (updated.error) throw new Error('No se pudo guardar la nueva versión.');
    const attachment = await options.db
      .from('chat_attachments')
      .select('feed_source_id')
      .eq('id', options.attachmentId)
      .eq('created_by', options.actorId)
      .maybeSingle();
    if (attachment.error || !attachment.data)
      throw new Error('No se pudo comprobar la captura de la nueva versión.');
    if (!attachment.data.feed_source_id) {
      const linked = await options.db
        .from('chat_attachments')
        .update({ feed_source_id: options.targetSourceId })
        .eq('id', options.attachmentId)
        .eq('created_by', options.actorId)
        .is('feed_source_id', null);
      if (linked.error) throw new Error('No se pudo enlazar la nueva versión.');
    }
    return options.targetSourceId;
  }
  const existing = await options.db
    .from('feed_sources')
    .select('id')
    .eq('actor_id', options.actorId)
    .eq('kind', options.kind)
    .eq('config_hash', configHash)
    .maybeSingle();
  if (existing.error) throw new Error('No se pudo comprobar el registro de la fuente.');
  let id = existing.data?.id as string | undefined;
  if (!id) {
    const inserted = await options.db
      .from('feed_sources')
      .insert({
        actor_id: options.actorId,
        kind: options.kind,
        name: options.name.slice(0, 240),
        config: options.config,
        config_hash: configHash,
        latest_attachment_id: options.attachmentId,
        last_checked_at: now,
        last_changed_at: now,
        status: 'ok',
      })
      .select('id')
      .single();
    if (inserted.error || !inserted.data) throw new Error('No se pudo registrar la fuente.');
    id = inserted.data.id as string;
  } else {
    const updated = await options.db
      .from('feed_sources')
      .update({
        latest_attachment_id: options.attachmentId,
        last_checked_at: now,
        status: 'ok',
        error: null,
        updated_at: now,
      })
      .eq('id', id);
    if (updated.error) throw new Error('No se pudo actualizar la conexión de Feed.');
  }
  const linked = await options.db
    .from('chat_attachments')
    .update({ feed_source_id: id })
    .eq('id', options.attachmentId)
    .eq('created_by', options.actorId);
  if (linked.error) throw new Error('No se pudo enlazar la captura de Feed.');
  return id;
}

function rejectCredentialInputs(input: Record<string, unknown>) {
  const suspect = Object.keys(input).find((key) =>
    /(^|_)(token|secret|password|passwd|api_?key|authorization|cookie)($|_)/i.test(key),
  );
  if (suspect)
    throw new Error(
      `El parámetro "${suspect}" parece una credencial. Guárdalo en la autenticación de la herramienta, no en Feed.`,
    );
}

export async function captureApiFeed(options: {
  db: SupabaseClient;
  organizationId: string;
  actorId: string;
  toolId: string;
  input: Record<string, unknown>;
  pagination?: FeedPagination;
  shape?: ApiShape;
  name?: string;
}) {
  const { db, organizationId, actorId } = options;
  rejectCredentialInputs(options.input);
  const tool = await fetchCustomToolById(db, options.toolId);
  if (!tool || !tool.enabled) throw new Error('La herramienta no existe o está desactivada.');
  if (tool.http_method !== 'GET')
    throw new Error('Feed sólo permite herramientas API de lectura GET.');
  const context = buildToolContext({
    organizationId,
    userId: actorId,
    agentId: actorId,
    surface: 'web',
    signal: AbortSignal.timeout(60_000),
  });
  const read = async (input: Record<string, unknown>) => {
    const result = (await runTool(customToolDef(tool), input, context, {
      confirmed: false,
    })) as CustomToolResult;
    if (!result.ok)
      throw new Error(result.message || 'La API no devolvió una respuesta utilizable.');
    return { data: result.data, truncated: result.truncated };
  };
  const pagination = options.pagination
    ? feedPaginationSchema.parse(options.pagination)
    : undefined;
  if (
    pagination &&
    !tool.input_schema?.fields?.some((field) => field.name === pagination.cursorInput)
  )
    throw new Error('El parámetro de cursor debe existir en la herramienta API.');
  const result = pagination
    ? await collectFeedPages(pagination, options.input, read)
    : await read(options.input);
  const shape = options.shape ? apiShapeSchema.parse(options.shape) : undefined;
  const normalized = normalizeApiFeed(result.data, shape);
  if (!normalized.text.trim() && !normalized.tables?.length)
    throw new Error('La API devolvió una respuesta vacía.');

  const safeConfig = {
    toolId: tool.id,
    input: options.input,
    ...(pagination ? { pagination } : {}),
    ...(shape && (shape.recordsPath || shape.columns?.length) ? { shape } : {}),
  };
  const configHash = hashConfig(safeConfig);
  const sourceName = (options.name?.trim() || tool.name).slice(0, 240);
  const now = new Date().toISOString();
  const { data: existingSource, error: sourceReadError } = await db
    .from('feed_sources')
    .select('id,latest_attachment_id')
    .eq('actor_id', actorId)
    .eq('kind', 'api')
    .eq('config_hash', configHash)
    .maybeSingle();
  if (sourceReadError) throw new Error('No se pudo comprobar la fuente API.');
  let sourceId = existingSource?.id as string | undefined;
  if (!sourceId) {
    const inserted = await db
      .from('feed_sources')
      .insert({
        actor_id: actorId,
        kind: 'api',
        name: sourceName,
        config: safeConfig,
        config_hash: configHash,
      })
      .select('id')
      .single();
    if (inserted.error || !inserted.data) throw new Error('No se pudo registrar la fuente API.');
    sourceId = inserted.data.id as string;
  }

  const provenance = `api:${tool.id}`;
  const fingerprint = feedFingerprint({
    text: normalized.text,
    tables: normalized.tables,
    sourceUrl: provenance,
    truncated: normalized.truncated || result.truncated,
  });
  const duplicate = await ownedFeed(db, actorId).eq('feed_content_hash', fingerprint).maybeSingle();
  if (duplicate.error) throw new Error('No se pudo comprobar el historial de Feed.');
  if (duplicate.data) {
    const updated = await db
      .from('feed_sources')
      .update({
        latest_attachment_id: duplicate.data.id,
        last_checked_at: now,
        status: 'ok',
        error: null,
        updated_at: now,
      })
      .eq('id', sourceId)
      .eq('enabled', true)
      .select('id')
      .maybeSingle();
    if (updated.error || !updated.data)
      throw new Error('No se pudo actualizar la conexión o fue desactivada.');
    return { sourceId, entry: duplicate.data, deduplicated: true };
  }
  const { count, error: countError } = await db
    .from('chat_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', actorId)
    .not('feed_kind', 'is', null)
    .gt('purge_at', now);
  if (countError) throw new Error('No se pudo comprobar la capacidad de Feed.');
  if ((count ?? 0) >= 100)
    throw new Error('Tu Feed tiene 100 entradas. Elimina alguna para actualizarlo.');

  const id = randomUUID();
  const body = Buffer.from(normalized.text);
  const rawHash = createHash('sha256').update(body).digest('hex');
  const inserted = await db
    .from('chat_attachments')
    .insert({
      id,
      conversation_id: null,
      disposition: 'turn',
      filename: `API · ${sourceName}`,
      mime: 'application/json',
      byte_size: body.length,
      sha256: rawHash,
      feed_content_hash: fingerprint,
      extracted_text: normalized.text,
      file_path: null,
      created_by: actorId,
      feed_kind: 'api',
      source_url: null,
      feed_tables: normalized.tables ?? null,
      feed_truncated: normalized.truncated || result.truncated === true,
      feed_source_id: sourceId,
    })
    .select(FEED_COLUMNS)
    .single();
  if (inserted.error || !inserted.data) throw new Error('No se pudo guardar la captura API.');
  const updated = await db
    .from('feed_sources')
    .update({
      latest_attachment_id: id,
      last_checked_at: now,
      last_changed_at: now,
      status: 'ok',
      error: null,
      updated_at: now,
    })
    .eq('id', sourceId)
    .eq('enabled', true)
    .select('id')
    .maybeSingle();
  if (updated.error || !updated.data)
    throw new Error('No se pudo actualizar la conexión o fue desactivada.');
  return { sourceId, entry: inserted.data, deduplicated: false };
}

export async function refreshFeedSource(
  db: SupabaseClient,
  actorId: string,
  sourceId: string,
  organizationId: string,
): Promise<{ sourceId: string; entry: unknown; deduplicated: boolean }> {
  const { data, error } = await db
    .from('feed_sources')
    .select('id,kind,name,config,enabled')
    .eq('id', sourceId)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (error || !data) throw new Error('La fuente no existe.');
  if (!data.enabled) throw new Error('La fuente está desactivada.');
  try {
    const config = data.config as {
      toolId?: string;
      input?: Record<string, unknown>;
      url?: string;
      spreadsheetId?: string;
      pagination?: FeedPagination;
      shape?: ApiShape;
    };
    if (data.kind === 'combined') {
      const { refreshCombinedSource } = await import('./combined-source');
      return await refreshCombinedSource(
        db,
        actorId,
        sourceId,
        organizationId,
        async (dependencyId) => {
          const dependency = await db
            .from('feed_sources')
            .select('kind,enabled')
            .eq('id', dependencyId)
            .eq('actor_id', actorId)
            .maybeSingle();
          if (dependency.error || !dependency.data?.enabled)
            throw new Error('Una fuente del cruce está desconectada o no está disponible.');
          if (['api', 'url', 'google_sheet'].includes(dependency.data.kind))
            await refreshFeedSource(db, actorId, dependencyId, organizationId);
          else if (!['file', 'text'].includes(dependency.data.kind))
            throw new Error('Los cruces no pueden depender de otros cruces.');
        },
      );
    }
    if (data.kind === 'api') {
      if (!config.toolId) throw new Error('La fuente API no tiene una herramienta configurada.');
      return await captureApiFeed({
        db,
        organizationId,
        actorId,
        toolId: config.toolId,
        input: config.input ?? {},
        pagination: config.pagination,
        shape: config.shape,
        name: data.name,
      });
    }
    const context = buildToolContext({
      organizationId,
      userId: actorId,
      agentId: actorId,
      surface: 'web',
      signal: AbortSignal.timeout(30_000),
    });
    if (data.kind === 'google_sheet') {
      if (!config.spreadsheetId) throw new Error('La fuente no conserva el id de Google Sheets.');
      const result = await readGoogleSheetFeed(context, config.spreadsheetId);
      return saveRefreshedCapture({
        db,
        actorId,
        sourceId,
        name: data.name,
        kind: 'url',
        sourceUrl: `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`,
        text: result.text,
        tables: result.tables,
        truncated: result.truncated,
      });
    }
    if (data.kind === 'url') {
      if (!config.url) throw new Error('La fuente no conserva una URL pública.');
      const result = await webScrape.handler({ url: config.url, maxChars: 20_000 }, context);
      if (!result.content.trim()) throw new Error('La página ya no tiene texto accesible.');
      return saveRefreshedCapture({
        db,
        actorId,
        sourceId,
        name: data.name,
        kind: 'url',
        sourceUrl: config.url,
        text: `Fuente: ${config.url}\nConsultada: ${new Date().toISOString()}\n\n${result.content}`,
        identityText: result.content,
        truncated: result.truncated,
      });
    }
    throw new Error('Los archivos y textos se actualizan añadiendo una nueva versión manual.');
  } catch (error) {
    await db
      .from('feed_sources')
      .update({
        last_checked_at: new Date().toISOString(),
        status: 'error',
        error: (error instanceof Error ? error.message : 'No se pudo actualizar.').slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', sourceId)
      .eq('enabled', true);
    throw error;
  }
}

async function saveRefreshedCapture(options: {
  db: SupabaseClient;
  actorId: string;
  sourceId: string;
  name: string;
  kind: 'url';
  sourceUrl: string;
  text: string;
  identityText?: string;
  tables?: SheetData[];
  truncated: boolean;
}) {
  const fingerprint = feedFingerprint({
    text: options.identityText || options.text,
    tables: options.tables,
    sourceUrl: options.sourceUrl,
    truncated: options.truncated,
  });
  const duplicate = await ownedFeed(options.db, options.actorId)
    .eq('feed_content_hash', fingerprint)
    .maybeSingle();
  const now = new Date().toISOString();
  if (duplicate.error) throw new Error('No se pudo comprobar el historial de Feed.');
  if (duplicate.data) {
    const updated = await options.db
      .from('feed_sources')
      .update({
        latest_attachment_id: duplicate.data.id,
        last_checked_at: now,
        status: 'ok',
        error: null,
        updated_at: now,
      })
      .eq('id', options.sourceId)
      .eq('enabled', true)
      .select('id')
      .maybeSingle();
    if (updated.error || !updated.data)
      throw new Error('No se pudo actualizar la conexión o fue desactivada.');
    return { sourceId: options.sourceId, entry: duplicate.data, deduplicated: true };
  }
  const { count, error: countError } = await options.db
    .from('chat_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', options.actorId)
    .not('feed_kind', 'is', null)
    .gt('purge_at', now);
  if (countError) throw new Error('No se pudo comprobar la capacidad de Feed.');
  if ((count ?? 0) >= 100)
    throw new Error('Tu Feed tiene 100 entradas. Elimina alguna para actualizarlo.');
  const id = randomUUID();
  const bytes = Buffer.from(options.text);
  const inserted = await options.db
    .from('chat_attachments')
    .insert({
      id,
      conversation_id: null,
      disposition: 'turn',
      filename: options.name,
      mime: 'text/markdown',
      byte_size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      feed_content_hash: fingerprint,
      extracted_text: options.text,
      file_path: null,
      created_by: options.actorId,
      feed_kind: options.kind,
      source_url: options.sourceUrl,
      feed_tables: options.tables ?? null,
      feed_truncated: options.truncated,
      feed_source_id: options.sourceId,
    })
    .select(FEED_COLUMNS)
    .single();
  if (inserted.error || !inserted.data) throw new Error('No se pudo guardar la nueva captura.');
  const updated = await options.db
    .from('feed_sources')
    .update({
      latest_attachment_id: id,
      last_checked_at: now,
      last_changed_at: now,
      status: 'ok',
      error: null,
      updated_at: now,
    })
    .eq('id', options.sourceId)
    .eq('enabled', true)
    .select('id')
    .maybeSingle();
  if (updated.error || !updated.data)
    throw new Error('No se pudo actualizar la conexión o fue desactivada.');
  return { sourceId: options.sourceId, entry: inserted.data, deduplicated: false };
}
