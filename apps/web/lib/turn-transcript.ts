import { type StepLike, type StoredPart, buildStoredParts, capStoredParts } from './message-parts';

/**
 * LO QUE EL TURNO LLEVA PRODUCIDO, ANOTADO MIENTRAS PASA.
 *
 * ===========================================================================
 * POR QUÉ NO SE LEE DE `result.text` / `result.steps`
 * ===========================================================================
 * Las promesas de `streamText` (ai 4.3) se resuelven SÓLO en el `flush` del
 * stream, y sólo si hubo al menos un paso terminado. Si el stream ERRA —un
 * abort, la API que rechaza el historial en el primer paso, la red— nunca se
 * resuelven ni se rechazan. La ruta las esperaba dentro de `after()`, así que
 * un turno fallido dejaba la función colgada hasta que Vercel la mataba en
 * 300 s («Task timed out»), sin guardar nada. Y cuando el error llegaba como
 * parte del stream (NoSuchToolError, un `overloaded` a mitad) el flush sí
 * corría, con texto vacío: se guardaba un mensaje del asistente VACÍO, y la API
 * rechazaba desde entonces cada turno de esa conversación con «text content
 * blocks must be non-empty».
 *
 * Aquí se anota cada pedazo desde `onChunk`/`onStepFinish`, que corren en
 * cualquier caso, y la persistencia lee de aquí. Lo que se alcanzó a producir
 * —texto, razonamiento, herramientas con su resultado— nunca depende de que el
 * turno termine bien.
 */

type Chunk =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'reasoning'; textDelta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; args?: unknown; result: unknown }
  | { type: string };

interface OpenStep {
  text: string;
  reasoning: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults: { toolCallId: string; toolName: string; args?: unknown; result: unknown }[];
}

const emptyStep = (): OpenStep => ({ text: '', reasoning: '', toolCalls: [], toolResults: [] });

export class TurnTranscript {
  private done: OpenStep[] = [];
  private open: OpenStep = emptyStep();

  onChunk(chunk: Chunk): void {
    switch (chunk.type) {
      case 'text-delta':
        this.open.text += (chunk as { textDelta: string }).textDelta ?? '';
        break;
      case 'reasoning':
        this.open.reasoning += (chunk as { textDelta: string }).textDelta ?? '';
        break;
      case 'tool-call': {
        const c = chunk as { toolCallId: string; toolName: string; args: unknown };
        this.open.toolCalls.push({ toolCallId: c.toolCallId, toolName: c.toolName, args: c.args });
        break;
      }
      case 'tool-result': {
        const r = chunk as {
          toolCallId: string;
          toolName: string;
          args?: unknown;
          result: unknown;
        };
        this.open.toolResults.push({
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          args: r.args,
          result: r.result,
        });
        break;
      }
      default:
        break;
    }
  }

  /** Cierra el paso en curso. Devuelve si el paso ejecutó herramientas. */
  onStepFinish(): boolean {
    const step = this.open;
    this.open = emptyStep();
    const hadTools = step.toolCalls.length > 0;
    if (step.text || step.reasoning || hadTools) this.done.push(step);
    return hadTools;
  }

  /** Los pasos cerrados más el abierto, si tiene algo. */
  steps(): StepLike[] {
    const open = this.open;
    const all =
      open.text || open.reasoning || open.toolCalls.length > 0 ? [...this.done, open] : this.done;
    return all.map((s) => ({
      text: s.text,
      reasoning: s.reasoning,
      toolCalls: s.toolCalls,
      toolResults: s.toolResults,
    }));
  }
}

// ---------------------------------------------------------------------------
// LAS NOTAS DE UN TURNO INTERRUMPIDO
//
// Viajan dentro de `content` (y como última parte de texto) para que la persona
// sepa qué pasó al reabrir el hilo, y para que el siguiente turno sepa que hay
// trabajo a medias que retomar (`isInterruptedContent`). Se escriben en cursiva
// con un formato fijo para poder reconocerlas y quitarlas al comparar.
// ---------------------------------------------------------------------------

export type TurnOutcome = 'complete' | 'deadline' | 'client' | 'error' | 'pending';

export const INTERRUPTION_NOTES: Record<Exclude<TurnOutcome, 'complete'>, string> = {
  deadline:
    'Se me acabó el tiempo de este turno. Guardé lo que alcancé a hacer: escríbeme «sigue» y continúo desde aquí sin repetirlo.',
  client: 'Respuesta detenida. Si quieres que continúe, escríbeme «sigue».',
  error:
    'No pude terminar esta respuesta por un error. Lo que alcancé a hacer quedó guardado: escríbeme «sigue» y retomo desde aquí.',
  // Lo que queda escrito MIENTRAS el turno corre (puntos de control). Si la
  // función muere sin llegar al final, esto es lo que se lee después.
  pending:
    'Esta respuesta se cortó antes de terminar. Escríbeme «sigue» y continúo desde aquí sin repetir lo que ya hice.',
};

