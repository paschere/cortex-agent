import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA CONCESIÓN DE CONVERSACIÓN: «ya me lo aprobaste, hace un momento, aquí».
 *
 * ===========================================================================
 * EL PROBLEMA QUE CIERRA
 * ===========================================================================
 * `browser.open_page` pide confirmación — una vez por pestaña, como enviar un
 * correo. Pero una diligencia real abre pestañas en ráfaga: «cierra esa y
 * vuelve a entrar», «ahora abre el portal del banco», el reintento tras un
 * portal caído. Cada una paraba el turno con OTRA tarjeta idéntica a la que
 * la persona acababa de aprobar, y en producción eso se leyó como lo que es:
 * un producto que no escucha. La persona ya dijo que sí a «Cortex navega por
 * mí en esta conversación»; preguntárselo de nuevo a los noventa segundos no
 * es seguridad, es ceremonia.
 *
 * ===========================================================================
 * QUÉ ES — Y QUÉ NO ES
 * ===========================================================================
 * Una herramienta puede declarar `conversationGrace: <ms>` en su definición:
 * una aprobación humana de ESA herramienta, en ESTA conversación, de ESTE
 * usuario, vale también para las llamadas siguientes durante la ventana. El
 * ancla es el registro de auditoría que ya existe: una ejecución con
 * `status: 'ok'` de una herramienta con `requiresConfirmation` solo pudo
 * ocurrir porque una persona la confirmó (o porque heredó una concesión — y
 * esa cadena termina siempre en una confirmación real dentro de ventanas
 * encadenadas). No hay tabla nueva ni estado nuevo: la prueba de la
 * aprobación ES la fila que la aprobación dejó.
 *
 * Lo que NO afloja, dicho con las mayúsculas de la casa:
 *
 *   * LA PUERTA DE SEGURIDAD NO SE TOCA. La concesión vive en la segunda
 *     puerta de runTool (la cortesía estática que la herramienta declaró
 *     sobre sí misma). Si la capa de seguridad clasifica la llamada concreta
 *     como `confirm` o `block`, eso pasa ANTES y no consulta esto.
 *   * NO CRUZA CONVERSACIONES ni usuarios: el sí de una persona en un hilo
 *     no navega por ella en otro.
 *   * NO ES UN MANDATO. El mandato (0099) es una delegación del dueño,
 *     permanente y administrable; esto es la memoria corta de un sí que la
 *     persona acaba de dar, y muere sola con la ventana.
 *
 * Fail-closed: cualquier duda —sin conversación, sin filas, error de la
 * consulta— responde false, y false significa tarjeta, que es exactamente lo
 * que pasaba antes de que esto existiera.
 */
export async function hasConversationGrace(
  db: SupabaseClient,
  opts: {
    conversationId: string | undefined;
    userId: string;
    toolId: string;
    graceMs: number;
  },
): Promise<boolean> {
  if (!opts.conversationId || opts.graceMs <= 0) return false;
  try {
    const since = new Date(Date.now() - opts.graceMs).toISOString();
    const { data, error } = await db
      .from('audit_events')
      .select('id')
      .eq('conversation_id', opts.conversationId)
      .eq('user_id', opts.userId)
      .eq('tool_id', opts.toolId)
      .eq('status', 'ok')
      .gte('created_at', since)
      .limit(1);
    if (error) {
      logger.warn({ err: error.message, toolId: opts.toolId }, 'conversation grace lookup failed');
      return false;
    }
    return Boolean(data && data.length > 0);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'conversation grace lookup threw');
    return false;
  }
}
