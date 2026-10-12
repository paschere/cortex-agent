import 'server-only';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type SnoozeChoice, activeSnoozeKeys, snoozeUntil } from './snooze';

/**
 * LO POSPUESTO EN «HOY» (0223), guardado en el servidor para que valga en el
 * celular y en el computador. Leer falla abierto: sin lectura no se esconde
 * nada (mejor ver de más que perder algo que esperaba).
 */

export async function loadSnoozedKeys(
  db: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  try {
    const { data, error } = await db
      .from('hoy_snoozes')
      .select('item_key, until_at')
      .eq('user_id', userId)
      .gt('until_at', now.toISOString())
      .limit(500);
    if (error) throw new Error(error.message);
    return activeSnoozeKeys((data ?? []) as Array<{ item_key: string; until_at: string }>, now);
  } catch (err) {
    logger.warn(`hoy: no se pudo leer lo pospuesto — ${(err as Error).message}`);
    return new Set();
  }
}

/** Pospone una cosa de esta persona. Devuelve cuándo vuelve. */
export async function snoozeItem(
  db: SupabaseClient,
  input: { userId: string; itemKey: string; title?: string | null; choice: SnoozeChoice },
  now: Date = new Date(),
): Promise<Date> {
  const until = snoozeUntil(input.choice, now);
  const { error } = await db.from('hoy_snoozes').upsert(
    {
      user_id: input.userId,
      item_key: input.itemKey.slice(0, 300),
      title: input.title ? input.title.slice(0, 300) : null,
      until_at: until.toISOString(),
    },
    { onConflict: 'organization_id,user_id,item_key' },
  );
  if (error) throw new Error(`No se pudo posponer: ${error.message}`);
  // Limpieza barata: lo ya vencido de esta persona no sirve para nada.
  await db
    .from('hoy_snoozes')
    .delete()
    .eq('user_id', input.userId)
    .lt('until_at', now.toISOString());
  return until;
}

/** Vuelve a mostrar una cosa antes de tiempo. */
export async function unsnoozeItem(
  db: SupabaseClient,
  userId: string,
  itemKey: string,
): Promise<void> {
  const { error } = await db
    .from('hoy_snoozes')
    .delete()
    .eq('user_id', userId)
    .eq('item_key', itemKey);
  if (error) throw new Error(`No se pudo deshacer: ${error.message}`);
}
