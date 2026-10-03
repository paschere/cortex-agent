/**
 * RESPUESTAS DE UNA PERSONA, ENTREGADAS COMO RESPUESTA (Cortex 0185).
 *
 * Cuando alguien del equipo contesta a un cliente desde Cortex, la respuesta
 * viaja en el latido (`outbox`) y este proceso la manda. No es escribir
 * primero: Cortex sólo encola dentro de una conversación que el cliente abrió y
 * en la que escribió en las últimas 24 h. Aun así, aquí se vuelve a filtrar lo
 * que llega — sólo chats 1:1, texto razonable, pocos por latido — porque un
 * Cortex con un error no puede convertir este proceso en un envío masivo.
 */

export interface OutboxMessage {
  id: string;
  jid: string;
  text: string;
}

/** Como mucho, tantos por latido. Un latido es cada 30 s: ~10 por minuto. */
export const OUTBOX_PER_BEAT = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que vino de Cortex, filtrado a lo único que este proceso acepta mandar. */
export function sanitizeOutbox(raw: unknown): OutboxMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: OutboxMessage[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, jid, text } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) continue;
    // Sólo una persona: nunca un grupo, una lista de difusión o un estado.
    if (typeof jid !== 'string' || !/^\d{8,15}@s\.whatsapp\.net$/.test(jid)) continue;
    if (typeof text !== 'string' || !text.trim() || text.length > 3000) continue;
    seen.add(id);
    out.push({ id, jid, text: text.trim() });
    if (out.length >= OUTBOX_PER_BEAT) break;
  }
  return out;
}

/**
 * Cuánto «escribiendo…» antes de mandar: proporcional al largo, con tope. Lo
 * mismo que `humanDelayMs` en Cortex, porque es el mismo argumento: una cuenta
 * que contesta en 100 ms a cualquier hora se ve como un script.
 */
export function typingMs(text: string): number {
  return Math.min(4_500, 900 + Math.min(text.length, 300) * 12);
}

/** Pausa entre dos mensajes de la misma tanda: 1,5–3 s, nunca en ráfaga. */
export function gapMs(random: () => number = Math.random): number {
  return 1_500 + Math.floor(random() * 1_500);
}
