import { createHash, randomUUID } from 'node:crypto';
import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { putFile, removeFiles } from '../files/store';
import { sheetsFetch } from '../gsheets/client';
import type { SheetData } from '../kb/spreadsheets';
import type { ToolContext } from '../types';

/**
 * Captura de una Google Sheet al Feed, compartida por el Feed de la web
 * (POST /api/feed) y por el chat (herramienta `feed.connect_google_sheet`).
 *
 * Vivía dentro del manejador de la ruta del Feed, y por eso el chat no tenía
 * cómo conectar una hoja: el modelo llamaba a `trackers.sync_from_source`, que
 * no encontraba la fuente y mandaba a la persona al Feed a hacerlo a mano. Aquí
 * está en un solo lugar, en el paquete de herramientas, porque la confirmación
 * del chat (`/api/chat/confirm`) sólo ejecuta herramientas del registro y una
 * herramienta del registro no puede importar nada de `apps/web`.
 *
 * Lo que NO cambia respecto a la ruta: el tope de 100 entradas, los límites de
 * celdas y pestañas, la huella (`feedFingerprint`) con la que se deduplica y el
 * `config_hash` de la fuente (sha256 de `{ spreadsheetId }`). Éste último tiene
 * que ser idéntico al que escribe el Feed: `table-sync/tools.ts` avisa que si el
 * hash no coincide la fuente se duplica.
 */

/** Columnas que el Feed muestra de una captura (las mismas de `lib/feed/store.ts`). */
export const FEED_COLUMNS =
  'id, filename, feed_kind, source_url, created_at, purge_at, byte_size, conversation_id, promoted_document_id, feed_truncated, feed_source_id';

/** Tope de capturas vivas por persona. */
export const FEED_MAX_ENTRIES = 100;

/** Error con el estado HTTP que la ruta del Feed devuelve; el chat sólo lee el mensaje. */
export class FeedCaptureError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FeedCaptureError';
  }
}

/** Exact readable-content identity, not fuzzy business-entity matching. */
export function feedFingerprint(input: {
  text: string;
  tables?: SheetData[];
  sourceUrl?: string | null;
  truncated?: boolean;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        truncated: input.truncated ?? false,
        // Keep distinct source URLs separate so deduplication never loses provenance.
        sourceUrl: input.sourceUrl ?? null,
        content: input.tables?.length ? input.tables : input.text.replace(/\r\n/g, '\n').trim(),
      }),
    )
    .digest('hex');
}

export function googleSpreadsheetId(url: URL): string | null {
  if (url.hostname !== 'docs.google.com') return null;
  return /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
}

/**
 * Acepta lo que la gente pega: la URL completa de la hoja o el id suelto. Un
 * id son letras, números, guion y guion bajo (y largo): cualquier otra cosa es
 * otra URL o un nombre, y no se adivina.
 */
export function parseGoogleSheetRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return googleSpreadsheetId(new URL(trimmed));
    } catch {
      return null;
    }
  }
  return /^[a-zA-Z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}

interface SheetsMeta {
  properties: { title: string };
  sheets: Array<{
    properties: { title: string; gridProperties?: { rowCount: number; columnCount: number } };
  }>;
}

type SheetCell = string | number | boolean | null;

export interface SheetTabInfo {
  title: string;
  rows: number;
  cols: number;
}

/** Última columna que se lee de una pestaña (52 columnas). */
const LAST_COL = 'AZ';
/** Sin pestañas elegidas: el comportamiento de siempre. */
const ALL_TABS_MAX_ROWS = 1000;
const ALL_TABS_MAX_CELLS = 50_000;
const ALL_TABS_MAX_TABS = 20;
/** Con pestañas elegidas el tope sube, y se lee por bloques de rango. */
export const CHOSEN_TAB_MAX_ROWS = 20_000;
export const CHOSEN_TABS_MAX_CELLS = 200_000;
export const SHEET_BLOCK_ROWS = 5000;
/** Filas que se leen de una pestaña para proponer una tabla (más el encabezado). */
export const PROPOSE_SAMPLE_ROWS = 300;

/** Título y tamaño de las pestañas, sin leer datos. */
export async function listGoogleSheetTabs(ctx: ToolContext, id: string) {
  return fetchSheetsMeta(ctx, id);
}

