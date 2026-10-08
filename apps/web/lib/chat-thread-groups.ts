/**
 * Agrupa las conversaciones por antigüedad para la lista del chat.
 * Puro y sin dependencias: lo usa el cliente y lo prueba vitest.
 */
export interface ThreadRow {
  id: string;
  title: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export type ThreadGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';

export const THREAD_GROUP_LABEL: Record<ThreadGroupKey, string> = {
  pinned: 'Fijados',
  today: 'Hoy',
  yesterday: 'Ayer',
  week: 'Últimos 7 días',
  month: 'Este mes',
  older: 'Antes',
};

const ORDER: ThreadGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'older'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function groupKeyFor(iso: string | null | undefined, now: Date): ThreadGroupKey {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return 'older';
  const today = startOfDay(now);
  const day = 86_400_000;
  const at = t.getTime();
  if (at >= today) return 'today';
  if (at >= today - day) return 'yesterday';
  if (at >= today - 7 * day) return 'week';
  if (t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth()) return 'month';
  return 'older';
}

export function threadTitle(row: Pick<ThreadRow, 'title'>): string {
  return row.title?.trim() || 'Sin título';
}

/** Quita tildes y mayúsculas para que «cartera» encuentre «Cartera vencida» y «mas» a «más». */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function groupThreads(
  rows: ThreadRow[],
  opts: { now?: Date; query?: string; pinned?: ReadonlySet<string> } = {},
): { key: ThreadGroupKey; label: string; rows: ThreadRow[] }[] {
  const now = opts.now ?? new Date();
  const q = fold((opts.query ?? '').trim());
  const buckets = new Map<ThreadGroupKey, ThreadRow[]>();
  for (const row of rows) {
    if (q && !fold(threadTitle(row)).includes(q)) continue;
    const key: ThreadGroupKey = opts.pinned?.has(row.id)
      ? 'pinned'
      : groupKeyFor(row.updated_at ?? row.created_at, now);
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }
  return ORDER.filter((k) => buckets.has(k)).map((key) => ({
    key,
    label: THREAD_GROUP_LABEL[key],
    rows: buckets.get(key) ?? [],
  }));
}
