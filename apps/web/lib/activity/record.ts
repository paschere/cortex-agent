import { describeEvent, howOf } from './sentences';
import type { ActivityEvent, ActivityHow } from './types';

/**
 * «QUIÉN APROBÓ QUÉ» DE UN REGISTRO.
 *
 * Dado un registro (una factura, un cliente, una fila) y los eventos de
 * auditoría que ya pasaron el alcance de /actividad (`scope.ts`), deja los que
 * lo tocan: aquellos cuyo detalle guardado menciona su id (coincidencia exacta)
 * o su nombre (sólo si es lo bastante largo para no confundirse). Pura: la
 * lectura y el alcance viven en la acción de servidor.
 */

export interface RecordRef {
  ids: string[];
  /** Nombres para buscar en el detalle (número de factura, razón social…). */
  terms?: string[];
}

export interface RecordActivityLine {
  id: string;
  /** La frase: «Aprobé la factura F-102». */
  text: string;
  toolId: string;
  /** Quién: nombre o correo; «Cortex» si no hay a quién atribuir. */
  who: string;
  how: ActivityHow;
  /** «Permitido», «Aprobado por la persona», «Delegado por un permiso». */
  decision: string;
  failed: boolean;
  at: string;
}

const MIN_TERM = 4;

function haystack(event: ActivityEvent): string {
  const d = event.metadata?.detail;
  if (!d) return '';
  try {
    return JSON.stringify(d).toLowerCase();
  } catch {
    return '';
  }
}

export function eventMentions(event: ActivityEvent, ref: RecordRef): boolean {
  const text = haystack(event);
  if (!text) return false;
  for (const id of ref.ids) {
    const needle = id.trim().toLowerCase();
    if (needle.length >= 3 && text.includes(`"${needle}"`)) return true;
  }
  for (const term of ref.terms ?? []) {
    const needle = term.trim().toLowerCase();
    if (needle.length >= MIN_TERM && text.includes(needle)) return true;
  }
  return false;
}

export function decisionLabel(
  event: Pick<ActivityEvent, 'decision' | 'surface' | 'mandate_id'>,
): string {
  const how = howOf(event);
  if (how === 'auto')
    return event.mandate_id || event.decision === 'delegated'
      ? 'Delegado por un permiso'
      : 'Rutina programada';
  if (how === 'approved') return 'Aprobado por una persona';
  return 'Permitido';
}

export function recordActivity(
  events: readonly ActivityEvent[],
  ref: RecordRef,
  names: Readonly<Record<string, string>>,
  limit = 25,
): RecordActivityLine[] {
  const out: RecordActivityLine[] = [];
  for (const e of events) {
    if (!eventMentions(e, ref)) continue;
    out.push({
      id: e.id,
      text: describeEvent(e).text,
      toolId: e.tool_id,
      who: names[e.user_id] ?? 'Cortex',
      how: howOf(e),
      decision: decisionLabel(e),
      failed: e.status === 'error',
      at: e.created_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}
