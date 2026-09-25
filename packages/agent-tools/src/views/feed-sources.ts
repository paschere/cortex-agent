import type { SupabaseClient } from '@supabase/supabase-js';
import type { SheetData, SheetValue } from '../kb/spreadsheets';
import { FIELD_KEY_RE, type TrackerField } from '../trackers/schema';
import type { ViewRow } from './compute';
import { type FeedSourceRef, feedSourceId, parseFeedSourceId } from './spec';

/**
 * LAS TABLAS DEL FEED COMO FUENTES DE UNA VISTA.
 *
 * El Feed (0128) es donde cada persona suelta lo que le llega —un Excel, un
 * CSV, una hoja de Google conectada, una API de lectura (0150), un cruce de
 * fuentes (0152)— y Activaciones (0148–0153) vigila esas tablas con reglas.
 * Faltaba poder MIRARLAS: «muéstrame en un tablero lo que llegó en el Excel de
 * despachos», «un gráfico de la hoja de ventas que se sincroniza sola». Este
 * archivo convierte una hoja del Feed en algo con la misma forma que una tabla
 * inventada (`TrackerField` + filas), para que `computeView` no sepa de dónde
 * vino.
 *
 * TRES FORMAS DE NOMBRAR UNA TABLA DEL FEED (ids en spec.ts):
 *
 *   feed.<captura>.<hoja>       una captura fija: un archivo, un texto, una URL.
 *   feedsrc.<conexión>.<hoja>   la ÚLTIMA captura de una fuente conectada. La
 *                               vista sigue a la conexión, no a una captura: cuando
 *                               la fuente se sincroniza, el siguiente refresco de
 *                               la vista (las vistas se recalculan solas cada 10–60
 *                               s) ya muestra la lectura nueva.
 *   feedview.<vista preparada>  la tabla con citas que Cortex preparó de un texto.
 *
 * LA REGLA DE PRIVACIDAD, Y POR QUÉ ES ÉSTA.
 *
 * Todo en el Feed es de quien lo subió. `ownedFeed`, `readOwnedTableSources`,
 * `readOwnedPreparedViews` y cada ruta de /api/feed y /api/activations filtran
 * por `created_by` / `actor_id` además del espacio; las fuentes conectadas
 * también (`feed_sources.actor_id`), aunque la conexión sea durable. El único
 * camino por el que algo del Feed llega al resto del equipo es publicar una
 * activación: se revisan filas concretas, se confirma de forma explícita y lo
 * que viaja son asuntos de Gerencia con la evidencia revisada — nunca la tabla
 * entera. Una vista es del espacio (cualquier miembro la abre) y puede tener
 * un enlace público; si leyera el Feed del autor para quien la abra, sería una
 * puerta que el Feed nunca tuvo. Por eso, sin excepción para las conexiones:
 *
 *   1. Sólo el DUEÑO de la captura/conexión/vista preparada ve sus filas. Se
 *      lee con el id de quien mira (`viewerId`), no con el de quien hizo la
 *      vista. Un compañero que abre la vista ve el aviso «es del Feed privado
 *      de otra persona» en esos bloques; el resto de la vista sigue.
 *   2. Primero se lee sólo la metadata (dueño y vencimiento) para decidir el
 *      aviso; el contenido se pide DESPUÉS y filtrado por dueño y vigencia.
 *      El contenido de otra persona no llega ni a la memoria del servidor.
 *   3. Una vista con una tabla del Feed no se comparte por enlace ni con
 *      contraseña (`internalSourcesOf` la cuenta), y la página pública no la
 *      lee aunque el spec la nombre (`loadViewSources` con `audience: 'public'`).
 *   4. Lo vencido está vencido: una captura pasado su `purge_at` no se lee,
 *      aunque la fila siga en la base hasta la purga. El bloque dice que venció
 *      y cómo evitarlo (conectar la fuente para que se renueve).
 *
 * Si la persona quiere mostrarle esos datos al equipo o a un cliente, el
 * camino es copiarlos a una tabla del espacio (una decisión explícita y
 * visible), no abrir su Feed.
 *
 * LOS CAMPOS SALEN DE LOS ENCABEZADOS. La primera fila de la hoja es el
 * encabezado (lo mismo que asume Activaciones). La clave es el encabezado sin
 * tildes en minúsculas_con_guion_bajo, sin repetir; el tipo se infiere de las
 * celdas con prudencia: número sólo si TODAS las celdas con algo son números;
 * dinero sólo si además el encabezado habla de plata y la hoja no declara otra
 * moneda (un campo `money` se pinta como pesos, sources.ts regla 2); fecha
 * sólo si todas son AAAA-MM-DD o DD/MM/AAAA; opciones (para tableros) sólo con
 * pocas categorías repetidas. Ante la duda, texto.
 */

