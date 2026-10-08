/**
 * LA AGENDA: DÍA, SEMANA Y MES, EN PURO CÓDIGO.
 *
 * Fechas como texto `AAAA-MM-DD` (el día de Bogotá que el cálculo ya
 * resolvió), sin `Date` local: sumar días es aritmética UTC a mediodía, así que
 * ningún cambio de hora ni zona del navegador mueve un evento de día.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (day: string) => new Date(`${day}T12:00:00Z`);

export function addDay(day: string, n: number): string {
  const d = at(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** El lunes de la semana de `day`. */
export function weekStart(day: string): string {
  return addDay(day, -((at(day).getUTCDay() + 6) % 7));
}

/** Los siete días (lunes a domingo) de la semana de `day`. */
export function weekDays(day: string): string[] {
  const start = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => addDay(start, i));
}

export interface AgendaEvent {
  id: string;
  day: string;
  time?: string | null;
}

/** Por hora (los sin hora, al final del día) y, a igual hora, por orden de llegada. */
export function sortDay<T extends AgendaEvent>(events: T[]): T[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.time && b.e.time) return a.e.time.localeCompare(b.e.time) || a.i - b.i;
      if (a.e.time) return -1;
      if (b.e.time) return 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

/** Los eventos de cada día de `days`, ya ordenados. */
export function eventsByDay<T extends AgendaEvent>(
  events: T[],
  days: string[],
): Array<{ day: string; events: T[] }> {
  const wanted = new Set(days);
  const map = new Map<string, T[]>();
  for (const e of events) {
    if (!wanted.has(e.day)) continue;
    const list = map.get(e.day);
    if (list) list.push(e);
    else map.set(e.day, [e]);
  }
  return days.map((day) => ({ day, events: sortDay(map.get(day) ?? []) }));
}

/** Navegar un paso en el modo dado, sin salirse del rango que el cálculo cubre. */
export function step(
  mode: 'day' | 'week' | 'month',
  anchor: string,
  delta: -1 | 1,
  range: { from: string; to: string },
): string {
  let next: string;
  if (mode === 'day') next = addDay(anchor, delta);
  else if (mode === 'week') next = addDay(anchor, 7 * delta);
  else {
    const d = at(`${anchor.slice(0, 7)}-01`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    next = iso(d);
  }
  if (next < range.from) return anchor;
  if (next > range.to) return anchor;
  return next;
}
