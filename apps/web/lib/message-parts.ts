import type { Message, ToolInvocation } from 'ai';

/**
 * LA CRONOLOGÍA DE UNA RESPUESTA, GUARDADA Y VUELTA A LEER.
 *
 * ===========================================================================
 * EL AGUJERO QUE TAPA
 * ===========================================================================
 * Una respuesta EN VIVO se dibuja desde `message.parts` del stream: texto,
 * razonamiento y llamadas a herramientas entrelazados en el orden real. Al
 * recargar, ese entrelazado no existía: la base guardaba `content`,
 * `tool_calls` y `tool_results` por separado, el razonamiento se perdía del
 * todo, y `segmentsOf` en MessageBubble caía a un fallback que pinta los pasos
 * antes del texto porque «es el orden menos falso». La misma conversación se
 * veía distinta según si se estaba mirando o recordando.
 *
 * Esto construye las `parts` desde los `steps` que `onFinish` ya recibe, las
 * recorta a un tope honesto, y las vuelve a leer con desconfianza — es jsonb y
 * lo pudo escribir una versión anterior de este código.
 *
 * ===========================================================================
 * LOS NÚMEROS, Y POR QUÉ SON ESTOS
 * ===========================================================================
 * Los topes se miden en CARACTERES del JSON serializado, que en un JSON (casi
 * todo ASCII) es ≈ 1 byte por carácter. Se mide así y no con TextEncoder
 * porque un recorte tiene que ser una función pura y determinista que corra
 * igual en Node y en el navegador, y porque el error de la aproximación va en
 * la dirección segura (un carácter nunca pesa menos de un byte... salvo que
 * pese más, y entonces el tope real queda un poco por debajo del nominal, que
 * también es seguro).
 *
 *   PART_RESULT_CAP   100 000  (~100 KB) por resultado de invocación AL
 *                     ESCRIBIR. Un scrape o una tabla entera no revientan la
 *                     fila; pasado el tope se guarda `{ __truncated: true,
 *                     originalLength, preview }` con el primer trozo.
 *
 *   PART_MESSAGE_CAP  1 000 000 (~1 MB) por mensaje. Si tras el recorte por
 *                     resultado el total sigue por encima —doce invocaciones
 *                     de 90 KB—, TODOS los resultados se re-recortan a
 *                     PART_RESULT_FLOOR. El texto y el razonamiento no se
 *                     tocan nunca: los acota la salida del modelo.
 *
 *   PART_RESULT_FLOOR 8 000    (~8 KB) el segundo recorte, cuando el mensaje
 *                     entero se pasa. Suficiente para leer qué devolvió la
 *                     herramienta; no para reventarlo todo doce veces.
 *
 *   PART_SERVE_CAP    20 000   (~20 KB) por invocación AL SERVIR una
 *                     conversación guardada. El transcript viaja entero en el
 *                     payload RSC de la página, y cincuenta mensajes con
 *                     resultados de 100 KB son 5 MB de HTML: lo que se guarda
 *                     completo no tiene por qué viajar completo para pintarse.
 *
 * Este archivo es una función pura, sin `server-only` y sin importar nada de
 * `@cortex/agent-tools`, por el mismo motivo que `lib/brain-sources-shape.ts`:
 * así se puede probar en Node y lo puede leer tanto el servidor que escribe
 * como el que sirve la página.
 */

export const PART_RESULT_CAP = 100_000;
export const PART_MESSAGE_CAP = 1_000_000;
export const PART_RESULT_FLOOR = 8_000;
export const PART_SERVE_CAP = 20_000;

/** Las tres clases de entrada que se guardan. `step-start` y demás no aportan
 *  nada a la reconstrucción y no se escriben. */
export type StoredPart = NonNullable<Message['parts']>[number];

/**
 * La marca de un resultado que no cupo. `preview` es el principio del JSON
 * original — legible para una persona, y a propósito NO re-parseable: un
 * resultado truncado no debe volver a pasar por `resolveView` como si
 * estuviera entero, porque una tarjeta rica dibujada sobre media tabla es una
 * tabla que miente.
 */
