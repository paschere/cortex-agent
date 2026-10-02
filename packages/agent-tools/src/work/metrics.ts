import { addDays, dayNumber, isoWeekday, median, toDay } from '../ledger/forecast-shared';
import { colombianHolidays } from '../management/follow-up';
import type { PersonWorkStats, TeamBaseline, WorkItem, WorkPeriod, WorkPerson } from './types';

/**
 * LAS CIFRAS DEL TRABAJO: EL MOTOR PURO.
 *
 * Entra el registro de trabajo (`WorkItem[]`, el contrato de types.ts) y salen
 * las cifras de cada persona por tipo de trabajo, y las medianas del equipo.
 * No lee la base ni el reloj: misma entrada, mismo resultado.
 *
 * ===========================================================================
 * EVIDENCIA, NO UNA NOTA
 * ===========================================================================
 * Nada de aquí produce un número único de «rinde / no rinde» ni ordena a la
 * gente por una cifra. Cada persona tiene varias cifras (abiertos, vencidos,
 * cerrados, a tiempo, horas de ciclo, lo producido) y cada una se lee por su
 * lado, comparando peras con peras:
 *
 *   · por TIPO de trabajo (un despacho no se compara con un caso);
 *   · por DÍA TRABAJABLE: lunes a viernes, menos festivos de Colombia (los
 *     mismos de Gerencia, `management/follow-up.ts`) y menos los días fuera
 *     de la persona (vacaciones, incapacidad);
 *   · primero contra su propia historia y después contra la mediana del equipo.
 *
 * ===========================================================================
 * LA FOTO AL CIERRE
 * ===========================================================================
 * «Abiertos ahora» se reconstruye para el cierre del período (o `asOf`, si el
 * período todavía no termina): abierto ese día y cerrado después (o nunca).
 * Así el período anterior se mide con la foto de ESE cierre, no con la de hoy.
 *
 *   · Cancelado: no cuenta en ningún lado (no hay fecha de cancelación y no
 *     debe contar en contra).
 *   · Hecho sin `doneAt`: no se sabe cuándo, así que ni abierto ni cerrado.
 *   · A tiempo: cerrado el día del vencimiento o antes (días de Bogotá). Lo que
 *     no tenía vencimiento no entra en la tasa; `withDue` dice la base.
 *   · Vencido: abierto al cierre con vencimiento ANTES del día del cierre.
 *   · Horas de ciclo: de `openedAt` a `doneAt`. Una fecha sin hora es la
 *     medianoche de Bogotá; un instante sin zona, hora de Bogotá.
 */

// ---------------------------------------------------------------------------
// Umbrales que comparten las métricas y las señales
// ---------------------------------------------------------------------------

/** Con menos ítems que esto no se compara (ni con su historia ni con el equipo). */
export const MIN_SAMPLE = 8;
/** Días trabajables mínimos de un período para comparar cerrados por día. */
export const MIN_WORKING_DAYS = 3;
/** Personas con ese tipo de trabajo para que la mediana del equipo diga algo. */
export const MIN_TEAM = 3;

const HOUR_MS = 3_600_000;
const BOGOTA_OFFSET = '-05:00';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

/** El instante (ms) de una fecha del registro, leída en Bogotá. NaN si no se entiende. */
export function instantMs(value: string): number {
  const v = value.trim();
  if (ISO_DAY.test(v)) return Date.parse(`${v}T00:00:00${BOGOTA_OFFSET}`);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) return Date.parse(v);
  return Date.parse(`${v}${BOGOTA_OFFSET}`);
}

/** El primer instante DESPUÉS del día de corte: la foto «al cierre». */
export function snapshotEndMs(day: string): number {
  return Date.parse(`${addDays(day, 1)}T00:00:00${BOGOTA_OFFSET}`);
}

/** El día de corte: el fin del período, o `asOf` si cae antes. */
export function snapshotDay(period: WorkPeriod, asOf?: string | null): string {
  const to = toDay(period.to);
  if (!asOf) return to;
  const now = toDay(asOf);
  return now < to ? now : to;
}

/** Cantidad de días del período, contando ambos extremos. */
export function periodLength(period: WorkPeriod): number {
  return dayNumber(toDay(period.to)) - dayNumber(toDay(period.from)) + 1;
}