async function fetchSheetsMeta(ctx: ToolContext, id: string) {
  const meta = await sheetsFetch<SheetsMeta>(
    ctx,
    `/${id}?fields=properties(title),sheets(properties(title,gridProperties))`,
  );
  if (!meta.sheets?.length) throw new Error('El spreadsheet no tiene pestañas.');
  const tabs: SheetTabInfo[] = meta.sheets.map((s) => ({
    title: s.properties.title,
    rows: s.properties.gridProperties?.rowCount ?? 0,
    cols: s.properties.gridProperties?.columnCount ?? 0,
  }));
  return { name: meta.properties.title, tabs };
}

/** Minúsculas, sin tildes y con espacios simples: «Vuelos  Diarios» = «vuelos diarios». */
function normalizeTabName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tabsList(tabs: SheetTabInfo[]): string {
  return tabs.map((t, i) => `${i}: «${t.title}» (${t.rows} filas)`).join('; ');
}

/**
 * Elige una pestaña por nombre (sin distinguir mayúsculas, tildes ni espacios
 * dobles) o por índice. Sin coincidencia exacta acepta la más parecida sólo si
 * es inequívoca (una única pestaña contiene el texto, o él la contiene); si no,
 * el error LISTA las pestañas que existen para que el modelo elija sin adivinar.
 */
export function resolveSheetTab(tabs: SheetTabInfo[], tab?: string | number): number {
  if (tab === undefined || tab === '') return 0;
  const fail = (why: string) =>
    new ValidationError(
      `${why} Pestañas de esa hoja: ${tabsList(tabs)}. Vuelve a llamar con el nombre exacto de una de ellas.`,
    );
  if (typeof tab === 'number') {
    if (!Number.isInteger(tab) || tab < 0 || tab >= tabs.length)
      throw fail(`No existe la pestaña número ${tab}.`);
    return tab;
  }
  const wanted = normalizeTabName(tab);
  const exact = tabs.findIndex((t) => normalizeTabName(t.title) === wanted);
  if (exact >= 0) return exact;
  const similar = tabs
    .map((t, i) => ({ i, n: normalizeTabName(t.title) }))
    .filter(({ n }) => wanted && (n.includes(wanted) || wanted.includes(n)));
  if (similar.length === 1 && similar[0]) return similar[0].i;
  throw fail(
    similar.length > 1
      ? `«${tab}» se parece a varias pestañas.`
      : `No hay una pestaña llamada «${tab}».`,
  );
}

