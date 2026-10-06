import type { GridRow } from '@/components/datagrid/types';
import { type TrackerEntryLike, UPDATED_KEY, trackerGridRow } from './trackers';

/**
 * LO QUE LLEGA EN VIVO A UNA TABLA, SIN TOCAR LA RED.
 *
 * La pantalla pregunta cada ~15 s qué filas se crearon o cambiaron
 * (`/api/trackers/<slug>/changes`). Aquí se decide qué de eso es de verdad
 * novedad (el servidor devuelve un poco de traslape a propósito, y las propias
 * ediciones de la persona vuelven también), cómo se mezcla en la grilla y qué
 * dice el aviso. Pura: la prueban los tests y la usa la pantalla.
 */

/** Una fila como la devuelve el endpoint. */
export interface ChangedRow {
  id: string;
  label: string;
  created_at: string;
  updated_at: string;
  duplicate_flagged: boolean;
  values: Record<string, string | number>;
}

export interface ChangesResponse {
  rows: ChangedRow[];
  /** Hubo más cambios que el tope: la pantalla vuelve a preguntar enseguida. */
  truncated: boolean;
  /** Hora del servidor: el `since` de la próxima pregunta. */
  now: string;
}

export interface MergeResult {
  rows: GridRow[];
  /** Ids que titilan: nuevas o cambiadas por alguien más. */
  fresh: string[];
  created: number;
  changed: number;
  /** De las que titilan, cuántas están marcadas como duplicado. */
  duplicates: number;
}

const toEntry = (c: ChangedRow): TrackerEntryLike => ({
  id: c.id,
  label: c.label,
  values: c.values,
  created_at: c.created_at,
  updated_at: c.updated_at,
  duplicate_flagged: c.duplicate_flagged,
});

/**
 * Mezcla los cambios en las filas que ya hay. Las nuevas van arriba (la tabla
 * se lee «lo más reciente primero»); las que ya estaban se reemplazan en su
 * sitio para no mover filas bajo el cursor. Una fila cuya `_updated_at` ya es
 * la que se tenía no es novedad. `mine` son las filas que esta misma persona
 * acaba de escribir: se integran pero no avisan.
 */
export function mergeChanges(
  current: GridRow[],
  changes: ChangedRow[],
  mine: ReadonlySet<string> = new Set(),
): MergeResult {
  const index = new Map(current.map((r, i) => [r.id, i]));
  const next = [...current];
  const prepend: GridRow[] = [];
  const fresh: string[] = [];
  let created = 0;
  let changed = 0;
  let duplicates = 0;
  // Del más viejo al más nuevo, para que arriba quede lo último.
  const ordered = [...changes].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  for (const c of ordered) {
    const row = trackerGridRow(toEntry(c));
    const at = index.get(c.id);
    if (at === undefined) {
      prepend.unshift(row);
      index.set(c.id, -1);
      if (!mine.has(c.id)) {
        created++;
        fresh.push(c.id);
        if (c.duplicate_flagged) duplicates++;
      }
      continue;
    }
    if (at < 0) {
      // Dos versiones de la misma fila nueva en una respuesta: queda la última.
      const p = prepend.findIndex((r) => r.id === c.id);
      if (p >= 0) prepend[p] = row;
      continue;
    }
    const before = next[at];
    if (
      before?.values[UPDATED_KEY] === c.updated_at &&
      Boolean(before.alert) === c.duplicate_flagged
    )
      continue;
    next[at] = row;
    if (!mine.has(c.id)) {
      changed++;
      fresh.push(c.id);
      // Cuenta sólo si ESTE cambio la volvió duplicado, no si ya lo era.
      if (c.duplicate_flagged && !before?.alert) duplicates++;
    }
  }
  return { rows: [...prepend, ...next], fresh, created, changed, duplicates };
}

/** El texto del toast: «2 filas nuevas en Guías · 1 marcada Duplicado». */
export function summarizeChanges(
  r: Pick<MergeResult, 'created' | 'changed' | 'duplicates'>,
  tableName: string,
): string {
  const parts: string[] = [];
  if (r.created) parts.push(`${r.created} ${r.created === 1 ? 'fila nueva' : 'filas nuevas'}`);
  if (r.changed) parts.push(`${r.changed} ${r.changed === 1 ? 'fila cambió' : 'filas cambiaron'}`);
  if (!parts.length) return '';
  const head = `${parts.join(' y ')} en ${tableName}`;
  if (!r.duplicates) return head;
  return `${head} · ${r.duplicates} ${r.duplicates === 1 ? 'marcada' : 'marcadas'} Duplicado`;
}

// ---------------------------------------------------------------------------
// Avisos por tabla y por persona
// ---------------------------------------------------------------------------

export type AlertMode = 'off' | 'flash' | 'toast' | 'sound';

export const ALERT_MODES: Array<{ value: AlertMode; label: string }> = [
  { value: 'off', label: 'Apagados' },
  { value: 'flash', label: 'Sólo titilar' },
  { value: 'toast', label: 'Toast' },
  { value: 'sound', label: 'Toast y sonido' },
];

export interface AlertPrefs {
  mode: AlertMode;
  /** Notificación del sistema cuando la pestaña no está a la vista. */
  system: boolean;
}

export const DEFAULT_ALERTS: AlertPrefs = { mode: 'flash', system: false };

export const alertsKey = (slug: string) => `cortex:tracker-alerts:${slug}`;

/** Lo guardado en localStorage → preferencias; cualquier cosa rara vuelve al default. */
export function parseAlerts(raw: string | null | undefined): AlertPrefs {
  if (!raw) return DEFAULT_ALERTS;
  try {
    const v = JSON.parse(raw) as Partial<AlertPrefs> | null;
    const mode = ALERT_MODES.some((m) => m.value === v?.mode) ? (v?.mode as AlertMode) : 'flash';
    return { mode, system: v?.system === true };
  } catch {
    return DEFAULT_ALERTS;
  }
}

/** Siguiente `since`: el `now` del servidor con un traslape para no perder cambios en vuelo. */
export function nextSince(now: string, overlapMs = 3000): string {
  const t = Date.parse(now);
  return Number.isNaN(t) ? now : new Date(t - overlapMs).toISOString();
}

// ---------------------------------------------------------------------------
// «Nuevo» en el índice: cuándo vio esta persona cada tabla por última vez
// ---------------------------------------------------------------------------

export const seenKey = (slug: string) => `cortex:tracker-seen:${slug}`;

export function markSeen(slug: string, at: string = new Date().toISOString()) {
  try {
    window.localStorage.setItem(seenKey(slug), at);
  } catch {
    // Sin localStorage: no hay punto «nuevo», nada más.
  }
}

/**
 * ¿La tabla cambió después de que esta persona la vio? Sin visita registrada no
 * hay punto: nunca vio la tabla, así que no hay «desde cuándo» que comparar.
 */
export function hasNewSince(seen: string | null, changedAt: string): boolean {
  if (!seen) return false;
  const a = Date.parse(seen);
  const b = Date.parse(changedAt);
  return !Number.isNaN(a) && !Number.isNaN(b) && b > a;
}
