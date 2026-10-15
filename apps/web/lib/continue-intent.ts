import { approvedResultsBlock, compactResult } from './approved-results';
import { type PlanInvocation, type PlanState, planFromInvocations } from './plan-state';
import { withoutNotes } from './turn-transcript';

/**
 * «SIGUE», «VA», «DALE»: CONTINÚA CON LO QUE ESTABAS HACIENDO.
 *
 * Visto en producción (2026-10-10): tras un plan a medias, la persona escribió
 * «va» y Cortex contestó «No tengo contexto de qué necesitas con "va"»; luego
 * «continua» y el turno se colgó. El historial entre turnos es texto y una
 * palabra suelta no dice nada por sí sola: el modelo no veía el plan.
 *
 * Aquí se reconoce el mensaje y se arma, sólo para el modelo, un bloque con el
 * estado del plan, lo último que se dijo y lo que falta. Puro: sin base de datos.
 */

const quitarTildes = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');

/** Palabras que, solas o en pareja, significan «continúa». */
const VOCAB = new Set([
  'sigue',
  'siga',
  'sigamos',
  'seguir',
  'continua',
  'continue',
  'continuar',
  'continuemos',
  'va',
  'vale',
  'vamos',
  'dale',
  'ok',
  'okay',
  'okey',
  'oki',
  'listo',
  'lista',
  'hagale',
  'hazlo',
  'hazla',
  'adelante',
  'si',
  'sip',
  'claro',
  'bueno',
  'perfecto',
  'procede',
  'proceda',
  'avanza',
  'avance',
  'con',
  'eso',
  'ya',
  'por',
  'favor',
  'pues',
  'entonces',
  'cortex',
  'que',
  'sea',
  'lo',
  'de',
  'estabas',
  'haciendo',
  'tu',
  'plan',
  'el',
  'siguiente',
  'paso',
]);

/** Al menos una de estas debe estar: «con eso» o «por favor» solos no son continuar. */
const CORE = new Set([
  'sigue',
  'siga',
  'sigamos',
  'seguir',
  'continua',
  'continue',
  'continuar',
  'continuemos',
  'va',
  'vale',
  'vamos',
  'dale',
  'ok',
  'okay',
  'okey',
  'oki',
  'listo',
  'lista',
  'hagale',
  'hazlo',
  'hazla',
  'adelante',
  'si',
  'sip',
  'claro',
  'bueno',
  'perfecto',
  'procede',
  'proceda',
  'avanza',
  'avance',
]);

const MAX_WORDS = 6;

/** ¿El mensaje es sólo una señal de «continúa»? */
export function isContinuationMessage(message: string): boolean {
  const normal = quitarTildes(message.toLowerCase())
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/(.)\1{2,}/g, '$1')
    .trim();
  if (!normal) return false;
  const words = normal.split(/\s+/);
  if (words.length > MAX_WORDS) return false;
  if (!words.every((w) => VOCAB.has(w))) return false;
  return words.some((w) => CORE.has(w));
}

export interface ContinuationInput {
  /** El texto de la última respuesta del asistente (puede traer la nota de corte). */
  lastAssistantText: string;
  /** `tool_results` de las últimas respuestas del asistente, de la más vieja a la más nueva. */
  toolResultsOldestFirst: readonly unknown[];
}

interface ToolResultEntry {
  toolCallId?: unknown;
  toolName?: unknown;
  result?: unknown;
}

/** El plan vigente a partir de los resultados guardados de varias respuestas. */
export function planFromStoredResults(
  toolResultsOldestFirst: readonly unknown[],
): PlanState | null {
  const invocations: PlanInvocation[] = [];
  for (const group of toolResultsOldestFirst) {
    if (!Array.isArray(group)) continue;
    for (const entry of group as ToolResultEntry[]) {
      if (!entry || typeof entry.toolName !== 'string') continue;
      invocations.push({
        toolCallId: typeof entry.toolCallId === 'string' ? entry.toolCallId : '',
        toolName: entry.toolName,
        state: 'result',
        result: entry.result,
      });
    }
  }
  return planFromInvocations(invocations);
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'pendiente',
  in_progress: 'en curso',
  done: 'hecho',
  failed: 'falló',
  skipped: 'omitido',
};

/**
 * El plan vigente en texto para el modelo, con lo que falta. Se pega también tras
 * una aprobación (tarjeta, lote o plan) para que el turno siga el plan hasta el final.
 */
