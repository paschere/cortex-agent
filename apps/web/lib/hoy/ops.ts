import type { ActivityLine } from '@/lib/activity/timeline';
import type { ActivityGroup, ActivityHow } from '@/lib/activity/types';

/**
 * LA FILA «OPERACIÓN» DE HOY Y LA TABLA DE LO QUE HIZO CORTEX.
 *
 * Puras: reciben conteos y filas ya leídos y los dejan listos para dibujar.
 * Un indicador sin dato de dónde sacarlo no se inventa: simplemente no sale.
 */

export interface OpsKpi {
  id: 'hecho' | 'aprobaciones' | 'errores' | 'compromisos';
  label: string;
  value: string;
  hint: string;
  /** Historia diaria (de más vieja a hoy); vacía si no hay. */
  spark: number[];
  sparkLabels: string[];
  /** Cambio relativo contra el promedio de los días anteriores; `null` = sin base. */
  ratio: number | null;
  /** ¿Subir es bueno? `null` = neutro. */
  good: boolean | null;
  alert: boolean;
  href: string;
}

export interface OpsInput {
  today: string;
  /** Corridas del piloto, de la más nueva a la más vieja; `null` = módulo apagado. */
  runs: ReadonlyArray<{ day: string; done: number; failed: number }> | null;
  approvals: { count: number; oldestDays: number | null } | null;
  commitments: { overdue: number; oldestDays: number | null } | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function series(
  runs: NonNullable<OpsInput['runs']>,
  pick: (r: { done: number; failed: number }) => number,
  days = 14,
): { values: number[]; labels: string[] } {
  const byDay = new Map(runs.map((r) => [r.day, pick(r)]));
  const sorted = [...runs].map((r) => r.day).sort();
  const last = sorted.at(-1);
  if (!last) return { values: [], labels: [] };
  const values: number[] = [];
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(`${last}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    values.push(byDay.get(key) ?? 0);
    labels.push(key);
  }
  return { values, labels };
}

/** Cambio de hoy contra el promedio de los días anteriores de la serie. */
export function changeVsAverage(values: readonly number[]): number | null {
  if (values.length < 3) return null;
  const today = values[values.length - 1] as number;
  const before = values.slice(0, -1);
  const avg = before.reduce((a, b) => a + b, 0) / before.length;
  if (avg < 0.5) return null;
  return (today - avg) / avg;
}

export function buildOps(input: OpsInput): OpsKpi[] {
  const out: OpsKpi[] = [];
  if (input.runs) {
    const done = series(input.runs, (r) => r.done);
    const failed = series(input.runs, (r) => r.failed);
    const doneToday = input.runs.find((r) => r.day === input.today)?.done ?? 0;
    const failedToday = input.runs.find((r) => r.day === input.today)?.failed ?? 0;
    const failedWeek = failed.values.slice(-7).reduce((a, b) => a + b, 0);
    out.push({
      id: 'hecho',
      label: 'Cortex hizo hoy',
      value: String(doneToday),
      hint: doneToday === 0 ? 'Todavía no he corrido hoy' : 'cosas resueltas por el piloto',
      spark: done.values,
      sparkLabels: done.labels,
      ratio: changeVsAverage(done.values),
      good: true,
      alert: false,
      href: '/actividad',
    });
    out.push({
      id: 'errores',
      label: 'Procesos con error',
      value: String(failedToday),
      hint:
        failedWeek === 0
          ? 'ninguno en 7 días'
          : `${plural(failedWeek, 'fallo', 'fallos')} en 7 días`,
      spark: failed.values,
      sparkLabels: failed.labels,
      ratio: changeVsAverage(failed.values),
      good: false,
      alert: failedToday > 0,
      href: '/actividad?filtro=errors',
    });
  }
  if (input.approvals) {
    const { count, oldestDays } = input.approvals;
    out.push({
      id: 'aprobaciones',
      label: 'Aprobaciones pendientes',
      value: String(count),
      hint:
        count === 0
          ? 'al día'
          : oldestDays === null
            ? 'esperan tu decisión'
            : oldestDays === 0
              ? 'la más vieja llegó hoy'
              : `la más vieja lleva ${plural(oldestDays, 'día', 'días')}`,
      spark: [],
      sparkLabels: [],
      ratio: null,
      good: null,
      alert: (oldestDays ?? 0) >= 3,
      href: '/approvals',
    });
  }
  if (input.commitments) {
    const { overdue, oldestDays } = input.commitments;
    out.push({
      id: 'compromisos',
      label: 'Compromisos vencidos',
      value: String(overdue),
      hint:
        overdue === 0
          ? 'ninguno vencido'
          : oldestDays
            ? `el más viejo, hace ${plural(oldestDays, 'día', 'días')}`
            : 'vencidos',
      spark: [],
      sparkLabels: [],
      ratio: null,
      good: null,
      alert: overdue > 0,
      href: '/commitments',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

export interface ActivityRowView {
  id: string;
  eventIds: string[];
  /** «Hoy 14:32» / «Ayer 09:05» / «3 oct 16:10». */
  when: string;
  text: string;
  /** Sobre qué: «Correo», «Plata», «Tabla»… */
  on: string;
  /** Quién: «Solo, con permiso» / «Aprobado por ti» / «Pedido por Ana». */
  who: string;
  failed: boolean;
  undoLabel: string | null;
}

export const GROUP_LABEL: Record<ActivityGroup, string> = {
  email: 'Correo',
  message: 'Mensaje',
  rows: 'Tabla',
  calendar: 'Calendario',
  money: 'Plata',
  document: 'Documento',
  view: 'Vista',
  other: 'Otro',
};

export function whoPhrase(how: ActivityHow, actor: string | null): string {
  const name = actor ?? 'ti';
  if (how === 'auto') return 'Solo, con permiso';
  if (how === 'approved') return `Aprobado por ${name}`;
  return `Pedido por ${name}`;
}

const TZ = 'America/Bogota';

export function whenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(x);
  const hm = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  if (day(d) === day(now)) return `Hoy ${hm}`;
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return `Ayer ${hm}`;
  const date = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ,
    day: 'numeric',
    month: 'short',
  }).format(d);
  return `${date.replace('.', '')} ${hm}`;
}

export function activityRows(
  lines: readonly ActivityLine[],
  opts: { meId: string; names?: Record<string, string>; now?: Date; limit?: number },
): ActivityRowView[] {
  return lines.slice(0, opts.limit ?? 8).map((l) => ({
    id: l.key,
    eventIds: l.eventIds,
    when: whenLabel(l.at, opts.now),
    text: l.text,
    on: GROUP_LABEL[l.group],
    who: whoPhrase(
      l.how,
      l.userId === opts.meId ? null : (opts.names?.[l.userId] ?? 'otra persona'),
    ),
    failed: l.failed,
    undoLabel: l.undoLabel,
  }));
}