export const FEED_PRIVATE_MESSAGE =
  'Esta tabla viene del Feed privado de otra persona. Sólo quien la subió la ve aquí.';
export const FEED_PUBLIC_MESSAGE =
  'Esta tabla viene de un Feed privado y no se muestra fuera de Cortex.';
export const FEED_NO_VIEWER_MESSAGE =
  'Esta tabla viene de un Feed privado: ábrela dentro de Cortex para verla.';
export const FEED_EXPIRED_MESSAGE =
  'La captura del Feed de esta tabla venció o se borró (el Feed guarda cada captura 7 días). Vuelve a subirla, o conéctala como fuente en Feed para que se renueve sola.';

/** Tope de columnas por hoja: una vista pinta hasta 10; el diseñador no necesita 200. */
export const FEED_MAX_COLUMNS = 40;
/** Cuántas tablas del Feed ve el diseñador (las más recientes). */
export const FEED_CATALOG_LIMIT = 24;

const TEXT_MAX = 500;
const SELECT_MAX_OPTIONS = 12;
const BUILTIN_KEYS = new Set(['label', 'created_at', 'updated_at']);

// ---------------------------------------------------------------------------
// Encabezados → campos (puro)
// ---------------------------------------------------------------------------

/**
 * La clave de un encabezado: sin tildes, minúsculas_con_guion_bajo, que
 * empiece por letra, 28 caracteres para dejar sitio a un sufijo, y nunca una
 * de las tres claves que toda fila ya tiene. `taken` evita repetidas.
 */
export function headerKey(header: SheetValue | undefined, index: number, taken: Set<string>) {
  let base = String(header ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = `columna_${index + 1}`;
  if (!/^[a-z]/.test(base)) base = `c_${base}`;
  base = base.slice(0, 28).replace(/_+$/, '');
  if (BUILTIN_KEYS.has(base)) base = `${base}_hoja`;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  taken.add(key);
  return key;
}

const NUMERIC_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MONEY_HINT =
  /valor|monto|total|precio|saldo|pago|costo|importe|subtotal|\biva\b|deuda|cartera|venta|ingreso|gasto|abono|cobr|flete|tarifa|\bcop\b|pesos|\$/i;
const FOREIGN_HINT = /usd|us\$|d[oó]lar|eur|euro|\bmxn\b|\bgbp\b/i;
const CURRENCY_HEADER = /^(moneda|divisa|currency)$/i;
const CATEGORY_HINT =
  /estado|status|etapa|fase|tipo|categor|prioridad|clase|segmento|canal|zona|region|ciudad|responsable|resultado/i;

function numberOf(cell: SheetValue): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell === 'string' && NUMERIC_TEXT.test(cell.trim())) {
    const n = Number(cell.trim());
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
  }
  return null;
}

/** AAAA-MM-DD de una celda, o null. DD/MM/AAAA se lee día primero (Colombia). */
export function dayOfCell(cell: SheetValue): string | null {
  if (typeof cell !== 'string') return null;
  const text = cell.trim();
  const iso = ISO_DAY.exec(text);
  const parts = iso
    ? { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) }
    : (() => {
        const dmy = DMY.exec(text);
        return dmy ? { y: Number(dmy[3]), m: Number(dmy[2]), d: Number(dmy[1]) } : null;
      })();
  if (!parts) return null;
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (
    date.getUTCFullYear() !== parts.y ||
    date.getUTCMonth() !== parts.m - 1 ||
    date.getUTCDate() !== parts.d
  )
    return null;
  return date.toISOString().slice(0, 10);
}

function textOf(cell: SheetValue): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'boolean') return cell ? 'Sí' : 'No';
  const text = String(cell).trim();
  return text ? text.slice(0, TEXT_MAX) : null;
}

