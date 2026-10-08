import type { CatalogTracker } from '../../views/spec';
import { evaluateConditions } from './engine';
import type { AutomationEvent, Values } from './match';
import type { AutomationCondition, PollWindow } from './spec';

/**
 * «CADA X MINUTOS, PARA CADA FILA QUE CUMPLA…» (migración 0212): lo PURO.
 *
 * El despachador de cada minuto reclama una franja por regla (como los
 * horarios), lee las filas de la tabla y pregunta aquí cuáles toca atender:
 * las que cumplen las condiciones, están dentro de su ventana de fechas y
 * todavía no tienen corrida en la franja por fila. Sin base, sin reloj propio.
 *
 * La frecuencia mínima por fila NO necesita estado: la clave de idempotencia de
 * la corrida lleva la franja (`rowSlot`), así que una fila se atiende una vez
 * por franja aunque el despachador pase mil veces.
 */

const BOGOTA_OFFSET_MS = 5 * 3_600_000;
const HOUR_MS = 3_600_000;

/** Comienzo (UTC) de la franja de `minutes` minutos que contiene a `now`. */
export function pollSlotStart(minutes: number, now: Date): Date {
  const ms = Math.max(1, minutes) * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** ¿Toca una vuelta ahora? Sí si su franja aún no se reclamó. */
export function pollDue(everyMinutes: number, lastSlot: Date | null, now: Date): Date | null {
  const slot = pollSlotStart(everyMinutes, now);
  if (lastSlot && lastSlot.getTime() >= slot.getTime()) return null;
  return slot;
}

/** Número de la vuelta (franja) de `minutes` minutos. */
export function pollSlotIndex(minutes: number, now: Date): number {
  return Math.floor(now.getTime() / (Math.max(1, minutes) * 60_000));
}

/** La «versión» del suceso de una fila: la franja por fila, para la clave única. */
export function rowSlotVersion(perRowMinutes: number, now: Date): string {
  return pollSlotStart(perRowMinutes, now).toISOString();
}

/**
 * La hora de una fila como instante: «YYYY-MM-DD» (o con «HH:MM» / «YYYY-MM-DD
 * HH:MM» / ISO) en hora de Bogotá. Null si no se entiende.
 */
export function rowInstant(values: Values, field: string, timeField?: string): Date | null {
  const raw = String(values[field] ?? '').trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!iso) return null;
  const [, y, mo, d, hh, mm, zone] = iso;
  let hour = hh !== undefined ? Number(hh) : 0;
  let minute = mm !== undefined ? Number(mm) : 0;
  if (hh === undefined && timeField) {
    const t = String(values[timeField] ?? '')
      .trim()
      .match(/^(\d{1,2}):(\d{2})/);
    if (t) {
      hour = Number(t[1]);
      minute = Number(t[2]);
    }
  }
  if (hour > 23 || minute > 59) return null;
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, minute);
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.replace(/[^0-9]/g, '');
    const off = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0);
    return new Date(local - sign * off * 60_000);
  }
  if (zone === 'Z') return new Date(local);
  return new Date(local + BOGOTA_OFFSET_MS);
}

export function inPollWindow(values: Values, window: PollWindow | undefined, now: Date): boolean {
  if (!window) return true;
  const at = rowInstant(values, window.field, window.timeField);
  if (!at) return false;
  const t = now.getTime();
  return (
    t >= at.getTime() - window.beforeHours * HOUR_MS &&
    t <= at.getTime() + window.afterHours * HOUR_MS
  );
}

export interface PollRow {
  id: string;
  label: string;
  values: Values;
  created_at: string;
  updated_at: string;
}

export interface PollSelection {
  rows: PollRow[];
  /** Cuántas cumplían pero no cupieron en el tope de la vuelta. */
  overflow: number;
}

/**
 * Las filas que se atienden en esta vuelta: cumplen condiciones y ventana, no
 * tienen ya corrida en su franja (`alreadyQueued`: ids) y caben en `maxRows`.
 * Si sobran, el comienzo rota con el número de la vuelta.
 */
export function selectPollRows(input: {
  rows: PollRow[];
  conditions: AutomationCondition[];
  window?: PollWindow;
  tracker: CatalogTracker | null;
  alreadyQueued: ReadonlySet<string>;
  maxRows: number;
  /** Número de la vuelta (franja): hace rotar el comienzo para que ninguna fila se quede sin turno. */
  slotIndex: number;
  now: Date;
}): PollSelection {
  const ok = input.rows.filter((r) => {
    if (input.alreadyQueued.has(r.id)) return false;
    if (!inPollWindow(r.values ?? {}, input.window, input.now)) return false;
    const event: AutomationEvent = {
      kind: 'rows_poll',
      rowId: r.id,
      after: r.values ?? {},
      label: r.label,
      version: input.now.toISOString(),
      actor: { kind: 'system' },
      chain: [],
      depth: 0,
    };
    return evaluateConditions(input.conditions, event, input.tracker, input.now).ok;
  });
  ok.sort((a, b) => a.id.localeCompare(b.id));
  if (ok.length <= input.maxRows) return { rows: ok, overflow: 0 };
  // Con más filas que tope, cada vuelta empieza más adelante: todas tienen su turno.
  const start = (Math.max(0, input.slotIndex) * input.maxRows) % ok.length;
  const rows = Array.from(
    { length: input.maxRows },
    (_, i) => ok[(start + i) % ok.length] as PollRow,
  );
  return { rows, overflow: ok.length - input.maxRows };
}
