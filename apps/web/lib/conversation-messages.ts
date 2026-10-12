import type { Message } from 'ai';
import {
  capServeParts,
  overlayToolResults,
  parseStoredParts,
  toolInvocationsOf,
} from './message-parts';
import { toToolInvocations } from './tool-invocations';

/**
 * LAS FILAS DE `messages` → LOS MENSAJES QUE DIBUJA EL CHAT.
 *
 * Una sola función para las dos puertas que releen una conversación: la página
 * `/chat/[conversationId]` al abrirla y `/api/conversations/[id]/messages`, que
 * el chat consulta mientras una TAREA EN SEGUNDO PLANO escribe su avance (así
 * se ve avanzar a Cortex desde cualquier aparato sin recargar). Sin esta
 * extracción habría dos copias de la regla «parts recortadas, invocaciones desde
 * las mismas parts, hora con el mensaje» y se desviarían.
 */

export interface StoredMessageRow {
  id: unknown;
  role: unknown;
  content: unknown;
  tool_calls?: unknown;
  tool_results?: unknown;
  parts?: unknown;
  created_at?: unknown;
}

export function toChatMessages(rows: readonly StoredMessageRow[]): Message[] {
  return rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      // La cronología guardada, servida recortada (ver el comentario largo en la
      // página del chat y lib/message-parts.ts): con `parts` la respuesta se dibuja
      // exactamente como en vivo; las invocaciones planas salen de ESAS parts.
      const storedParts = m.role === 'assistant' ? parseStoredParts(m.parts) : undefined;
      const currentParts = storedParts
        ? overlayToolResults(storedParts, m.tool_results)
        : undefined;
      const servedParts = currentParts ? capServeParts(currentParts) : undefined;
      const partInvocations = servedParts ? toolInvocationsOf(servedParts) : undefined;
      const toolInvocations =
        partInvocations && partInvocations.length > 0
          ? partInvocations
          : toToolInvocations(m.tool_calls, m.tool_results);
      const createdAt = m.created_at ? new Date(m.created_at as string) : null;
      return {
        id: m.id as string,
        role: m.role as 'user' | 'assistant',
        content: (m.content as string) ?? '',
        ...(toolInvocations ? { toolInvocations } : {}),
        ...(servedParts ? { parts: servedParts } : {}),
        ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
      };
    });
}
