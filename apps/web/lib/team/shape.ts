import type { WorkItem, WorkPeriod, WorkSourceKind } from '@cortex/agent-tools';

/**
 * LA FORMA DE LAS PANTALLAS DE «EQUIPO» (/team, /team/[persona], /team/yo).
 *
 * Puro y sin nada de `@cortex/agent-tools` en tiempo de ejecución: lo importan
 * también las islas de cliente (el diálogo de reasignar, el editor de días
 * fuera), y el paquete arrastra `node:crypto`. Aquí viven las reglas pequeñas
 * que la pantalla necesita decir igual en todas partes: qué período es «esta
 * semana», cómo se escribe una duración, hacia dónde apunta una flecha y si
 * eso es bueno, de dónde sale un ítem y si se puede marcar hecho desde aquí.
 *
 * Lo que NO hay aquí, a propósito: una nota, un puntaje o un orden por cifra.
 * Las personas se muestran en orden alfabético y cada cifra se lee por su lado
 * (docs/features/team-work.md).
 */

// ---------------------------------------------------------------------------
// Períodos
// ---------------------------------------------------------------------------

export type PeriodKey = 'semana' | 'pasada' | '30d';

export const PERIOD_OPTIONS: ReadonlyArray<{ key: PeriodKey; label: string }> = [
  { key: 'semana', label: 'Esta semana' },
  { key: 'pasada', label: 'Semana pasada' },
  { key: '30d', label: 'Últimos 30 días' },
];

