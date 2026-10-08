import type { CoreMessage } from 'ai';
import { dropTrailingNonUser } from './turn-messages';

/**
 * EL HISTORIAL QUE SE LE MANDA AL MODELO, SANEADO PARA QUE LA API NO LO RECHACE.
 *
 * Un turno cortado a la mitad dejaba huellas que la API de Anthropic rechaza
 * ENTERAS, y como el historial se reenvía en cada mensaje la conversación
 * quedaba trabada para siempre (visto en producción 2026-10-08: «messages: text
 * content blocks must be non-empty» en todos los turnos siguientes). Lo que se
 * repara aquí, cada caso con su prueba en strip-empty-messages.test.ts:
 *
 *   1. texto vacío o de puros espacios — mensajes enteros y partes de texto;
 *   2. un mensaje que se queda sin ninguna parte después de limpiar;
 *   3. llamadas a herramientas del asistente sin su resultado en el mensaje
 *      `tool` siguiente (la API exige un tool_result por cada tool_use);
 *   4. resultados huérfanos: un `tool` cuyo toolCallId no viene de la llamada
 *      inmediatamente anterior;
 *   5. lo que no es de la persona al PRINCIPIO del hilo (la ventana de 20 filas
 *      puede empezar en una respuesta) y al FINAL (la API no acepta prefill).
 *
 * Nunca toca un mensaje con contenido real. Dos mensajes seguidos del mismo rol
 * que queden al quitar uno vacío no se fusionan: el proveedor ya los agrupa.
 */
export function sanitizeHistory(messages: readonly CoreMessage[]): CoreMessage[] {
  const cleaned: CoreMessage[] = [];
  for (const m of messages) {
    const next = cleanContent(m);
    if (next) cleaned.push(next);
  }

  // Pares llamada → resultado. Se mira hacia adelante (¿la llamada tiene
  // resultado justo después?) y hacia atrás (¿el resultado tiene llamada justo
  // antes?), y se quita lo que no tenga pareja.
  const paired: CoreMessage[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const m = cleaned[i] as CoreMessage;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const following = cleaned[i + 1];
      const answered = new Set(
        following?.role === 'tool' ? following.content.map((r) => r.toolCallId) : [],
      );
      const parts = m.content.filter((p) => p.type !== 'tool-call' || answered.has(p.toolCallId));
      if (parts.length > 0) paired.push({ ...m, content: parts } as CoreMessage);
      continue;
    }
    if (m.role === 'tool') {
      const previous = paired[paired.length - 1];
      const asked = new Set(
        previous?.role === 'assistant' && Array.isArray(previous.content)
          ? previous.content.flatMap((p) => (p.type === 'tool-call' ? [p.toolCallId] : []))
          : [],
      );
      const results = m.content.filter((r) => asked.has(r.toolCallId));
      if (results.length > 0) paired.push({ ...m, content: results });
      continue;
    }
    paired.push(m);
  }

  // Al principio: el hilo arranca en la persona (los `system` sueltos se dejan).
  let start = 0;
  while (
    start < paired.length &&
    (paired[start]?.role === 'assistant' || paired[start]?.role === 'tool')
  )
    start++;
  return dropTrailingNonUser(paired.slice(start));
}

function cleanContent(m: CoreMessage): CoreMessage | null {
  if (typeof m.content === 'string') {
    return m.content.trim() || m.role === 'system' ? m : null;
  }
  if (!Array.isArray(m.content)) return m;
  const parts = (m.content as Array<{ type: string; text?: string }>).filter(
    (p) => !((p.type === 'text' || p.type === 'reasoning') && !(p.text ?? '').trim()),
  );
  return parts.length > 0 ? ({ ...m, content: parts } as CoreMessage) : null;
}

/** Nombre anterior, conservado para quien lo importe. */
export const stripEmptyMessages = sanitizeHistory;
