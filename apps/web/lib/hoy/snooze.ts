/**
 * POSPONER EN «HOY», SIN SERVIDOR: las dos opciones y cuándo vence cada una.
 *
 * «Mañana» = mañana a las 07:00 de Bogotá. «La otra semana» = el próximo lunes
 * a las 07:00 (si hoy es lunes, el de dentro de ocho días). Una cosa pospuesta
 * no se muestra mientras `until` esté en el futuro; al pasar, vuelve sola.
 * Hora de Bogotá (UTC-5, sin cambio de hora).
 */

export type SnoozeChoice = 'tomorrow' | 'next_week';

export const SNOOZE_LABEL: Record<SnoozeChoice, string> = {
  tomorrow: 'Mañana',
  next_week: 'La otra semana',
};

export function isSnoozeChoice(value: unknown): value is SnoozeChoice {
  return value === 'tomorrow' || value === 'next_week';
}

const DAY_MS = 86_400_000;
const BOGOTA_OFFSET_MS = 5 * 3_600_000;
const MORNING_UTC_HOUR = 12; // 07:00 Bogotá

/** Medianoche (en Bogotá) del día de `now`, expresada como instante UTC. */
function bogotaMidnight(now: Date): number {
  const local = now.getTime() - BOGOTA_OFFSET_MS;
  return Math.floor(local / DAY_MS) * DAY_MS + BOGOTA_OFFSET_MS;
}

export function snoozeUntil(choice: SnoozeChoice, now: Date): Date {
  const midnight = bogotaMidnight(now);
  let days = 1;
  if (choice === 'next_week') {
    // 0 = domingo … 6 = sábado, en la fecha de Bogotá.
    const weekday = new Date(midnight - BOGOTA_OFFSET_MS).getUTCDay();
    days = (8 - weekday) % 7 || 7;
  }
  return new Date(midnight + days * DAY_MS + (MORNING_UTC_HOUR - 5) * 3_600_000);
}

export interface SnoozeRow {
  item_key: string;
  until_at: string;
}

/** Las claves que siguen pospuestas en este instante. */
export function activeSnoozeKeys(rows: readonly SnoozeRow[], now: Date): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) if (new Date(r.until_at).getTime() > now.getTime()) keys.add(r.item_key);
  return keys;
}

/** Quita lo pospuesto de una lista y cuenta cuántas escondió. */
export function withoutSnoozed<T>(
  list: readonly T[],
  keyOf: (item: T) => string,
  hidden: ReadonlySet<string>,
): { shown: T[]; hiddenCount: number } {
  const shown = list.filter((x) => !hidden.has(keyOf(x)));
  return { shown, hiddenCount: list.length - shown.length };
}

/** «mañana» o «el lunes», para decirle a la persona cuándo vuelve. */
export function snoozeWhenLabel(choice: SnoozeChoice): string {
  return choice === 'tomorrow' ? 'mañana a las 7:00' : 'el lunes a las 7:00';
}