export function readPeriodKey(raw: unknown): PeriodKey {
  return raw === 'pasada' || raw === '30d' ? raw : 'semana';
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana de `day` (semana ISO, de lunes a domingo). */
export function mondayOfIso(day: string): string {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDaysIso(day, -((wd + 6) % 7));
}

/** Días entre dos fechas `YYYY-MM-DD` (b − a). */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** El período de cada opción, con «hoy» como foto si todavía no termina. */
export function periodFor(key: PeriodKey, today: string): WorkPeriod {
  if (key === '30d') return { from: addDaysIso(today, -29), to: today };
  const monday = mondayOfIso(today);
  const from = key === 'pasada' ? addDaysIso(monday, -7) : monday;
  return { from, to: addDaysIso(from, 6) };
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «28 sep». */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`.trim();
}

/** «28 sep – 4 oct». */
export function rangeLabel(period: WorkPeriod): string {
  return `${shortDay(period.from)} – ${shortDay(period.to)}`;
}

/** El día de Bogotá de una fecha o un instante (UTC−5 todo el año). */
export function bogotaDay(value: string | null | undefined): string | null {
  if (!value) return null;
  if (ISO_DAY.test(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
}

/** El tipo de trabajo del filtro, sólo si existe en el reporte. */
export function readWorkTypeParam(raw: unknown, types: readonly string[]): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const wanted = raw.trim().toLowerCase();
  return types.find((t) => t.toLowerCase() === wanted) ?? null;
}

// ---------------------------------------------------------------------------
// Escritura de cifras (es-CO)
// ---------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const MONEY = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function formatNumber(n: number): string {
  return NUMBER.format(n);
}

/** Horas de ciclo en palabras cortas: «6 h», «1,5 días». */
export function formatHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—';
  if (hours < 1) return '< 1 h';
  if (hours < 48) return `${NUMBER.format(Math.round(hours * 10) / 10)} h`;
  return `${NUMBER.format(Math.round((hours / 24) * 10) / 10)} días`;
}

export function formatPct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** «48 guías», «$ 3.200.000». */
export function formatOutput(unit: string, value: number): string {
  return unit.toUpperCase() === 'COP' ? MONEY.format(value) : `${NUMBER.format(value)} ${unit}`;
}

export function initials(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? '?';
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// Flechas: contra su propio período anterior
// ---------------------------------------------------------------------------

/** Qué dirección es buena para esta cifra. `none` = sólo se informa. */
export type Better = 'up' | 'down' | 'none';
export type TrendTone = 'good' | 'attention' | 'neutral';

export interface Trend {
  dir: 'up' | 'down' | 'flat';
  tone: TrendTone;
  /** «antes 8». */
  before: string;
}

export function trendOf(
  now: number | null,
  before: number | null,
  better: Better,
  format: (n: number) => string = formatNumber,
): Trend | null {
  if (now === null || before === null) return null;
  const delta = now - before;
  const flat = Math.abs(delta) < 1e-9 || (before !== 0 && Math.abs(delta / before) < 0.05);
  const dir = flat ? 'flat' : delta > 0 ? 'up' : 'down';
  const tone: TrendTone =
    dir === 'flat' || better === 'none' ? 'neutral' : dir === better ? 'good' : 'attention';
  return { dir, tone, before: `antes ${format(before)}` };
}

// ---------------------------------------------------------------------------
// De dónde sale un ítem, y si se puede cerrar desde aquí
// ---------------------------------------------------------------------------

export const SOURCE_LABEL: Record<WorkSourceKind, string> = {
  management_case: 'Gerencia',
  commitment: 'Compromisos',
  tracker_row: 'Tabla',
  receivable: 'Cartera',
  approval: 'Aprobaciones',
  request: 'Solicitudes',
  routine: 'Rutina',
  manual: 'A mano',
  chat: 'Chat',
  sheet: 'Hoja',
  whatsapp: 'WhatsApp',
};

/** La pantalla donde vive el ítem, si tiene una. */
export function sourcePath(item: Pick<WorkItem, 'source'>): string | null {
  const { kind, ref, system } = item.source;
  switch (kind) {
    case 'management_case':
      return `/management?case=${encodeURIComponent(ref)}`;
    case 'commitment':
      return `/commitments/${encodeURIComponent(ref)}`;
    case 'tracker_row':
      return system ? `/trackers/${encodeURIComponent(system)}` : null;
    case 'approval':
      return '/approvals';
    default:
      return null;
  }
}

/**
 * Lo que vive SÓLO en el registro (lo anotado desde el chat, una hoja o
 * WhatsApp): su fuente es el registro, así que cerrarlo aquí es cerrarlo.
 */
export const REGISTRY_ONLY_SOURCES: readonly WorkSourceKind[] = [
  'manual',
  'chat',
  'sheet',
  'whatsapp',
  'routine',
  'request',
  'receivable',
];

/**
 * ¿Se puede marcar hecho desde «Mi semana»? Sólo lo propio y abierto, y sólo
 * cuando hay un camino que ya existe y es seguro: un compromiso se cumple como
 * en /commitments; lo que vive sólo en el registro se cierra en el registro.
 * Un asunto de Gerencia (tiene revisión), una fila de tabla (su estado es de
 * la tabla) o una aprobación (la decide quien la pidió) se abren en su fuente.
 */
export function canMarkDone(
  item: Pick<WorkItem, 'status' | 'assigneeId' | 'source'>,
  viewerId: string,
): boolean {
  if (item.status !== 'open' || item.assigneeId !== viewerId) return false;
  return item.source.kind === 'commitment' || REGISTRY_ONLY_SOURCES.includes(item.source.kind);
}

/** Lo que no se puede pasar a otra persona desde aquí (ver `reassignWorkItems`). */
export function isReassignable(item: Pick<WorkItem, 'source'>): boolean {
  return item.source.kind !== 'management_case' && item.source.kind !== 'approval';
}

// ---------------------------------------------------------------------------
// Días fuera
// ---------------------------------------------------------------------------

/** Todos los días de un rango, inclusive, hasta 120. */
export function daysInRange(from: string, to: string): string[] {
  if (!isIsoDay(from) || !isIsoDay(to) || to < from) return [];
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 120; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

/** Días seguidos juntos: «28 sep – 2 oct», «6 oct». */
export function awayRanges(days: readonly string[]): Array<{ from: string; to: string }> {
  const sorted = [...new Set(days)].filter(isIsoDay).sort();
  const out: Array<{ from: string; to: string }> = [];
  for (const d of sorted) {
    const last = out.at(-1);
    if (last && addDaysIso(last.to, 1) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

// ---------------------------------------------------------------------------
// El chat
// ---------------------------------------------------------------------------

export function chatPath(prompt: string): string {
  return `/chat?prompt=${encodeURIComponent(prompt.slice(0, 4000))}`;
}

/** Para «Escribirle»: un borrador de apoyo, nunca un reclamo, que se revisa antes de enviar. */
export function supportPrompt(name: string, context: string): string {
  return `Ayúdame a escribirle a ${name} un mensaje corto y de apoyo. Contexto: ${context} Quiero preguntarle cómo va y si necesita ayuda o que repartamos algo, sin que suene a reclamo. Dame el borrador para revisarlo antes de enviarlo.`;
}

export function recognitionPrompt(name: string, context: string): string {
  return `Ayúdame a escribirle a ${name} un mensaje corto para reconocerle esto: ${context} Que sea concreto y sincero, y que le pregunte qué le está funcionando. Dame el borrador para revisarlo antes de enviarlo.`;
}

export const CONNECT_WORK_PROMPT =
  'Quiero medir el trabajo de mi equipo: quién tiene qué pendiente, qué se cerró y qué tan a tiempo. Mira qué tablas y fuentes tengo, dime cuáles sirven (cuál campo dice quién responde, el estado y la fecha de vencimiento) y propónme cómo conectarlas antes de cambiar nada.';
