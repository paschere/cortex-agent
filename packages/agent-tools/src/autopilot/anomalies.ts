import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlanItem } from './types';

/**
 * ANOMALÍAS: LO QUE DEJÓ DE LLEGAR (colector del piloto, «Cortex habla primero»).
 *
 * Las fuentes conectadas que suelen traer filas (hojas del Feed que llenan una
 * tabla, carpetas de Drive que leen documentos) a veces se callan SIN fallar:
 * la última vuelta salió «ok» pero ya nadie sube nada, o la hoja cambió de
 * lugar. `collectProcesos` sólo ve lo que falla; esto ve lo que se queda mudo.
 *
 * Todo lo de abajo es puro (sin base ni reloj): `detectStall` y `detectDrop`
 * reciben las horas de llegada de las filas y devuelven un hecho o nada.
 * `loadAnomalySources` es la única parte que toca la base, con el handle de la
 * empresa.
 *
 * ===========================================================================
 * CUÁNDO SE CALLA UNA FUENTE (y cuándo NO)
 * ===========================================================================
 *   · Llegadas: las filas creadas con menos de 2 minutos entre sí cuentan como
 *     UNA llegada (una vuelta de sincronización trae lotes).
 *   · Intervalo habitual: la mediana de los huecos entre llegadas del mismo
 *     día (huecos de más de 12 h son la noche o el fin de semana, no el ritmo).
 *     Sin 5 huecos de historia no hay línea base y NO se dice nada.
 *   · Franjas habituales: cada (día de la semana, hora de Bogotá) en que hubo
 *     al menos una llegada en los últimos 14 días. Un domingo sin franjas no
 *     puede disparar nada, ni una mañana antes de la hora a la que siempre
 *     empieza a llegar.
 *   · Se calla si: AHORA es una franja habitual, llevan más de max(3 × el
 *     intervalo, 6 h) de reloj, y de ese tiempo más de 3 × el intervalo cae
 *     dentro de franjas habituales (el tiempo «en que debía haber llegado
 *     algo»).
 */

const BOGOTA_OFFSET_MS = 5 * 3_600_000;
const BATCH_GAP_MS = 2 * 60_000;
const SAME_DAY_GAP_MAX_MS = 12 * 3_600_000;
const MIN_GAPS = 5;
const MIN_SILENCE_MS = 6 * 3_600_000;
const STALL_FACTOR = 3;

/** Una fuente que normalmente recibe filas. */
export interface AnomalySource {
  kind: 'table_sync' | 'drive_folder';
  /** El id de la sincronización (lo que `trackers.retry_sync` recibe). */
  id: string;
  name: string;
  /** Horas (ISO) a las que se crearon filas en la tabla, de la más nueva a la más vieja. */
  rowTimes: string[];
}

export interface StallFinding {
  /** Minutos que llevan sin filas nuevas. */
  silentMinutes: number;
  /** Cada cuántos minutos suelen llegar. */
  usualMinutes: number;
  /** Cuándo llegó la última. */
  lastAt: string;
}

export interface DropFinding {
  day: string;
  count: number;
  usualCount: number;
}

function bogota(ms: number): Date {
  return new Date(ms - BOGOTA_OFFSET_MS);
}

/** La franja (día de la semana 0-6, hora 0-23) de Bogotá en la que cae un instante. */
function slotOf(ms: number): string {
  const d = bogota(ms);
  return `${d.getUTCDay()}-${d.getUTCHours()}`;
}

export function bogotaDay(ms: number): string {
  return bogota(ms).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Las llegadas (lotes colapsados), de la más vieja a la más nueva, en ms. */
export function arrivalsOf(rowTimes: string[]): number[] {
  const ms = rowTimes
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of ms) {
    const last = out[out.length - 1];
    if (last === undefined || t - last > BATCH_GAP_MS) out.push(t);
    else out[out.length - 1] = t;
  }
  return out;
}

