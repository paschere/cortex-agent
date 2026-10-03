import type { FeedEntry } from '@/lib/feed/shared';

/**
 * LA BANDEJA COMO BUZÓN: de qué tipo es cada cosa que llegó, por dónde llegó,
 * en qué quedó y los filtros. Puro, para probarlo sin React.
 *
 * El estado sale de lo que ya se guarda, sin columnas nuevas:
 *   · En tabla       — su fuente llena una tabla (tracker_syncs.source_id).
 *   · En el cerebro  — se guardó una copia (promoted_document_id).
 *   · Leído          — ya se consultó con Cortex (conversation_id).
 *   · Por revisar    — llegó y nadie ha hecho nada con ella todavía.
 */

export type FeedStatus = 'review' | 'read' | 'brain' | 'table';
export type FeedType =
  | 'pdf'
  | 'word'
  | 'sheet'
  | 'csv'
  | 'text'
  | 'link'
  | 'gsheet'
  | 'api'
  | 'combined';
export type FeedOrigin = 'upload' | 'link' | 'gsheet' | 'text' | 'api' | 'combined';
export type DateRange = 'today' | 'week' | 'older';

export const STATUS_LABEL: Record<FeedStatus, string> = {
  review: 'Por revisar',
  read: 'Leído',
  brain: 'En el cerebro',
  table: 'En tabla',
};

export const STATUS_TONE: Record<FeedStatus, string> = {
  review: 'bg-amber-soft text-amber',
  read: 'bg-sky-soft text-sky',
  brain: 'bg-primary-soft text-primary',
  table: 'bg-emerald-soft text-emerald',
};

export const TYPE_LABEL: Record<FeedType, string> = {
  pdf: 'PDF',
  word: 'Word',
  sheet: 'Excel',
  csv: 'CSV',
  text: 'Texto',
  link: 'Página web',
  gsheet: 'Google Sheets',
  api: 'API',
  combined: 'Fuentes cruzadas',
};

export const ORIGIN_LABEL: Record<FeedOrigin, string> = {
  upload: 'Subido',
  link: 'Enlace',
  gsheet: 'Google Sheets',
  text: 'Escrito',
  api: 'API',
  combined: 'Cruce',
};

export const DATE_LABEL: Record<DateRange, string> = {
  today: 'Hoy',
  week: 'Últimos 7 días',
  older: 'Más antiguos',
};

export interface InboxContext {
  /** Fuentes (feed_sources.id) que llenan una tabla. */
  tableSourceIds: ReadonlySet<string>;
}

export function feedStatus(entry: FeedEntry, ctx: InboxContext): FeedStatus {
  if (entry.feed_source_id && ctx.tableSourceIds.has(entry.feed_source_id)) return 'table';
  if (entry.promoted_document_id) return 'brain';
  if (entry.conversation_id) return 'read';
  return 'review';
}

const isGoogleSheet = (url: string | null) => !!url && /docs\.google\.com\/spreadsheets/.test(url);

export function feedType(entry: FeedEntry): FeedType {
  if (entry.feed_kind === 'api') return 'api';
  if (entry.feed_kind === 'combined') return 'combined';
  if (entry.feed_kind === 'url') return isGoogleSheet(entry.source_url) ? 'gsheet' : 'link';
  if (entry.feed_kind === 'text') return 'text';
  const ext = entry.filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'word';
  if (ext === 'xlsx' || ext === 'xls') return 'sheet';
  if (ext === 'csv') return 'csv';
  return 'text';
}

export function feedOrigin(entry: FeedEntry): FeedOrigin {
  switch (entry.feed_kind) {
    case 'url':
      return isGoogleSheet(entry.source_url) ? 'gsheet' : 'link';
    case 'text':
      return 'text';
    case 'api':
      return 'api';
    case 'combined':
      return 'combined';
    default:
      return 'upload';
  }
}

export function dateRange(iso: string, now: Date): DateRange {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  if (day(new Date(iso)) === day(now)) return 'today';
  return now.getTime() - Date.parse(iso) <= 7 * 86_400_000 ? 'week' : 'older';
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** «hoy 10:42», «ayer», «12 sep». */
export function shortWhen(iso: string, now: Date): string {
  const range = dateRange(iso, now);
  const d = new Date(iso);
  if (range === 'today')
    return `hoy ${d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Bogota' })}`;
  return d.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    timeZone: 'America/Bogota',
  });
}

export interface InboxFilters {
  query: string;
  type: FeedType | 'all';
  origin: FeedOrigin | 'all';
  status: FeedStatus | 'all';
  date: DateRange | 'all';
  /** Ver también las capturas anteriores de una misma fuente. */
  history: boolean;
}

export const NO_FILTERS: InboxFilters = {
  query: '',
  type: 'all',
  origin: 'all',
  status: 'all',
  date: 'all',
  history: false,
};

/** Lo más nuevo primero; de una fuente que se captura varias veces, sólo la última. */
export function latestOnly(entries: FeedEntry[], history: boolean): FeedEntry[] {
  const seen = new Set<string>();
  return [...entries]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .filter((entry) => {
      const key = entry.feed_source_id ?? entry.source_url ?? entry.id;
      if (!history && seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function filterEntries(
  entries: FeedEntry[],
  f: InboxFilters,
  ctx: InboxContext,
  now: Date,
): FeedEntry[] {
  const q = f.query.trim().toLowerCase();
  return latestOnly(entries, f.history).filter(
    (e) =>
      (!q || `${e.filename} ${e.source_url ?? ''}`.toLowerCase().includes(q)) &&
      (f.type === 'all' || feedType(e) === f.type) &&
      (f.origin === 'all' || feedOrigin(e) === f.origin) &&
      (f.status === 'all' || feedStatus(e, ctx) === f.status) &&
      (f.date === 'all' || dateRange(e.created_at, now) === f.date),
  );
}

export function countByStatus(entries: FeedEntry[], ctx: InboxContext): Record<FeedStatus, number> {
  const out: Record<FeedStatus, number> = { review: 0, read: 0, brain: 0, table: 0 };
  for (const e of latestOnly(entries, false)) out[feedStatus(e, ctx)] += 1;
  return out;
}

/** «Convertir en tabla» abre la consulta de la entrada con esta petición. */
export const TABLE_PROMPT =
  'Convierte esta fuente de mi bandeja en una tabla de la empresa. Propónme las columnas y cuál identifica cada fila, y créala sólo cuando te confirme. Si viene de una hoja de cálculo, déjala sincronizada.';

/** Cambia la petición de un enlace de consulta (`/chat/…?prompt=…`). */
export function withPrompt(href: string, prompt: string): string {
  const url = new URL(href, 'https://cortex.invalid');
  url.searchParams.set('prompt', prompt);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Lo que se pega: un enlace va como enlace; lo demás, como texto. */
export function classifyPaste(
  raw: string,
): { kind: 'url'; url: string } | { kind: 'text'; text: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\/\S+$/i.test(text)) return { kind: 'url', url: text };
  return { kind: 'text', text };
}