export interface TruncatedResult {
  __truncated: true;
  /** Cuántos caracteres medía el JSON entero antes del recorte. */
  originalLength: number;
  preview: string;
}

export function isTruncatedResult(value: unknown): value is TruncatedResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.__truncated === true && typeof v.originalLength === 'number' && typeof v.preview === 'string'
  );
}

/**
 * Un resultado, recortado si hace falta.
 *
 * Re-recortar un ya-truncado (el paso de 100 KB → 8 KB, o el de servir a
 * 20 KB) conserva `originalLength`: la cifra que importa es cuánto medía DE
 * VERDAD, no cuánto medía el recorte anterior.
 */
export function capResult(result: unknown, cap: number): unknown {
  if (isTruncatedResult(result)) {
    if (result.preview.length <= cap) return result;
    return {
      __truncated: true,
      originalLength: result.originalLength,
      preview: result.preview.slice(0, cap),
    } satisfies TruncatedResult;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    // Circular o no serializable: no va a poder guardarse en jsonb de ninguna
    // manera, así que se deja constancia en vez de tumbar la persistencia.
    return {
      __truncated: true,
      originalLength: 0,
      preview: '[resultado no serializable]',
    } satisfies TruncatedResult;
  }
  if (serialized === undefined || serialized.length <= cap) return result;
  return {
    __truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, cap),
  } satisfies TruncatedResult;
}

/** Lo poco que esto necesita de un `StepResult` del SDK. */
export interface StepLike {
  text?: string;
  reasoning?: string;
  toolCalls?: ReadonlyArray<{ toolCallId?: string; toolName?: string; args?: unknown }>;
  toolResults?: ReadonlyArray<{ toolCallId?: string; result?: unknown }>;
}

/**
 * Las `parts` de un mensaje del asistente, reconstruidas desde sus steps.
 *
 * EL ORDEN DENTRO DE UN STEP ES razonamiento → texto → llamadas, y no es una
 * convención: un step del SDK TERMINA cuando el modelo llama herramientas, así
 * que todo el texto de ese step se escribió antes de la llamada, y el
 * razonamiento antes que el texto. Concatenar los steps en orden ES la
 * cronología del turno.
 *
 * Devuelve `null` cuando el turno fue solo texto: `content` ya lo lleva
 * entero, y guardar unas parts que no añaden nada sería pagar el peso dos
 * veces en cada apertura de conversación. Con razonamiento o con llamadas sí
 * se guarda, porque eso es exactamente lo que hoy se pierde al recargar.
 */
export function buildStoredParts(steps: readonly StepLike[]): StoredPart[] | null {
  const out: StoredPart[] = [];
  let beyondText = false;

  for (const step of steps) {
    if (typeof step.reasoning === 'string' && step.reasoning.trim()) {
      out.push({
        type: 'reasoning',
        reasoning: step.reasoning,
        details: [{ type: 'text', text: step.reasoning }],
      });
      beyondText = true;
    }
    if (typeof step.text === 'string' && step.text.trim()) {
      out.push({ type: 'text', text: step.text });
    }
    const results = new Map(
      (step.toolResults ?? [])
        .filter((r) => typeof r.toolCallId === 'string')
        .map((r) => [r.toolCallId as string, r] as const),
    );
    for (const [i, call] of (step.toolCalls ?? []).entries()) {
      const toolCallId = call.toolCallId ?? `call-${out.length}-${i}`;
      const toolName = call.toolName ?? 'unknown';
      const match = call.toolCallId ? results.get(call.toolCallId) : undefined;
      out.push({
        type: 'tool-invocation',
        toolInvocation: match
          ? { state: 'result', toolCallId, toolName, args: call.args, result: match.result }
          : // Sin resultado es un turno interrumpido, y decir que sigue en
            // marcha es la verdad — igual que en lib/tool-invocations.ts.
            { state: 'call', toolCallId, toolName, args: call.args },
      });
      beyondText = true;
    }
  }

  return beyondText ? out : null;
}

