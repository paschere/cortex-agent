/**
 * EL VIGILANTE DE UN TURNO, COMO FUNCIONES PURAS.
 *
 * «A veces los prompts se quedan colgando»: un turno que no produce nada (la
 * función murió, el modelo no contestó, el stream cerró vacío) dejaba la
 * pantalla esperando. El navegador vigila tres cosas:
 *
 *   1. SIN DATOS: si el stream no trae nada nuevo en `STALL_MS` (o en
 *      `TOOL_STALL_MS` mientras una herramienta corre), se avisa «sigue
 *      trabajando» con Detener / Reintentar. No se corta nada solo.
 *   2. CIERRE VACÍO: el stream terminó y no hay respuesta del asistente → se
 *      relee la conversación y, si sigue sin respuesta, se muestra el error con
 *      Reintentar / Continuar.
 *   3. RECARGA A MEDIAS: la conversación termina en una pregunta sin respuesta
 *      → se relee de la base hasta que aparezca (o se agote la espera).
 */

export const STALL_MS = 45_000;
export const TOOL_STALL_MS = 180_000;
/** Cuánto se espera a que aparezca la respuesta de un turno que ya estaba en vuelo al recargar. */
export const RECOVER_MS = 90_000;

interface PartLike {
  type?: string;
  toolInvocation?: { state?: string };
}

export interface MessageLike {
  id?: string;
  role: string;
  content: string;
  parts?: readonly PartLike[];
  toolInvocations?: ReadonlyArray<{ state?: string }>;
  annotations?: readonly unknown[];
}

/** ¿Hay una herramienta corriendo en el mensaje (llamada sin resultado)? */
export function toolIsRunning(message: MessageLike | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const states = [
    ...(message.toolInvocations ?? []).map((i) => i.state),
    ...(message.parts ?? []).flatMap((p) =>
      p.type === 'tool-invocation' ? [p.toolInvocation?.state] : [],
    ),
  ];
  return states.some((s) => s === 'call' || s === 'partial-call');
}

/** Una huella barata de lo último que llegó: si cambia, el turno sigue vivo. */
export function activitySignature(messages: readonly MessageLike[]): string {
  const last = messages[messages.length - 1];
  if (!last) return '';
  const states = [
    ...(last.toolInvocations ?? []).map((i) => i.state ?? ''),
    ...(last.parts ?? []).map((p) => `${p.type ?? ''}${p.toolInvocation?.state ?? ''}`),
  ].join(',');
  return `${messages.length}:${last.role}:${last.content.length}:${last.annotations?.length ?? 0}:${states}`;
}

export function isStalled(input: {
  now: number;
  lastActivityAt: number;
  toolRunning: boolean;
}): boolean {
  const limit = input.toolRunning ? TOOL_STALL_MS : STALL_MS;
  return input.now - input.lastActivityAt >= limit;
}

/** ¿La conversación termina sin respuesta del asistente (nada, o una burbuja vacía)? */
export function endsWithoutAnswer(messages: readonly MessageLike[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === 'user') return true;
  if (last.role !== 'assistant') return false;
  if (last.content.trim()) return false;
  const hasTool =
    (last.toolInvocations?.length ?? 0) > 0 ||
    (last.parts ?? []).some((p) => p.type === 'tool-invocation');
  return !hasTool;
}