const filled = (cell: SheetValue | undefined): cell is Exclude<SheetValue, null> =>
  cell !== null && cell !== undefined && !(typeof cell === 'string' && cell.trim() === '');

export interface FeedTableShape {
  fields: TrackerField[];
  /** La columna (0-based) de cada campo, en el mismo orden. */
  columns: number[];
}

/**
 * Los campos de una hoja: uno por columna con encabezado o con datos (hasta
 * `FEED_MAX_COLUMNS`). `dataRows` son las filas SIN el encabezado — las que
 * la vista va a leer —, para que la inferencia vea lo mismo que se pinta.
 */
export function inferSheetFields(header: SheetValue[], dataRows: SheetValue[][]): FeedTableShape {
  const width = Math.min(
    FEED_MAX_COLUMNS,
    Math.max(header.length, ...dataRows.map((r) => r.length), 0),
  );
  // Una hoja que declara su moneda y trae algo distinto de pesos no tiene
  // campos `money`: se pintarían como COP (sources.ts, regla 2).
  const currencyColumn = header.findIndex((h) => CURRENCY_HEADER.test(String(h ?? '').trim()));
  const foreign =
    currencyColumn >= 0 &&
    dataRows.some((r) => {
      const c = r[currencyColumn];
      return filled(c) && String(c).trim().toUpperCase() !== 'COP';
    });

  const taken = new Set<string>();
  const fields: TrackerField[] = [];
  const columns: number[] = [];
  for (let col = 0; col < width; col++) {
    const cells = dataRows.map((r) => r[col]).filter(filled);
    const title = textOf(header[col] ?? null);
    if (!title && !cells.length) continue;
    const key = headerKey(header[col], col, taken);
    const label = (title ?? `Columna ${col + 1}`).slice(0, 60);
    let type: TrackerField['type'] = 'text';
    let options: string[] | undefined;
    if (cells.length && cells.every((c) => numberOf(c) !== null)) {
      type = !foreign && MONEY_HINT.test(label) && !FOREIGN_HINT.test(label) ? 'money' : 'number';
    } else if (cells.length && cells.every((c) => dayOfCell(c) !== null)) {
      type = 'date';
    } else if (cells.length) {
      const texts = cells.map(textOf).filter((t): t is string => Boolean(t));
      const distinct = [...new Set(texts)];
      const hinted = CATEGORY_HINT.test(label);
      if (
        distinct.length <= SELECT_MAX_OPTIONS &&
        distinct.every((d) => d.length <= 80) &&
        (hinted
          ? distinct.length >= 1
          : distinct.length >= 2 && texts.length >= distinct.length * 2)
      ) {
        type = 'select';
        options = distinct.sort((a, b) => a.localeCompare(b, 'es'));
      }
    }
    if (!FIELD_KEY_RE.test(key)) continue;
    fields.push({ key, label, type, required: false, ...(options ? { options } : {}) });
    columns.push(col);
  }
  return { fields, columns };
}

/**
 * Las filas de una hoja como filas de vista, hasta `cap`. El id es la fuente
 * más el número de fila en la hoja (1 = encabezado), estable entre refrescos
 * mientras nadie inserte filas arriba. `at` es la hora de la captura: el Feed
 * no sabe cuándo nació cada fila.
 */
export function feedTable(
  sheet: SheetData,
  sourceRef: string,
  at: string,
  cap: number,
): { fields: TrackerField[]; rows: ViewRow[]; truncated: boolean } {
  const header = sheet.rows[0] ?? [];
  const numbered = sheet.rows
    .slice(1)
    .map((cells, i) => ({ cells, line: i + 2 }))
    .filter(({ cells }) => cells.some(filled));
  const kept = numbered.slice(0, Math.max(1, cap));
  const { fields, columns } = inferSheetFields(
    header,
    kept.map((r) => r.cells),
  );
  const labelField = fields.findIndex((f) => f.type === 'text' || f.type === 'select');
  const rows = kept.map(({ cells, line }): ViewRow => {
    const values: Record<string, string | number> = {};
    fields.forEach((f, i) => {
      const cell = cells[columns[i] as number];
      if (!filled(cell)) return;
      if (f.type === 'number' || f.type === 'money') {
        const n = numberOf(cell);
        if (n !== null) values[f.key] = n;
      } else if (f.type === 'date') {
        const d = dayOfCell(cell);
        if (d) values[f.key] = d;
      } else {
        const t = textOf(cell);
        if (t) values[f.key] = t;
      }
    });
    const labelKey = labelField >= 0 ? fields[labelField]?.key : undefined;
    const label = labelKey && typeof values[labelKey] === 'string' ? values[labelKey] : null;
    return {
      id: `${sourceRef}:${line}`,
      label: (label ? String(label) : `Fila ${line}`).slice(0, 120),
      values,
      created_at: at,
      updated_at: at,
    };
  });
  return { fields, rows, truncated: numbered.length > kept.length };
}

