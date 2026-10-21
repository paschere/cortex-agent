import type { HaikuHistory } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Lo que una conversación del brazo Haiku ya registró (`model_usage`, 0236):
 * fallos de herramienta y refusals acumulados. De aquí sale «¿sigue en Haiku o
 * pasa a Sonnet 5.5?» (`decideTurnModel`, en agent-tools).
 *
 * NUNCA lanza: sin la tabla o las columnas (migración sin aplicar) devuelve
 * null y la conversación sigue en el brazo que le tocó. Un experimento no
 * puede tumbar un turno.
 */
export async function loadHaikuHistory(
  db: SupabaseClient,
  conversationId: string,
): Promise<HaikuHistory | null> {
  try {
    const { data, error } = await db
      .from('model_usage')
      .select('tool_errors, refusals')
      .eq('conversation_id', conversationId)
      .eq('experiment_arm', 'haiku')
      .limit(500);
    if (error || !data) return null;
    let toolErrors = 0;
    let refusals = 0;
    for (const r of data as Array<{ tool_errors?: number | null; refusals?: number | null }>) {
      toolErrors += Number(r.tool_errors) || 0;
      refusals += Number(r.refusals) || 0;
    }
    return { toolErrors, refusals };
  } catch {
    return null;
  }
}