/** Minutos de [from, to] que caen en franjas habituales. Camina de a hora. */
function activeMs(from: number, to: number, slots: Set<string>): number {
  let total = 0;
  let cursor = from;
  while (cursor < to) {
    const nextHour = Math.min(
      to,
      (Math.floor((cursor + BOGOTA_OFFSET_MS) / 3_600_000) + 1) * 3_600_000 - BOGOTA_OFFSET_MS,
    );
    if (slots.has(slotOf(cursor))) total += nextHour - cursor;
    cursor = nextHour;
  }
  return total;
}

export function detectStall(rowTimes: string[], now: Date): StallFinding | null {
  const nowMs = now.getTime();
  // Sólo la historia reciente fija el ritmo: 14 días.
  const since = nowMs - 14 * 86_400_000;
  const arrivals = arrivalsOf(rowTimes).filter((t) => t >= since && t <= nowMs);
  if (arrivals.length < MIN_GAPS + 1) return null;
  const gaps: number[] = [];
  for (let i = 1; i < arrivals.length; i++) {
    const gap = (arrivals[i] as number) - (arrivals[i - 1] as number);
    if (gap <= SAME_DAY_GAP_MAX_MS) gaps.push(gap);
  }
  if (gaps.length < MIN_GAPS) return null;
  const usual = median(gaps);
  if (usual < 60_000) return null;
  const last = arrivals[arrivals.length - 1] as number;
  const silent = nowMs - last;
  if (silent < Math.max(STALL_FACTOR * usual, MIN_SILENCE_MS)) return null;
  const slots = new Set(arrivals.map(slotOf));
  if (!slots.has(slotOf(nowMs))) return null;
  if (activeMs(last, nowMs, slots) < STALL_FACTOR * usual) return null;
  return {
    silentMinutes: Math.round(silent / 60_000),
    usualMinutes: Math.max(1, Math.round(usual / 60_000)),
    lastAt: new Date(last).toISOString(),
  };
}

/**
 * Una caída rara en los conteos diarios: AYER (un día entero) trajo menos del
 * 30 % de lo habitual, cuando lo habitual (mediana de los 7 días anteriores
 * con filas) es de al menos 20 filas. Sólo días entre semana contra días entre
 * semana, para que un domingo flojo no cuente como caída.
 */
export function detectDrop(rowTimes: string[], now: Date): DropFinding | null {
  const nowMs = now.getTime();
  const counts = new Map<string, number>();
  for (const t of rowTimes) {
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    const day = bogotaDay(ms);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const yesterdayMs = nowMs - 86_400_000;
  const yesterday = bogotaDay(yesterdayMs);
  const weekend = (ms: number) => [0, 6].includes(bogota(ms).getUTCDay());
  if (weekend(yesterdayMs)) return null;
  const before: number[] = [];
  for (let i = 2; i <= 14 && before.length < 7; i++) {
    const ms = nowMs - i * 86_400_000;
    if (weekend(ms)) continue;
    const c = counts.get(bogotaDay(ms)) ?? 0;
    if (c > 0) before.push(c);
  }
  if (before.length < 4) return null;
  const usual = median(before);
  const count = counts.get(yesterday) ?? 0;
  if (usual < 20 || count >= usual * 0.3) return null;
  return { day: yesterday, count, usualCount: Math.round(usual) };
}

/** «9 h», «2 h 30 min», «3 días». */
export function humanDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m >= 10 && minutes < 6 * 60 ? `${h} h ${m} min` : `${h} h`;
  }
  return `${Math.round(minutes / 1440)} días`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const NOUN: Record<AnomalySource['kind'], string> = {
  table_sync: 'La hoja',
  drive_folder: 'La carpeta',
};

const RETRY_NOUN: Record<AnomalySource['kind'], string> = {
  table_sync: 'la hoja',
  drive_folder: 'la carpeta',
};

/** Cuántas anomalías entran como máximo al plan de un día. */
export const ANOMALY_CAP = 6;