/** El período del mismo largo inmediatamente anterior. */
export function previousPeriod(period: WorkPeriod): WorkPeriod {
  const from = toDay(period.from);
  const len = periodLength(period);
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

export interface WorkingDayOptions {
  /** Descontar festivos de Colombia. Por defecto sí. */
  holidays?: boolean;
}

export function isHoliday(day: string): boolean {
  return colombianHolidays(Number(day.slice(0, 4))).has(day);
}

/** Lunes a viernes de [from, to], menos festivos (si aplica). */
export function weekdaysIn(from: string, to: string, opts: WorkingDayOptions = {}): string[] {
  const out: string[] = [];
  const start = toDay(from);
  const end = toDay(to);
  // Tope de dos años: un período corrupto no cuelga el cálculo.
  for (let d = start, n = 0; d <= end && n < 800; d = addDays(d, 1), n++) {
    if (isoWeekday(d) >= 6) continue;
    if (opts.holidays !== false && isHoliday(d)) continue;
    out.push(d);
  }
  return out;
}

/** Festivos de Colombia que caen entre semana en [from, to]. */
export function holidaysIn(from: string, to: string): string[] {
  const out: string[] = [];
  const end = toDay(to);
  for (let d = toDay(from), n = 0; d <= end && n < 800; d = addDays(d, 1), n++) {
    if (isoWeekday(d) < 6 && isHoliday(d)) out.push(d);
  }
  return out;
}

/** Los días fuera de la persona que sí habrían sido trabajables en [from, to]. */
export function awayWorkingDays(
  person: WorkPerson,
  from: string,
  to: string,
  opts: WorkingDayOptions = {},
): string[] {
  const working = new Set(weekdaysIn(from, to, opts));
  const away = new Set((person.awayDays ?? []).map(toDay));
  return [...away].filter((d) => working.has(d)).sort();
}

/** Días trabajables de la persona en el período, hasta el día de corte. */
export function workingDaysFor(
  person: WorkPerson,
  period: WorkPeriod,
  opts: WorkingDayOptions & { asOf?: string | null } = {},
): number {
  const end = snapshotDay(period, opts.asOf);
  const from = toDay(period.from);
  if (end < from) return 0;
  return weekdaysIn(from, end, opts).length - awayWorkingDays(person, from, end, opts).length;
}

// ---------------------------------------------------------------------------
// El estado de un ítem en una fecha
// ---------------------------------------------------------------------------

function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = toDay(value);
  return ISO_DAY.test(d) ? d : null;
}

/** ¿Estaba abierto al cierre del día `day`? */
export function isOpenAt(item: WorkItem, day: string): boolean {
  if (item.status === 'cancelled') return false;
  const opened = dayOf(item.openedAt);
  if (!opened || opened > day) return false;
  if (item.status === 'open') return true;
  // Hecho: abierto si se cerró después del corte. Sin fecha de cierre, no se sabe.
  const done = dayOf(item.doneAt);
  return done !== null && done > day;
}

/** ¿Vencido al cierre del día `day`? (abierto y con vencimiento antes de ese día). */
export function isOverdueAt(item: WorkItem, day: string): boolean {
  const due = dayOf(item.dueAt);
  return due !== null && due < day && isOpenAt(item, day);
}

/** ¿Se cerró dentro de [from, to]? */
export function isDoneIn(item: WorkItem, from: string, to: string): boolean {
  if (item.status !== 'done') return false;
  const done = dayOf(item.doneAt);
  return done !== null && done >= from && done <= to;
}

/** Horas entre abrir y cerrar; nulo si falta algo. */
export function cycleHours(item: WorkItem): number | null {
  if (!item.doneAt) return null;
  const a = instantMs(item.openedAt);
  const b = instantMs(item.doneAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, (b - a) / HOUR_MS);
}

/** Horas desde una fecha del registro hasta la foto al cierre de `day`. */
export function hoursUntilSnapshot(value: string, day: string): number | null {
  const since = instantMs(value);
  if (Number.isNaN(since)) return null;
  return Math.max(0, (snapshotEndMs(day) - since) / HOUR_MS);
}

/** Horas quieto al momento de la foto: desde el último movimiento o desde que se abrió. */
export function idleHours(item: WorkItem, day: string): number | null {
  return hoursUntilSnapshot(item.lastActivityAt ?? item.openedAt, day);
}

/** ¿Cerrado a tiempo? Nulo si no tenía vencimiento (no se mide). */
export function closedOnTime(item: WorkItem): boolean | null {
  const due = dayOf(item.dueAt);
  const done = dayOf(item.doneAt);
  if (!due || !done) return null;
  return done <= due;
}

// ---------------------------------------------------------------------------
// Cifras de una persona
// ---------------------------------------------------------------------------