function capInvocations(parts: readonly StoredPart[], cap: number): StoredPart[] {
  return parts.map((part) => {
    if (part.type !== 'tool-invocation' || part.toolInvocation.state !== 'result') return part;
    const capped = capResult(part.toolInvocation.result, cap);
    if (capped === part.toolInvocation.result) return part;
    return {
      ...part,
      toolInvocation: { ...part.toolInvocation, result: capped },
    };
  });
}

function totalLength(parts: readonly StoredPart[]): number {
  try {
    return JSON.stringify(parts)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * El recorte AL ESCRIBIR: 100 KB por resultado y ~1 MB por mensaje.
 * Ver la cabecera para los números y su porqué.
 */
export function capStoredParts(parts: readonly StoredPart[]): StoredPart[] {
  let capped = capInvocations(parts, PART_RESULT_CAP);
  if (totalLength(capped) > PART_MESSAGE_CAP) {
    capped = capInvocations(capped, PART_RESULT_FLOOR);
  }
  return capped;
}

/**
 * El recorte AL SERVIR una conversación guardada: 20 KB por invocación, para
 * que un transcript con resultados grandes no reviente el payload RSC de la
 * página. Lo guardado no se toca; solo viaja menos.
 */
export function capServeParts(parts: readonly StoredPart[]): StoredPart[] {
  return capInvocations(parts, PART_SERVE_CAP);
}

/**
 * Lo mismo, leído de la base de datos — con desconfianza, porque `parts` es
 * jsonb y lo escribió una versión anterior de este código. Una entrada rara se
 * descarta y las demás se dibujan; sin ninguna válida devuelve `undefined`,
 * que es lo que hace que la página caiga al fallback de siempre.
 */
export function parseStoredParts(value: unknown): StoredPart[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const out: StoredPart[] = [];
  for (const row of value) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;

    if (r.type === 'text' && typeof r.text === 'string' && r.text.trim()) {
      out.push({ type: 'text', text: r.text });
      continue;
    }
    if (r.type === 'reasoning' && typeof r.reasoning === 'string' && r.reasoning.trim()) {
      // `details` se reconstruye en vez de confiarse: al que dibuja
      // (ReasoningTrail vía reasoningOf) solo le importa `reasoning`.
      out.push({
        type: 'reasoning',
        reasoning: r.reasoning,
        details: [{ type: 'text', text: r.reasoning }],
      });
      continue;
    }
    if (r.type === 'tool-invocation' && typeof r.toolInvocation === 'object' && r.toolInvocation) {
      const inv = r.toolInvocation as Record<string, unknown>;
      const toolCallId = typeof inv.toolCallId === 'string' ? inv.toolCallId : null;
      const toolName = typeof inv.toolName === 'string' ? inv.toolName : null;
      if (!toolCallId || !toolName) continue;
      out.push({
        type: 'tool-invocation',
        toolInvocation:
          inv.state === 'result'
            ? { state: 'result', toolCallId, toolName, args: inv.args, result: inv.result }
            : { state: 'call', toolCallId, toolName, args: inv.args },
      });
    }
  }

  return out.length > 0 ? out : undefined;
}

/**
 * Las invocaciones de unas parts, en la forma plana que el resto del cliente
 * ya lee (`message.toolInvocations`): la detección de confirmaciones y de
 * preguntas con opciones, los avisos de mandatos y el fallback de dibujo pasan
 * todos por ahí. Derivarlas de las MISMAS parts que se van a pintar — y no de
 * `tool_results` sin recortar — es lo que evita mandar el resultado dos veces
 * y una de ellas sin tope.
 */
export function toolInvocationsOf(parts: readonly StoredPart[]): ToolInvocation[] {
  return parts.flatMap((p) => (p.type === 'tool-invocation' ? [p.toolInvocation] : []));
}