export function planStateText(plan: PlanState): string {
  const lines = [`Plan vigente: ${plan.title}`];
  for (const s of plan.steps) {
    lines.push(
      `- [${STATUS_LABEL[s.status] ?? s.status}] ${s.id}: ${s.label}${s.note ? ` (${s.note})` : ''}`,
    );
  }
  const open = plan.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress');
  lines.push(
    open.length > 0
      ? `Falta: ${open.map((s) => s.id).join(', ')}. Sigue por el primero y avanza hasta cerrar todos los pasos o hasta que necesites algo de la persona; marca cada paso con cortex.plan_update. No te detengas a confirmar lo ya hecho.`
      : 'Todos los pasos del plan están cerrados: resume en dos frases lo que quedó y qué sigue.',
  );
  return lines.join('\n');
}

/** ¿Queda algún paso por hacer en el plan? */
export function planHasOpenSteps(plan: PlanState | null): boolean {
  return Boolean(plan?.steps.some((s) => s.status === 'pending' || s.status === 'in_progress'));
}

const tail = (s: string, max: number) => (s.length > max ? `…${s.slice(-max)}` : s);

/**
 * El bloque que se pega al mensaje de «continúa». Nunca dice «no tengo
 * contexto»: si no hay plan ni trabajo a medias, lo dice con lo último que se hizo.
 */
export function continuationBlock(input: ContinuationInput): string {
  const plan = planFromStoredResults(input.toolResultsOldestFirst);
  const lines: string[] = [
    '[La persona escribió una señal corta de «continúa» (sigue / va / dale / ok…). Significa: sigue con lo que estabas haciendo. NO le preguntes qué quiere ni digas que no tienes contexto: el contexto es este bloque y la conversación.]',
  ];
  if (plan) lines.push(planStateText(plan));
  const last = input.toolResultsOldestFirst[input.toolResultsOldestFirst.length - 1];
  if (Array.isArray(last)) {
    const done = (last as ToolResultEntry[])
      .filter((e) => {
        const r = e?.result as Record<string, unknown> | undefined;
        return (
          r &&
          typeof r === 'object' &&
          !r.__requires_confirmation &&
          !r.__confirmation_in_progress &&
          typeof e.toolName === 'string' &&
          !/^cortex[._]plan/.test(e.toolName)
        );
      })
      .slice(-6)
      .map((e) => `- ${String(e.toolName)}: ${compactResult(e.result, 300)}`);
    if (done.length > 0) {
      lines.push('Lo último que ya se ejecutó (no lo repitas):', ...done);
    }
  }
  const said = input.lastAssistantText.trim();
  if (said) lines.push(`Lo último que dijiste: «${tail(said.replace(/\s+/g, ' '), 600)}»`);
  if (!plan && !said) {
    lines.push(
      'No hay trabajo pendiente visible en el hilo: dilo en una frase mencionando lo último que se habló y pregunta qué sigue.',
    );
  }
  return lines.join('\n');
}

export interface FollowOnRow {
  content?: unknown;
  tool_results?: unknown;
}

/**
 * Lo que se le pega al modelo (nunca a la persona) tras un mensaje que sólo
 * pide seguir: el aviso de una tarjeta aprobada, o un «sigue / va / dale».
 *
 * - Aprobación (tarjeta, lote o plan): lo que se ejecutó y, si hay un plan con
 *   pasos abiertos, el plan, para que el turno lo siga hasta el final.
 * - «Continúa»: el bloque completo de `continuationBlock`.
 *
 * `rowsNewestFirst` son las últimas respuestas guardadas del asistente.
 */
export function followOnBlock(
  message: string,
  rowsNewestFirst: readonly FollowOnRow[],
  isControl: boolean,
): string {
  if (rowsNewestFirst.length === 0) return '';
  const oldestFirst = [...rowsNewestFirst].reverse().map((r) => r.tool_results);
  if (isControl) {
    const parts: string[] = [];
    const approved = approvedResultsBlock(rowsNewestFirst[0]?.tool_results);
    if (approved) parts.push(approved);
    const plan = planFromStoredResults(oldestFirst);
    if (plan && planHasOpenSteps(plan)) parts.push(planStateText(plan));
    return parts.join('\n\n');
  }
  if (!isContinuationMessage(message)) return '';
  const lastText = rowsNewestFirst[0]?.content;
  return continuationBlock({
    lastAssistantText: typeof lastText === 'string' ? withoutNotes(lastText) : '',
    toolResultsOldestFirst: oldestFirst,
  });
}
