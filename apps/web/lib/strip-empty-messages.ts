import type { CoreMessage } from 'ai';

/**
 * QUITA LOS BLOQUES DE TEXTO VACÍOS ANTES DE LLAMAR AL MODELO.
 *
 * Una respuesta que se cortó a la mitad puede quedar guardada sin texto. La
 * API de Anthropic rechaza el turno entero con «messages: text content blocks
 * must be non-empty», y como el historial se reenvía en cada mensaje, la
 * conversación quedaba trabada para siempre (visto en producción 2026-10-08).
 * Aquí se quitan las partes de texto vacías y los mensajes que quedan sin
 * nada; nunca se toca un mensaje con contenido real ni las llamadas a
 * herramientas.
 */
export function stripEmptyMessages(messages: CoreMessage[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content.trim() || m.role === 'system') out.push(m);
      continue;
    }
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const parts = (m.content as Array<{ type: string; text?: string }>).filter(
      (p) => !(p.type === 'text' && !(p.text ?? '').trim()),
    );
    if (parts.length) out.push({ ...m, content: parts } as CoreMessage);
  }
  // El último debe seguir siendo de la persona: si quitar vacíos dejó dos
  // mensajes seguidos del mismo rol, la API los acepta; no se fusionan.
  return out;
}