export const formatNote = (note: string) => `_${note}_`;

const NOTE_PATTERNS = Object.values(INTERRUPTION_NOTES).map(formatNote);

export function isInterruptedContent(content: string | null | undefined): boolean {
  if (!content) return false;
  return NOTE_PATTERNS.some((n) => content.includes(n));
}

/** El texto sin las notas de interrupción, recortado: lo que se compara. */
export function withoutNotes(content: string): string {
  let out = content;
  for (const n of NOTE_PATTERNS) out = out.split(n).join('');
  return out.trim();
}

export interface AssistantRecord {
  content: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults: { toolCallId: string; toolName: string; args?: unknown; result: unknown }[];
  parts: StoredPart[] | null;
}

/**
 * La fila del asistente que se guarda, o `null` si no hay NADA que guardar.
 *
 * LA REGLA: nunca un mensaje del asistente sin contenido. Un turno que no
 * produjo ni texto ni herramientas no deja fila (la pregunta ya quedó guardada,
 * y el siguiente turno la ve). Uno interrumpido lleva siempre su nota, así que
 * su `content` nunca está vacío. El único `content` vacío posible es el de un
 * turno COMPLETO que sólo llamó herramientas (una propuesta esperando
 * confirmación): ésa trae sus `parts`, y `sanitizeHistory` lo omite del hilo.
 */
export function buildAssistantRecord(
  steps: readonly StepLike[],
  outcome: TurnOutcome,
): AssistantRecord | null {
  const text = steps
    .map((s) => s.text ?? '')
    .join('')
    .trim();
  const toolCalls = steps.flatMap((s) => (s.toolCalls ?? []) as AssistantRecord['toolCalls']);
  const toolResults = steps.flatMap((s) => (s.toolResults ?? []) as AssistantRecord['toolResults']);
  if (!text && toolCalls.length === 0) return null;

  let parts: StoredPart[] | null = null;
  try {
    const built = buildStoredParts(steps);
    parts = built ? capStoredParts(built) : null;
  } catch {
    parts = null;
  }

  if (outcome === 'complete') return { content: text, toolCalls, toolResults, parts };

  const note = formatNote(INTERRUPTION_NOTES[outcome]);
  const content = text ? `${text}\n\n${note}` : note;
  // Con `parts` la burbuja se dibuja desde ellas y no desde `content`: la nota
  // va también ahí, de última, o al reabrir no se vería.
  if (parts) parts = [...parts, { type: 'text', text: note }];
  return { content, toolCalls, toolResults, parts };
}

// ---------------------------------------------------------------------------
// EL TRABAJO YA HECHO, PARA QUE «SIGUE» NO LO REPITA
//
// El historial que ve el modelo es sólo texto (`messages.content`). Para un
// turno interrumpido eso no basta: las herramientas que ya corrieron —la hoja
// leída, la carpeta recorrida— se perderían y el modelo las volvería a pedir,
// que es justo lo que volvería a agotar el tiempo. Así que al último turno
// interrumpido se le pega un resumen de sus resultados, recortado.
// ---------------------------------------------------------------------------

export const DIGEST_PER_RESULT = 2_500;
export const DIGEST_TOTAL = 12_000;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[no serializable]';
  }
}

/** Resumen de las herramientas de un turno guardado, desde sus `parts`. */
export function digestToolWork(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const lines: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; toolInvocation?: Record<string, unknown> };
    if (p.type !== 'tool-invocation' || !p.toolInvocation) continue;
    const inv = p.toolInvocation;
    const name = typeof inv.toolName === 'string' ? inv.toolName : 'herramienta';
    const args = clip(json(inv.args), 300);
    const line =
      inv.state === 'result'
        ? `- ${name}(${args}) → ${clip(json(inv.result), DIGEST_PER_RESULT)}`
        : `- ${name}(${args}) → sin resultado: se cortó antes de terminar`;
    if (total + line.length > DIGEST_TOTAL) {
      lines.push('- … (más resultados omitidos por tamaño)');
      break;
    }
    lines.push(line);
    total += line.length;
  }
  if (lines.length === 0) return '';
  return (
    '<trabajo-ya-hecho>\n' +
    'Herramientas que ya corrieron en tu turno anterior (que se cortó). Usa estos resultados; ' +
    'no repitas una llamada que ya tiene resultado.\n' +
    `${lines.join('\n')}\n` +
    '</trabajo-ya-hecho>'
  );
}
