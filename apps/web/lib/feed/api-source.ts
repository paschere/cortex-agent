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

const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
const MAX_CELL_CHARS = 4000;
const MAX_TEXT = 200_000;

function cell(value: unknown): SheetValue {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_CELL_CHARS);
  return JSON.stringify(value).slice(0, MAX_CELL_CHARS);
}

/** Only arrays of records become tables; every other response stays text. */
export function normalizeApiFeed(data: unknown): {
  text: string;
  tables?: SheetData[];
  truncated: boolean;
} {
  if (
    Array.isArray(data) &&
    data.every((row) => row && typeof row === 'object' && !Array.isArray(row))
  ) {
    const records = data as Record<string, unknown>[];
    const headers: string[] = [];
    const seen = new Set<string>();
    for (const row of records.slice(0, MAX_ROWS)) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key) && headers.length < MAX_COLUMNS) {
          seen.add(key);
          headers.push(key);
        }
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
      truncated: records.length > MAX_ROWS || Object.keys(records[0] ?? {}).length > MAX_COLUMNS,
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
}) {
  const now = new Date().toISOString();
  const configHash = hashConfig(options.config);
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
    await options.db
      .from('feed_sources')
      .update({
        latest_attachment_id: options.attachmentId,
        last_checked_at: now,
        status: 'ok',
        error: null,
        updated_at: now,
      })
      .eq('id', id);
  }
  await options.db
    .from('chat_attachments')
    .update({ feed_source_id: id })
    .eq('id', options.attachmentId);
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
  const result = (await runTool(customToolDef(tool), options.input, context, {
    confirmed: false,
  })) as CustomToolResult;
  if (!result.ok) throw new Error(result.message || 'La API no devolvió una respuesta utilizable.');
  const normalized = normalizeApiFeed(result.data);
  if (!normalized.text.trim() && !normalized.tables?.length)
    throw new Error('La API devolvió una respuesta vacía.');

  const safeConfig = { toolId: tool.id, input: options.input };
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
    await db
      .from('feed_sources')
      .update({
        latest_attachment_id: duplicate.data.id,
        last_checked_at: now,
        status: 'ok',
        error: null,
        updated_at: now,
      })
      .eq('id', sourceId);
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
  await db
    .from('feed_sources')
    .update({
      latest_attachment_id: id,
      last_checked_at: now,
      last_changed_at: now,
      status: 'ok',
      error: null,
      updated_at: now,
    })
    .eq('id', sourceId);
  return { sourceId, entry: inserted.data, deduplicated: false };
}

export async function refreshFeedSource(
  db: SupabaseClient,
  actorId: string,
  sourceId: string,
  organizationId: string,
) {
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
    };
    if (data.kind === 'api') {
      if (!config.toolId) throw new Error('La fuente API no tiene una herramienta configurada.');
      return await captureApiFeed({
        db,
        organizationId,
        actorId,
        toolId: config.toolId,
        input: config.input ?? {},
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
      .eq('id', sourceId);
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
    await options.db
      .from('feed_sources')
      .update({
        latest_attachment_id: duplicate.data.id,
        last_checked_at: now,
        status: 'ok',
        error: null,
        updated_at: now,
      })
      .eq('id', options.sourceId);
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
  await options.db
    .from('feed_sources')
    .update({
      latest_attachment_id: id,
      last_checked_at: now,
      last_changed_at: now,
      status: 'ok',
      error: null,
      updated_at: now,
    })
    .eq('id', options.sourceId);
  return { sourceId: options.sourceId, entry: inserted.data, deduplicated: false };
}