export interface PersonStatsOptions extends WorkingDayOptions {
  /** «Hoy», si el período no ha terminado: la foto se toma ese día. */
  asOf?: string | null;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function matchesType(item: WorkItem, workType: string | 'all'): boolean {
  return workType === 'all' || item.workType === workType;
}

/**
 * Las cifras de una persona en un período y un tipo de trabajo (o 'all').
 * Sólo lo asignado a ella; lo cancelado no cuenta.
 */
export function personStats(
  items: readonly WorkItem[],
  person: WorkPerson,
  period: WorkPeriod,
  workType: string | 'all' = 'all',
  opts: PersonStatsOptions = {},
): PersonWorkStats {
  const from = toDay(period.from);
  const to = toDay(period.to);
  const cut = snapshotDay(period, opts.asOf);
  const mine = items.filter(
    (i) => i.assigneeId === person.id && i.status !== 'cancelled' && matchesType(i, workType),
  );

  const open = mine.filter((i) => isOpenAt(i, cut));
  const overdue = open.filter((i) => isOverdueAt(i, cut));
  const done = mine.filter((i) => isDoneIn(i, from, cut));

  const onTime = done.map(closedOnTime).filter((v): v is boolean => v !== null);
  const cycles = done.map(cycleHours).filter((v): v is number => v !== null);

  const output: Record<string, number> = {};
  for (const i of done) {
    if (typeof i.quantity !== 'number' || !Number.isFinite(i.quantity)) continue;
    const unit = i.unit?.trim() || 'unidades';
    output[unit] = round2((output[unit] ?? 0) + i.quantity);
  }

  return {
    personId: person.id,
    workType,
    period: { from, to },
    openNow: open.length,
    overdueNow: overdue.length,
    done: done.length,
    onTimeRate: onTime.length ? round2(onTime.filter(Boolean).length / onTime.length) : null,
    medianCycleHours: cycles.length ? round1(median(cycles)) : null,
    output,
    workingDays: Math.max(0, workingDaysFor(person, period, opts)),
    sample: new Set([...open, ...done].map((i) => i.id)).size,
    withDue: onTime.length,
  };
}

/** Cerrados por día trabajable; nulo si no hubo días para trabajar. */
export function donePerDay(stats: PersonWorkStats): number | null {
  return stats.workingDays > 0 ? stats.done / stats.workingDays : null;
}

/** Los tipos de trabajo presentes, en orden alfabético. */
export function workTypesOf(items: readonly WorkItem[]): string[] {
  return [...new Set(items.map((i) => i.workType))].sort((a, b) => a.localeCompare(b, 'es'));
}

// ---------------------------------------------------------------------------
// La línea base del equipo
// ---------------------------------------------------------------------------

/**
 * Medianas del equipo por tipo de trabajo (y 'all'). Entra en la mediana de un
 * tipo sólo quien tuvo trabajo de ese tipo en el período (`sample > 0`): quien
 * no despacha no baja la mediana de despachos con un cero. Cerrados por día
 * sólo de quien tuvo días trabajables.
 */
export function teamBaselines(statsList: readonly PersonWorkStats[]): TeamBaseline[] {
  const groups = new Map<string, PersonWorkStats[]>();
  for (const s of statsList) {
    if (s.sample <= 0) continue;
    const list = groups.get(s.workType) ?? [];
    list.push(s);
    groups.set(s.workType, list);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b, 'es'),
  );
  return keys.map((workType) => {
    const list = groups.get(workType) ?? [];
    const rates = list.map(donePerDay).filter((v): v is number => v !== null);
    const onTime = list.map((s) => s.onTimeRate).filter((v): v is number => v !== null);
    const cycles = list.map((s) => s.medianCycleHours).filter((v): v is number => v !== null);
    return {
      workType,
      period: list[0]?.period ?? { from: '', to: '' },
      medianOpen: median(list.map((s) => s.openNow)),
      medianDonePerDay: round2(median(rates)),
      medianOnTimeRate: onTime.length ? round2(median(onTime)) : null,
      medianCycleHours: cycles.length ? round1(median(cycles)) : null,
      people: list.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Palabras y cifras
// ---------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

/** «1,5», «14», «12.345». */
export function formatCount(n: number): string {
  return NUMBER.format(round1(n));
}

/** El plural de un tipo de trabajo: «despacho» → «despachos», «solicitud» → «solicitudes». */
export function pluralType(workType: string): string {
  const t = workType.trim();
  if (!t) return 'ítems';
  if (/s$/i.test(t)) return t;
  if (/[aeiouáéó]$/i.test(t)) return `${t}s`;
  if (/z$/i.test(t)) return `${t.slice(0, -1)}ces`;
  return `${t}es`;
}

/** «1 ítem» / «6 ítems». */
export function countOf(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * ¿El tipo de trabajo es femenino? «solicitud», «factura», «cotización», «guía»
 * sí; «despacho», «cobro», «caso» no. Heurística de terminación con las
 * excepciones comunes («día», «problema», «tema»): basta para concordar.
 */
export function isFeminine(workType: string): boolean {
  const t = workType.trim().toLowerCase();
  if (/(ema|día|mapa)$/.test(t)) return false;
  return /(a|ión|dad|tad|tud|umbre)$/.test(t);
}

/** Un tipo en singular o plural según `n`: «1 despacho», «2 solicitudes». */
export function typeNoun(workType: string, n: number): string {
  return n === 1 ? workType.trim() || 'ítem' : pluralType(workType);
}

/**
 * Concuerda un adjetivo o participio escrito en masculino singular («abierto»,
 * «vencido», «viejo») con el tipo y la cantidad: «vencidas», «abierta».
 */
export function agree(masc: string, workType: string | null, n: number): string {
  const fem = workType ? isFeminine(workType) : false;
  const base = fem && masc.endsWith('o') ? `${masc.slice(0, -1)}a` : masc;
  return n === 1 ? base : `${base}s`;
}

/** «el» / «la», «uno» / «una» según el tipo. */
export function byGender(workType: string | null, masc: string, fem: string): string {
  return workType && isFeminine(workType) ? fem : masc;
}