// ---------------------------------------------------------------------------
// Lectura con dueño
// ---------------------------------------------------------------------------

export type FeedRead =
  | {
      ok: true;
      name: string;
      description: string;
      fields: TrackerField[];
      rows: ViewRow[];
      truncated: boolean;
    }
  | { ok: false; reason: 'private' | 'gone'; message: string };

interface AttachmentContent {
  id: string;
  filename: string;
  feed_tables: SheetData[] | null;
  feed_truncated: boolean | null;
  created_at: string;
  purge_at: string;
}

const CONTENT_COLUMNS = 'id, filename, feed_tables, feed_truncated, created_at, purge_at';

const gone = (message: string): FeedRead => ({ ok: false, reason: 'gone', message });
const PRIVATE: FeedRead = { ok: false, reason: 'private', message: FEED_PRIVATE_MESSAGE };

const bogotaDay = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeZone: 'America/Bogota',
});

/** El contenido de una captura, SÓLO si es de `viewerId` y no ha vencido. */
async function ownedCapture(
  db: SupabaseClient,
  id: string,
  viewerId: string,
): Promise<AttachmentContent | null> {
  const { data, error } = await db
    .from('chat_attachments')
    .select(CONTENT_COLUMNS)
    .eq('id', id)
    .eq('created_by', viewerId)
    .not('feed_kind', 'is', null)
    .gt('purge_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return (data as AttachmentContent | null) ?? null;
}

function fromSheet(
  capture: AttachmentContent,
  ref: FeedSourceRef,
  cap: number,
  name: string,
  description: string,
): FeedRead {
  const sheets = Array.isArray(capture.feed_tables) ? capture.feed_tables : [];
  const sheet = sheets[ref.sheet];
  if (!sheet)
    return gone(
      sheets.length
        ? `La hoja ${ref.sheet + 1} ya no está en la captura del Feed «${capture.filename}».`
        : `La captura del Feed «${capture.filename}» no tiene tablas.`,
    );
  const table = feedTable(sheet, feedSourceId(ref), capture.created_at, cap);
  return {
    ok: true,
    name: sheets.length > 1 ? `${name} · ${sheet.name}`.slice(0, 160) : name.slice(0, 160),
    description,
    fields: table.fields,
    rows: table.rows,
    // Una captura parcial (el Feed cortó la hoja) también es parcial aquí.
    truncated: table.truncated || Boolean(capture.feed_truncated),
  };
}

/**
 * Lee una tabla del Feed para `viewerId`. Nunca lanza por privacidad ni por
 * vencimiento: devuelve `ok: false` con la frase que el bloque va a mostrar.
 * Sí lanza si la base falla (el llamador lo convierte en aviso).
 */
export async function readFeedSource(
  db: SupabaseClient,
  refText: string,
  viewerId: string,
  cap: number,
): Promise<FeedRead> {
  const ref = parseFeedSourceId(refText);
  if (!ref) return gone('Esa tabla del Feed no existe.');
  const now = new Date().toISOString();

  if (ref.kind === 'entry') {
    // Metadata primero: dueño y vencimiento, sin contenido.
    const meta = await db
      .from('chat_attachments')
      .select('id, created_by, purge_at')
      .eq('id', ref.id)
      .not('feed_kind', 'is', null)
      .maybeSingle();
    if (meta.error) throw meta.error;
    const m = meta.data as { created_by: string; purge_at: string } | null;
    if (!m) return gone(FEED_EXPIRED_MESSAGE);
    if (m.created_by !== viewerId) return PRIVATE;
    if (!(m.purge_at > now)) return gone(FEED_EXPIRED_MESSAGE);
    const capture = await ownedCapture(db, ref.id, viewerId);
    if (!capture) return gone(FEED_EXPIRED_MESSAGE);
    return fromSheet(
      capture,
      ref,
      cap,
      capture.filename,
      `Tabla de tu Feed («${capture.filename}»). Privada: sólo tú la ves. Es una captura fija que vence el ${bogotaDay.format(new Date(capture.purge_at))}.`,
    );
  }

  if (ref.kind === 'connection') {
    const meta = await db
      .from('feed_sources')
      .select('id, actor_id, name, latest_attachment_id, enabled')
      .eq('id', ref.id)
      .maybeSingle();
    if (meta.error) throw meta.error;
    const src = meta.data as {
      actor_id: string;
      name: string;
      latest_attachment_id: string | null;
      enabled: boolean;
    } | null;
    if (!src) return gone('La fuente conectada de esta tabla se desconectó o se borró en Feed.');
    if (src.actor_id !== viewerId) return PRIVATE;
    const capture = src.latest_attachment_id
      ? await ownedCapture(db, src.latest_attachment_id, viewerId)
      : null;
    if (!capture)
      return gone(
        `La fuente conectada «${src.name}» no tiene una lectura vigente. Actualízala en Feed y esta tabla vuelve sola.`,
      );
    return fromSheet(
      capture,
      ref,
      cap,
      src.name,
      `Fuente conectada de tu Feed («${src.name}»): muestra siempre su última lectura y cambia sola cuando la fuente se sincroniza. Privada: sólo tú la ves.${src.enabled ? '' : ' La conexión está pausada.'}`,
    );
  }

  // Vista preparada: metadata, luego contenido filtrado por dueño.
  const meta = await db
    .from('feed_prepared_views')
    .select('id, actor_id, source_id')
    .eq('id', ref.id)
    .maybeSingle();
  if (meta.error) throw meta.error;
  const pv = meta.data as { actor_id: string; source_id: string } | null;
  if (!pv)
    return gone(
      'La vista preparada de esta tabla ya no existe: se borra junto con su captura del Feed.',
    );
  if (pv.actor_id !== viewerId) return PRIVATE;
  const alive = await db
    .from('chat_attachments')
    .select('id, purge_at')
    .eq('id', pv.source_id)
    .eq('created_by', viewerId)
    .not('feed_kind', 'is', null)
    .gt('purge_at', now)
    .maybeSingle();
  if (alive.error) throw alive.error;
  if (!alive.data) return gone(FEED_EXPIRED_MESSAGE);
  const content = await db
    .from('feed_prepared_views')
    .select('id, name, table_data, created_at')
    .eq('id', ref.id)
    .eq('actor_id', viewerId)
    .maybeSingle();
  if (content.error) throw content.error;
  const view = content.data as { name: string; table_data: SheetData; created_at: string } | null;
  if (!view?.table_data || !Array.isArray(view.table_data.rows))
    return gone('La vista preparada de esta tabla ya no existe.');
  const table = feedTable(view.table_data, feedSourceId(ref), view.created_at, cap);
  return {
    ok: true,
    name: view.name.slice(0, 160),
    description: `Tabla que Cortex preparó con citas de un texto de tu Feed. Privada: sólo tú la ves; desaparece con su captura (${bogotaDay.format(new Date((alive.data as { purge_at: string }).purge_at))}).`,
    fields: table.fields,
    rows: table.rows,
    truncated: table.truncated,
  };
}

// ---------------------------------------------------------------------------
// El catálogo del diseñador: las tablas del Feed de quien pregunta
// ---------------------------------------------------------------------------

export interface FeedCatalogItem {
  id: string;
  name: string;
  description: string;
  fields: TrackerField[];
  rowCount: number;
  /** Hasta tres filas, para que el diseñador vea cómo son los datos. */
  sample: ViewRow[];
}

/**
 * Las tablas del Feed de `viewerId`, las más recientes primero: las fuentes
 * conectadas (por su última lectura), las capturas sueltas que no son de una
 * conexión (la conexión ya las cubre y además se actualiza) y las vistas
 * preparadas vigentes. Todo con `viewerId` como dueño; nada de otra persona.
 */
export async function listFeedSources(
  db: SupabaseClient,
  viewerId: string,
  limit = FEED_CATALOG_LIMIT,
): Promise<FeedCatalogItem[]> {
  const now = new Date().toISOString();
  const [conns, captures, prepared] = await Promise.all([
    db
      .from('feed_sources')
      .select('id, name, latest_attachment_id, enabled, updated_at')
      .eq('actor_id', viewerId)
      .order('updated_at', { ascending: false })
      .limit(limit),
    db
      .from('chat_attachments')
      .select(`${CONTENT_COLUMNS}, feed_source_id`)
      .eq('created_by', viewerId)
      .not('feed_kind', 'is', null)
      .is('feed_source_id', null)
      .not('feed_tables', 'is', null)
      .gt('purge_at', now)
      .order('created_at', { ascending: false })
      .limit(limit),
    db
      .from('feed_prepared_views')
      .select('id, source_id, name, table_data, created_at')
      .eq('actor_id', viewerId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);
  if (conns.error) throw conns.error;
  if (captures.error) throw captures.error;
  if (prepared.error) throw prepared.error;

  const items: FeedCatalogItem[] = [];
  const add = (id: string, name: string, description: string, sheet: SheetData, at: string) => {
    const table = feedTable(sheet, id, at, 2000);
    if (!table.fields.length) return;
    items.push({
      id,
      name: name.slice(0, 160),
      description,
      fields: table.fields,
      rowCount: table.rows.length,
      sample: table.rows.slice(0, 3),
    });
  };

  const connections = (conns.data ?? []) as Array<{
    id: string;
    name: string;
    latest_attachment_id: string | null;
  }>;
  const latestIds = connections
    .map((c) => c.latest_attachment_id)
    .filter((id): id is string => Boolean(id));
  const latest = new Map<string, AttachmentContent>();
  if (latestIds.length) {
    const read = await db
      .from('chat_attachments')
      .select(CONTENT_COLUMNS)
      .in('id', latestIds)
      .eq('created_by', viewerId)
      .not('feed_kind', 'is', null)
      .gt('purge_at', now);
    if (read.error) throw read.error;
    for (const a of (read.data ?? []) as AttachmentContent[]) latest.set(a.id, a);
  }
  for (const c of connections) {
    const capture = c.latest_attachment_id ? latest.get(c.latest_attachment_id) : undefined;
    const sheets = capture?.feed_tables ?? [];
    sheets.slice(0, 20).forEach((sheet, i) => {
      if (!capture) return;
      add(
        feedSourceId({ kind: 'connection', id: c.id, sheet: i }),
        sheets.length > 1 ? `${c.name} · ${sheet.name}` : c.name,
        'Fuente conectada del Feed: sigue su última lectura y cambia sola cuando se sincroniza. Privada.',
        sheet,
        capture.created_at,
      );
    });
  }

  for (const capture of (captures.data ?? []) as AttachmentContent[]) {
    const sheets = Array.isArray(capture.feed_tables) ? capture.feed_tables : [];
    sheets
      .slice(0, 20)
      .forEach((sheet, i) =>
        add(
          feedSourceId({ kind: 'entry', id: capture.id, sheet: i }),
          sheets.length > 1 ? `${capture.filename} · ${sheet.name}` : capture.filename,
          `Captura fija del Feed; vence el ${bogotaDay.format(new Date(capture.purge_at))}. Privada.`,
          sheet,
          capture.created_at,
        ),
      );
  }

  const views = (prepared.data ?? []) as Array<{
    id: string;
    source_id: string;
    name: string;
    table_data: SheetData;
    created_at: string;
  }>;
  if (views.length) {
    const alive = await db
      .from('chat_attachments')
      .select('id')
      .in('id', [...new Set(views.map((v) => v.source_id))])
      .eq('created_by', viewerId)
      .not('feed_kind', 'is', null)
      .gt('purge_at', now);
    if (alive.error) throw alive.error;
    const ok = new Set(((alive.data ?? []) as Array<{ id: string }>).map((a) => a.id));
    for (const v of views)
      if (ok.has(v.source_id) && Array.isArray(v.table_data?.rows))
        add(
          feedSourceId({ kind: 'prepared', id: v.id, sheet: 0 }),
          v.name,
          'Tabla que Cortex preparó con citas de un texto del Feed. Privada.',
          v.table_data,
          v.created_at,
        );
  }
  return items.slice(0, limit);
}