export function collectAnomalias(sources: AnomalySource[] | undefined, now: Date): PlanItem[] {
  const out: PlanItem[] = [];
  for (const src of sources ?? []) {
    if (out.length >= ANOMALY_CAP) break;
    const name = clip(src.name, 60);
    const stall = detectStall(src.rowTimes, now);
    if (stall) {
      out.push({
        area: 'procesos',
        title: `${NOUN[src.kind]} «${name}» dejó de traer filas`,
        why: `${NOUN[src.kind]} «${name}» lleva ${humanDuration(stall.silentMinutes)} sin filas nuevas (normalmente llegan cada ${humanDuration(stall.usualMinutes)}). La última sincronización salió sin errores, así que puede ser que la fuente no esté recibiendo datos.`,
        // Reintentar es seguro: vuelve a leer la fuente y no cambia nada más.
        proposedAction: {
          toolId: 'trackers.retry_sync',
          input: { kind: src.kind, syncId: src.id },
        },
        effect: 'internal_write',
        risk: 'low',
        // Una vez por silencio: la clave lleva el día de la última fila.
        dedupeKey: `anomalia:parada:${src.kind}:${src.id}:${stall.lastAt.slice(0, 10)}`,
        href: '/procesos',
      });
      continue;
    }
    const drop = detectDrop(src.rowTimes, now);
    if (drop) {
      out.push({
        area: 'procesos',
        title: `${NOUN[src.kind]} «${name}» trajo muy poco ayer`,
        why: `Ayer ${RETRY_NOUN[src.kind]} «${name}» trajo ${drop.count} ${drop.count === 1 ? 'fila' : 'filas'} y un día normal trae cerca de ${drop.usualCount}. Revisa si la fuente se quedó sin actualizar.`,
        // Sólo se cuenta: no hay nada seguro que reintentar sobre un día flojo.
        proposedAction: null,
        effect: null,
        risk: 'low',
        dedupeKey: `anomalia:bajon:${src.kind}:${src.id}:${drop.day}`,
        href: '/procesos',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lectura (la única parte con base de datos)
// ---------------------------------------------------------------------------

const MAX_SOURCES = 30;
const ROW_LIMIT = 1500;

interface SyncRow {
  id: string;
  tracker_id: string;
  last_status: string | null;
  folder_name?: string | null;
}

/**
 * Las fuentes activas y sin error, con las horas de creación de las filas de su
 * tabla en los últimos 15 días. Las que fallan ya las cuenta `collectProcesos`.
 */
export async function loadAnomalySources(db: SupabaseClient, now: Date): Promise<AnomalySource[]> {
  const sources: Array<{
    kind: AnomalySource['kind'];
    id: string;
    trackerId: string;
    name: string | null;
  }> = [];
  const tables = await db
    .from('tracker_syncs')
    .select('id, tracker_id, last_status')
    .eq('enabled', true)
    .eq('last_status', 'ok')
    .limit(MAX_SOURCES);
  if (tables.error) throw tables.error;
  for (const r of (tables.data ?? []) as SyncRow[])
    sources.push({ kind: 'table_sync', id: r.id, trackerId: r.tracker_id, name: null });
  const drive = await db
    .from('drive_folder_syncs')
    .select('id, tracker_id, last_status, folder_name')
    .eq('enabled', true)
    .eq('last_status', 'ok')
    .limit(MAX_SOURCES);
  if (drive.error) throw drive.error;
  for (const r of (drive.data ?? []) as SyncRow[])
    sources.push({
      kind: 'drive_folder',
      id: r.id,
      trackerId: r.tracker_id,
      name: r.folder_name ?? null,
    });
  if (!sources.length) return [];

  const trackerIds = [...new Set(sources.map((s) => s.trackerId))];
  const names = new Map<string, string>();
  const t = await db.from('trackers').select('id, name').in('id', trackerIds);
  if (t.error) throw t.error;
  for (const r of (t.data ?? []) as Array<{ id: string; name: string }>) names.set(r.id, r.name);

  const since = new Date(now.getTime() - 15 * 86_400_000).toISOString();
  const rowsByTracker = new Map<string, string[]>();
  for (const trackerId of trackerIds) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('created_at')
      .eq('tracker_id', trackerId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT);
    if (error) throw error;
    rowsByTracker.set(
      trackerId,
      ((data ?? []) as Array<{ created_at: string }>).map((r) => r.created_at),
    );
  }
  return sources.map((s) => ({
    kind: s.kind,
    id: s.id,
    name: s.name || names.get(s.trackerId) || 'sin nombre',
    rowTimes: rowsByTracker.get(s.trackerId) ?? [],
  }));
}
