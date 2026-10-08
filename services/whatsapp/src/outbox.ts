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

// ---------------------------------------------------------------------------
// Mensajes de Cortex A GRUPOS (Cortex 0213)
// ---------------------------------------------------------------------------
// Aquí SÍ escribe primero el número, así que este proceso es la última puerta
// y no se fía de lo que llega: sólo grupos (nunca una persona), texto corto, y
// topes propios en memoria además de los de Cortex (un Cortex con un error no
// puede convertir esto en un envío masivo). El número no usa la API oficial y
// WhatsApp puede bloquear los que escriben de forma automática.

export interface GroupOutboxMessage {
  id: string;
  jid: string;
  text: string;
}

/** Como mucho, tantos por latido. */
export const GROUP_OUTBOX_PER_BEAT = 3;
/** Topes locales: por grupo y hora, y en total por día. */
export const GROUP_SEND_PER_GROUP_PER_HOUR = 10;
export const GROUP_SEND_PER_DAY = 50;

const GROUP_JID = /^[0-9]{5,}(-[0-9]+)?@g\.us$/;

export function sanitizeGroupOutbox(raw: unknown): GroupOutboxMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupOutboxMessage[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, jid, text } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) continue;
    // Sólo un GRUPO: nunca una persona, una lista de difusión o un estado.
    if (typeof jid !== 'string' || !GROUP_JID.test(jid)) continue;
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) continue;
    seen.add(id);
    out.push({ id, jid, text: text.trim() });
    if (out.length >= GROUP_OUTBOX_PER_BEAT) break;
  }
  return out;
}

/** Ventanas deslizantes en memoria. Reiniciar el proceso las vacía; Cortex aplica las suyas aparte. */
export class GroupSendLimiter {
  private readonly sent: Array<{ jid: string; at: number }> = [];

  /** true y lo anota, o false si pasaría de un tope. */
  tryTake(jid: string, now = Date.now()): boolean {
    const day = now - 24 * 3_600_000;
    while (this.sent.length > 0 && (this.sent[0] as { at: number }).at < day) this.sent.shift();
    if (this.sent.length >= GROUP_SEND_PER_DAY) return false;
    const hour = now - 3_600_000;
    if (
      this.sent.filter((s) => s.jid === jid && s.at >= hour).length >= GROUP_SEND_PER_GROUP_PER_HOUR
    )
      return false;
    this.sent.push({ jid, at: now });
    return true;
  }
}