function a1Title(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

async function fetchValues(ctx: ToolContext, id: string, range: string) {
  const result = await sheetsFetch<{ values?: SheetCell[][] }>(
    ctx,
    `/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
  );
  return result.values ?? [];
}

/**
 * Lee UNA pestaña con un rango acotado (encabezado + `maxRows` filas por
 * defecto), sin tocar las demás: una hoja operativa de varias pestañas grandes
 * se puede leer y proponer sin conectarla. `tabs` trae el tamaño de todas para
 * poder decirle a la persona cuántas filas hay en total.
 */
export async function readGoogleSheetTab(
  ctx: ToolContext,
  spreadsheetId: string,
  options: { tab?: string | number; maxRows?: number } = {},
) {
  const maxRows = Math.max(1, Math.min(options.maxRows ?? PROPOSE_SAMPLE_ROWS, CHOSEN_TAB_MAX_ROWS));
  const meta = await fetchSheetsMeta(ctx, spreadsheetId);
  const index = resolveSheetTab(meta.tabs, options.tab);
  const info = meta.tabs[index] as SheetTabInfo;
  const rows = await fetchValues(
    ctx,
    spreadsheetId,
    `${a1Title(info.title)}!A1:${LAST_COL}${maxRows + 1}`,
  );
  return {
    title: meta.name,
    tab: info.title,
    tabs: meta.tabs,
    sheet: { name: info.title, rows } as SheetData,
    truncated: info.rows > maxRows + 1 || info.cols > 52,
  };
}

/**
 * Lee una pestaña por bloques de rango (A1:AZ5000, A5001:AZ10000…) hasta
 * `maxRows` filas: no se le pide a Google todo de una. Un bloque que vuelve
 * corto es el final de los datos.
 */
async function readTabInBlocks(
  ctx: ToolContext,
  id: string,
  title: string,
  gridRows: number,
  maxRows: number,
) {
  const rows: SheetCell[][] = [];
  const limit = gridRows > 0 ? Math.min(gridRows, maxRows) : maxRows;
  for (let from = 1; from <= limit; from += SHEET_BLOCK_ROWS) {
    const to = Math.min(from + SHEET_BLOCK_ROWS - 1, limit);
    const block = await fetchValues(ctx, id, `${a1Title(title)}!A${from}:${LAST_COL}${to}`);
    rows.push(...block);
    if (block.length < to - from + 1) break;
  }
  return rows;
}

/**
 * Snapshot acotado a través de la conexión de Google de la persona. Sin
 * `tabs`: todas las pestañas (máx. 20), A1:AZ1000 cada una y 50.000 celdas.
 * Con `tabs`: sólo esas, hasta 20.000 filas por pestaña y 200.000 celdas,
 * leídas por bloques. `selected` devuelve los títulos reales elegidos.
 */
export async function readGoogleSheetFeed(
  ctx: ToolContext,
  id: string,
  options: { tabs?: string[] } = {},
) {
  const meta = await fetchSheetsMeta(ctx, id);
  const chosen = options.tabs?.length
    ? [...new Set(options.tabs.map((t) => resolveSheetTab(meta.tabs, t)))].map(
        (i) => meta.tabs[i] as SheetTabInfo,
      )
    : null;
  if (!chosen && meta.tabs.length > ALL_TABS_MAX_TABS)
    throw new ValidationError(
      `Esa hoja tiene ${meta.tabs.length} pestañas (el máximo sin elegir es ${ALL_TABS_MAX_TABS}). Elige las que se usan con tabs. Pestañas: ${tabsList(meta.tabs)}.`,
    );
  const maxRows = chosen ? CHOSEN_TAB_MAX_ROWS : ALL_TABS_MAX_ROWS;
  const maxCells = chosen ? CHOSEN_TABS_MAX_CELLS : ALL_TABS_MAX_CELLS;
  const tables: SheetData[] = [];
  let cells = 0;
  let truncated = false;
  for (const info of chosen ?? meta.tabs) {
    const rows = chosen
      ? await readTabInBlocks(ctx, id, info.title, info.rows, maxRows)
      : await fetchValues(ctx, id, `${a1Title(info.title)}!A1:${LAST_COL}${maxRows}`);
    cells += rows.reduce((n, row) => n + row.length, 0);
    if (cells > maxCells)
      throw new ValidationError(
        chosen
          ? `Las pestañas elegidas superan ${maxCells.toLocaleString('es-CO')} celdas. Elige menos pestañas.`
          : `La captura supera 50.000 celdas. Elige sólo las pestañas que se usan con tabs (pestañas: ${tabsList(meta.tabs)}).`,
      );
    truncated ||= !info.rows || info.rows > maxRows || info.cols > 52;
    tables.push({ name: info.title, rows });
  }
  const text = tables
    .map(
      (sheet) =>
        `## ${sheet.name}\n${sheet.rows.map((row) => row.map((v) => v ?? '').join('\t')).join('\n')}`,
    )
    .join('\n\n');
  return {
    name: meta.name,
    text,
    tables,
    truncated,
    selected: chosen ? chosen.map((c) => c.title) : null,
  };
}

/**
 * La config de una fuente de Google Sheets. Sin pestañas queda `{ spreadsheetId }`,
 * idéntica a la que escribe el Feed, así que el `config_hash` de las fuentes
 * existentes no cambia; con pestañas es una fuente propia de esas pestañas.
 */
export function sheetSourceConfig(spreadsheetId: string, tabs?: string[] | null) {
  return tabs?.length ? { spreadsheetId, tabs } : { spreadsheetId };
}

export function hashConfig(config: object) {
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

export interface PersistFeedCaptureInput {
  db: SupabaseClient;
  actorId: string;
  /** Capturas vivas ya contadas por quien llama; si no viene se cuenta aquí. */
  count?: number;
  kind: 'file' | 'text' | 'url';
  sourceKind: 'file' | 'text' | 'url' | 'google_sheet';
  name: string;
  mime: string;
  bytes: Buffer;
  text: string;
  tables?: SheetData[];
  url: string | null;
  truncated: boolean;
  fingerprint: string;
  sourceConfig: Record<string, unknown>;
  targetSourceId?: string;
}

/**
 * Guarda una captura del Feed: deduplica por huella (y por bytes originales en
 * las entradas viejas), respeta el tope de 100, sube el archivo, inserta la fila
 * y registra la fuente. Es el final de POST /api/feed, tal cual, sin cambios de
 * comportamiento.
 */
export async function persistFeedCapture(input: PersistFeedCaptureInput) {
  const { db, actorId, kind, sourceKind, name, fingerprint, targetSourceId } = input;
  const config = Object.keys(input.sourceConfig).length
    ? input.sourceConfig
    : { contentHash: fingerprint };
  const owned = () =>
    db
      .from('chat_attachments')
      .select(FEED_COLUMNS)
      .eq('created_by', actorId)
      .not('feed_kind', 'is', null)
      .gt('purge_at', new Date().toISOString());
  const findDuplicate = () => owned().eq('feed_content_hash', fingerprint).maybeSingle();

  const duplicate = await findDuplicate();
  if (duplicate.error)
    throw new FeedCaptureError('No se pudo comprobar si la fuente ya existe.', 503);
  const dupRow = duplicate.data as unknown as { id: string } | null;
  if (dupRow) {
    const sourceId = await registerFeedSourceCapture({
      db,
      actorId,
      kind: sourceKind,
      name,
      config,
      attachmentId: dupRow.id,
      targetSourceId,
    });
    return { entry: dupRow, deduplicated: true, sourceId };
  }
  // Older entries have no semantic identity yet; exact original bytes remain a safe match.
  const rawHash = createHash('sha256').update(input.bytes).digest('hex');
  const legacy = await owned()
    .eq('sha256', rawHash)
    .eq('mime', input.mime)
    .is('feed_content_hash', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (legacy.error)
    throw new FeedCaptureError('No se pudo comprobar el historial de la fuente.', 503);
  const legacyRow = (legacy.data as unknown as Array<{ id: string }> | null)?.[0];
  if (legacyRow && kind !== 'url') {
    let sourceId: string | undefined;
    if (targetSourceId)
      sourceId = await registerFeedSourceCapture({
        db,
        actorId,
        kind: sourceKind,
        name,
        config: { contentHash: fingerprint },
        attachmentId: legacyRow.id,
        targetSourceId,
      });
    return { entry: legacyRow, deduplicated: true, sourceId };
  }
  let count = input.count;
  if (count === undefined) {
    const counted = await db
      .from('chat_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', actorId)
      .not('feed_kind', 'is', null)
      .gt('purge_at', new Date().toISOString());
    if (counted.error) throw new FeedCaptureError('No se pudo abrir Feed.', 500);
    count = counted.count ?? 0;
  }
  if (count >= FEED_MAX_ENTRIES)
    throw new FeedCaptureError(
      'Tu Feed tiene 100 entradas. Elimina alguna para añadir una fuente nueva.',
      409,
    );
  const id = randomUUID();
  const path = `${actorId}/${id}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  try {
    await putFile(db, {
      bucket: 'chat-uploads',
      path,
      content: input.bytes,
      contentType: input.mime,
    });
    const { data, error } = await db
      .from('chat_attachments')
      .insert({
        id,
        conversation_id: null,
        disposition: 'turn',
        filename: name,
        mime: input.mime,
        byte_size: input.bytes.length,
        sha256: rawHash,
        feed_content_hash: fingerprint,
        extracted_text: input.text,
        file_path: path,
        created_by: actorId,
        feed_kind: kind,
        source_url: input.url,
        feed_tables: input.tables ?? null,
        feed_truncated: input.truncated,
      })
      .select(FEED_COLUMNS)
      .single();
    if (error?.code === '23505') {
      await removeFiles(db, 'chat-uploads', [path]);
      const winner = await findDuplicate();
      const winnerRow = winner.data as unknown as { id: string } | null;
      if (winner.error || !winnerRow) throw new Error('No se pudo recuperar la entrada existente.');
      const sourceId = await registerFeedSourceCapture({
        db,
        actorId,
        kind: sourceKind,
        name,
        config,
        attachmentId: winnerRow.id,
        targetSourceId,
      });
      return { entry: winnerRow, deduplicated: true, sourceId };
    }
    if (error || !data) throw new Error('No se pudo guardar la entrada.');
    const row = data as unknown as { id: string };
    const sourceId = await registerFeedSourceCapture({
      db,
      actorId,
      kind: sourceKind,
      name,
      config,
      attachmentId: row.id,
      targetSourceId,
    });
    return { entry: row, deduplicated: false, sourceId };
  } catch {
    try {
      await db.from('chat_attachments').delete().eq('id', id).eq('created_by', actorId);
    } catch {
      // Best effort rollback; the seven-day purge remains the final safety net.
    }
    await removeFiles(db, 'chat-uploads', [path]).catch(() => {});
    throw new FeedCaptureError('No se pudo añadir a Feed. Inténtalo otra vez.', 500);
  }
}

export interface CapturedSheetSummary {
  attachmentId: string;
  sourceId: string;
  name: string;
  url: string;
  spreadsheetId: string;
  deduplicated: boolean;
  truncated: boolean;
  /** Una por pestaña, en orden: `sheet` es el índice que pide `trackers.sync_from_source`. */
  tables: Array<{ sheet: number; name: string; headers: string[]; rows: number }>;
}

/**
 * Conecta una Google Sheet al Feed de la persona: la lee con la conexión de
 * Google de la empresa, guarda la captura y registra (o reutiliza) la fuente.
 *
 * Si la hoja ya estaba conectada no nace una fuente nueva: `config_hash` es el
 * mismo, así que `registerFeedSourceCapture` la encuentra y le apunta la captura
 * fresca; y si el contenido no cambió, la huella devuelve la captura existente.
 * Llamarla dos veces es, por tanto, «refrescar».
 */
export async function captureGoogleSheetFeed(options: {
  db: SupabaseClient;
  ctx: ToolContext;
  actorId: string;
  spreadsheetId: string;
  /** Sólo estas pestañas (nombres): se guardan en la fuente y es lo único que se relee. */
  tabs?: string[];
  count?: number;
}): Promise<CapturedSheetSummary> {
  const { db, ctx, actorId, spreadsheetId } = options;
  const result = await readGoogleSheetFeed(ctx, spreadsheetId, { tabs: options.tabs });
  const chosen = Boolean(result.selected);
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  const name = result.name.slice(0, 200);
  if (!result.text.trim())
    throw new FeedCaptureError(
      'No encontré texto legible. Para un escaneo, pega la transcripción.',
      422,
    );
  // Con pestañas elegidas la hoja puede ser grande a propósito: las tablas
  // (feed_tables) llevan los datos completos y el texto es sólo la vista previa.
  const tablesBytes = JSON.stringify(result.tables).length;
  if (
    (!chosen && result.text.length > 200_000) ||
    tablesBytes > (chosen ? 20_000_000 : 2_000_000)
  )
    throw new FeedCaptureError(
      chosen
        ? 'Las pestañas elegidas son demasiado extensas. Elige menos pestañas o divide la hoja.'
        : 'El contenido es demasiado extenso. Elige sólo las pestañas que se usan (tabs) o divide la hoja.',
      422,
    );
  const text = result.text.length > 200_000 ? result.text.slice(0, 200_000) : result.text;
  const fingerprint = feedFingerprint({
    text: result.text,
    tables: result.tables,
    sourceUrl: url,
    truncated: result.truncated,
  });
  const saved = await persistFeedCapture({
    db,
    actorId,
    count: options.count,
    kind: 'url',
    sourceKind: 'google_sheet',
    name,
    mime: 'text/markdown',
    bytes: Buffer.from(text),
    text,
    tables: result.tables,
    url,
    truncated: result.truncated,
    fingerprint,
    sourceConfig: sheetSourceConfig(spreadsheetId, result.selected),
  });
  return {
    attachmentId: saved.entry.id,
    sourceId: saved.sourceId as string,
    name,
    url,
    spreadsheetId,
    deduplicated: saved.deduplicated,
    truncated: result.truncated,
    tables: result.tables.map((t, sheet) => ({
      sheet,
      name: t.name,
      headers: (t.rows[0] ?? []).map((v) => String(v ?? '').slice(0, 80)),
      rows: Math.max(0, t.rows.length - 1),
    })),
  };
}
