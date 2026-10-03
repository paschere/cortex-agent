import type { GridColumn, GridFilter } from '@/components/datagrid/types';
import type { RowLookupRow } from '@cortex/agent-tools';
import { operatorLabel } from './view';

/**
 * LAS «CONSULTAS AUTOMÁTICAS» DE UNA TABLA, COMO LAS PINTA LA PANTALLA.
 *
 * Sin dependencias de servidor: lo arma la página, lo pinta el panel (cliente)
 * y lo prueban las pruebas. El estado sale de lo que la corrida dejó escrito en
 * `row_lookups` (0198): no se recalcula nada aquí.
 */

export type LookupState = 'ok' | 'error' | 'paused' | 'capped' | 'waiting';

export interface LookupCard {
  id: string;
  name: string;
  url: string;
  state: LookupState;
  /** «Cada 5 min cerca de «hora_estimada» · cada 30 min fuera». */
  cadence: string;
  /** «Fecha es hoy · Estado no es ninguno de aterrizado, cancelado». */
  filter: string;
  /** Qué escribe: «status → Estado · arrival.estimated → Hora estimada». */
  writes: string;
  credential: string | null;
  callsToday: number;
  dailyCap: number;
  perRunCap: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastCalls: number;
  lastUpdated: number;
}

export interface LookupCredentialOption {
  slug: string;
  name: string;
  host: string;
}

/** Lo que el diálogo manda para crear una consulta. */
export interface LookupDraft {
  name: string;
  urlTemplate: string;
  credential: string | null;
  mapping: Array<{ path: string; field: string; label?: string }>;
  filter: { match: 'all' | 'any'; filters: GridFilter[] };
  intervalMinutes: number;
  near: {
    field: string;
    beforeMinutes: number;
    afterMinutes: number;
    everyMinutes: number;
    outside: 'base' | 'skip';
  } | null;
  dailyCap: number;
  perRunCap: number;
}

export interface LookupPreviewView {
  ok: boolean;
  rowLabel: string | null;
  url: string | null;
  fields: Array<{ label: string; current: string | null; next: string | null }>;
  message: string | null;
}

function every(minutes: number): string {
  if (minutes < 60) return `cada ${minutes} min`;
  if (minutes === 60) return 'cada hora';
  if (minutes % 60 === 0 && minutes < 1440) return `cada ${minutes / 60} h`;
  return 'una vez al día';
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === undefined || value === null || value === '') return '';
  const text = String(value);
  return /^(hoy|today)$/i.test(text) ? 'hoy' : text;
}

/** «Estado no es ninguno de aterrizado, cancelado», para una persona. */
export function describeFilter(
  filter: { match: 'all' | 'any'; filters: GridFilter[] },
  columns: GridColumn[],
): string {
  if (!filter.filters.length) return 'Todas las filas';
  const parts = filter.filters.map((f) => {
    const col = columns.find((c) => c.key === f.key);
    const label = col?.label ?? f.key;
    const op = col ? operatorLabel(col.type, f.op) : f.op;
    const v = valueText(f.value);
    return `${label} ${op}${v ? ` ${v}` : ''}`;
  });
  return parts.join(filter.match === 'any' ? ' · o ' : ' · y ');
}

export function describeCadence(
  row: Pick<RowLookupRow, 'base_interval_minutes' | 'near'>,
  columns: GridColumn[],
): string {
  const near = row.near;
  if (!near) return every(row.base_interval_minutes);
  const label = columns.find((c) => c.key === near.field)?.label ?? near.field;
  const inside = `${every(near.everyMinutes)} desde ${near.beforeMinutes} min antes hasta ${near.afterMinutes} min después de «${label}»`;
  return near.outside === 'skip'
    ? `${inside}; fuera de ese rato no consulta`
    : `${inside}; fuera, ${every(row.base_interval_minutes)}`;
}

export function lookupCardFrom(
  row: RowLookupRow,
  columns: GridColumn[],
  nowMs: number,
): LookupCard {
  const today = new Date(nowMs - 5 * 3_600_000).toISOString().slice(0, 10);
  const callsToday = row.calls_day === today ? row.calls_today : 0;
  const state: LookupState = !row.enabled
    ? 'paused'
    : row.last_status === 'error'
      ? 'error'
      : row.last_status === 'capped' || callsToday >= row.daily_cap
        ? 'capped'
        : row.last_status === 'ok'
          ? 'ok'
          : 'waiting';
  return {
    id: row.id,
    name: row.name,
    url: row.url_template,
    state,
    cadence: describeCadence(row, columns),
    filter: describeFilter(row.filter, columns),
    writes: row.mapping
      .map((m) => `${m.path} → ${columns.find((c) => c.key === m.field)?.label ?? m.field}`)
      .join(' · '),
    credential: row.credential_name,
    callsToday,
    dailyCap: row.daily_cap,
    perRunCap: row.per_run_cap,
    nextRunAt: row.enabled ? row.next_run_at : null,
    lastRunAt: row.last_run_at,
    lastError: row.last_status === 'error' || row.last_status === 'capped' ? row.last_error : null,
    lastCalls: row.last_calls,
    lastUpdated: row.last_updated,
  };
}
