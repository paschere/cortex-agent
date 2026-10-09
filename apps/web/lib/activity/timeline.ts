import { describeEvent, howOf, isTimelineEvent } from './sentences';
import type { ActivityEvent, ActivityGroup, ActivityHow } from './types';
import { canUndo, undoPlanFor } from './undo';

export interface ActivityLine {
  key: string;
  /** Todas las filas de auditoría que esta línea resume (más nueva primero). */
  eventIds: string[];
  /** Cuándo (la fila más nueva). */
  at: string;
  /** `yyyy-mm-dd` en hora de Bogotá. */
  day: string;
  text: string;
  group: ActivityGroup;
  how: ActivityHow;
  failed: boolean;
  userId: string;
  /** Texto del botón; `null` = no se puede deshacer (o ya se deshizo). */
  undoLabel: string | null;
}

export interface DayGroup {
  day: string;
  label: string;
  lines: ActivityLine[];
}

const TZ = 'America/Bogota';

export function bogotaDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
}

export function dayLabel(day: string, now: Date = new Date()): string {
  const today = bogotaDay(now.toISOString());
  const yesterday = bogotaDay(new Date(now.getTime() - 86_400_000).toISOString());
  if (day === today) return 'Hoy';
  if (day === yesterday) return 'Ayer';
  const text = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${day}T12:00:00-05:00`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Las filas (de más nueva a más vieja) hechas frases. Las seguidas que dicen
 * lo mismo («Anoté una fila en Vuelos» ×3) se juntan en una; sólo se ofrece
 * deshacer la línea si TODAS sus filas se pueden deshacer.
 */
export function buildTimeline(
  events: readonly ActivityEvent[],
  opts: { undoneIds?: ReadonlySet<string> } = {},
): ActivityLine[] {
  const undone = opts.undoneIds ?? new Set<string>();
  const lines: ActivityLine[] = [];
  const state: Array<{
    collapseKey: string | null;
    allUndoable: boolean;
    labels: string[];
    build: ((n: number) => string) | null;
  }> = [];

  for (const ev of events) {
    if (!isTimelineEvent(ev)) continue;
    const d = describeEvent(ev);
    const how = howOf(ev);
    const day = bogotaDay(ev.created_at);
    const failed = ev.status === 'error';
    const undoable = canUndo(ev, undone);
    const plan = undoable ? undoPlanFor(ev) : null;
    const prev = lines[lines.length - 1];
    const prevState = state[state.length - 1];
    const key = d.collapse?.key ?? null;
    if (
      prev &&
      prevState &&
      key &&
      prevState.collapseKey === key &&
      prev.day === day &&
      prev.how === how &&
      prev.userId === ev.user_id &&
      !failed &&
      !prev.failed
    ) {
      prev.eventIds.push(ev.id);
      prevState.allUndoable = prevState.allUndoable && undoable;
      if (plan) prevState.labels.push(plan.label);
      const n = prev.eventIds.length;
      prev.text = prevState.build ? prevState.build(n) : prev.text;
      prev.undoLabel = prevState.allUndoable
        ? n > 1
          ? `Deshacer las ${n}`
          : (prevState.labels[0] ?? null)
        : null;
      continue;
    }
    lines.push({
      key: ev.id,
      eventIds: [ev.id],
      at: ev.created_at,
      day,
      text: d.text,
      group: d.group,
      how,
      failed,
      userId: ev.user_id,
      undoLabel: plan?.label ?? null,
    });
    state.push({
      collapseKey: failed ? null : key,
      allUndoable: undoable,
      labels: plan ? [plan.label] : [],
      build: d.collapse?.build ?? null,
    });
  }
  return lines;
}

export function groupByDay(lines: readonly ActivityLine[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.day === line.day) last.lines.push(line);
    else groups.push({ day: line.day, label: dayLabel(line.day, now), lines: [line] });
  }
  return groups;
}

// --- Resumen de la semana ------------------------------------------------------

export interface WeeklyCounts {
  emails: number;
  rowsCreated: number;
  approvals: number;
  auto: number;
  errors: number;
  total: number;
}

export function weeklyCounts(
  events: readonly ActivityEvent[],
  now: Date = new Date(),
): WeeklyCounts {
  const since = now.getTime() - 7 * 86_400_000;
  const out: WeeklyCounts = {
    emails: 0,
    rowsCreated: 0,
    approvals: 0,
    auto: 0,
    errors: 0,
    total: 0,
  };
  for (const ev of events) {
    if (new Date(ev.created_at).getTime() < since) continue;
    if (!isTimelineEvent(ev) || ev.tool_id === 'activity.undo') continue;
    out.total += 1;
    if (ev.status === 'error') {
      out.errors += 1;
      continue;
    }
    const d = describeEvent(ev);
    if (d.group === 'email' && /send|mand|env/i.test(ev.tool_id)) out.emails += 1;
    if (d.collapse?.key.startsWith('rows:create:')) out.rowsCreated += 1;
    if (ev.decision === 'confirmed') out.approvals += 1;
    if (howOf(ev) === 'auto') out.auto += 1;
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «Esta semana: 12 correos, 5 filas creadas, 2 cosas que necesitaron tu aprobación». */
export function weeklySentence(c: WeeklyCounts): string {
  if (c.total === 0) return 'Esta semana Cortex todavía no ha hecho nada por ti.';
  const parts: string[] = [];
  if (c.emails) parts.push(plural(c.emails, 'correo', 'correos'));
  if (c.rowsCreated) parts.push(plural(c.rowsCreated, 'fila creada', 'filas creadas'));
  if (c.approvals)
    parts.push(
      `${plural(c.approvals, 'cosa que necesitó', 'cosas que necesitaron')} tu aprobación`,
    );
  if (c.auto) parts.push(`${plural(c.auto, 'cosa hecha', 'cosas hechas')} sin preguntar`);
  if (c.errors) parts.push(plural(c.errors, 'error', 'errores'));
  if (parts.length === 0) return `Esta semana: ${plural(c.total, 'acción', 'acciones')}.`;
  return `Esta semana: ${parts.join(', ')}.`;
}
