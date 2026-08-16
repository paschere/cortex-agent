/**
 * Dónde vive la lista pegajosa: una columna en `turn_context_settings`
 * (migración 0108), la fila por-conversación que el turno YA lee.
 *
 * Por qué ahí y no en tabla nueva: es estado de una conversación, muere con
 * ella (cascade), y la fila existe o se crea con un solo upsert. Pero NO es un
 * ajuste de la persona — no entra en `TurnContextOverrides`, no lo cuenta
 * `hasOverrides` (un turno con lista pegajosa no es un turno "ajustado") y
 * `saveOverrides` no lo escribe, así que el panel de diagnóstico ni lo ve ni
 * lo puede pisar.
 *
 * MISMO CONTRATO QUE `loadOverrides`: nada de aquí puede tumbar un turno. La
 * lectura que falla devuelve lista vacía — el turno se comporta como el
 * primero de la conversación y paga una reescritura de caché, no un error — y
 * la escritura que falla se pierde en silencio, con el mismo costo.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Los ids ya ofrecidos en esta conversación, en orden. Nunca lanza. */
export async function loadStickyToolIds(
  db: SupabaseClient,
  conversationId: string,
): Promise<string[]> {
  if (!conversationId) return [];
  try {
    const { data } = await db
      .from('turn_context_settings')
      .select('sticky_tool_ids')
      .eq('conversation_id', conversationId)
      .maybeSingle();
    const ids = (data as { sticky_tool_ids?: string[] | null } | null)?.sticky_tool_ids;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export interface SaveStickyToolIdsInput {
  conversationId: string;
  /** Quién firma la fila si hay que CREARLA (`updated_by` es not null). */
  userId: string;
  ids: readonly string[];
}

/**
 * Guarda la lista acumulada. Nunca lanza: el llamador la dispara sin esperar
 * (la respuesta no depende de esta escritura) y una pérdida cuesta exactamente
 * una reescritura de caché en el próximo turno.
 *
 * UPDATE primero e INSERT sólo si no había fila, en vez de un upsert: el
 * upsert tendría que mandar `updated_by`/`updated_at`, que son de la persona
 * que tocó los AJUSTES — y esta escritura automática no debe aparecer como si
 * alguien hubiera tocado nada.
 */
export async function saveStickyToolIds(
  db: SupabaseClient,
  { conversationId, userId, ids }: SaveStickyToolIdsInput,
): Promise<void> {
  if (!conversationId) return;
  try {
    const { data } = await db
      .from('turn_context_settings')
      .update({ sticky_tool_ids: [...ids] })
      .eq('conversation_id', conversationId)
      .select('conversation_id');
    if (Array.isArray(data) && data.length > 0) return;

    // No había fila: créala con lo mínimo. Si dos turnos concurrentes chocan
    // aquí, el conflicto de clave primaria se traga abajo — el perdedor
    // reintenta implícitamente en su próximo turno.
    await db.from('turn_context_settings').insert({
      conversation_id: conversationId,
      sticky_tool_ids: [...ids],
      updated_by: userId,
    });
  } catch {
    // Deliberado: ver la cabecera.
  }
}
