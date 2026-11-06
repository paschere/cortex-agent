import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA COPIA «ANTES DE CAMBIO» QUE NUNCA BLOQUEA.
 *
 * Se llama justo antes de publicar una versión, publicar código o aplicar
 * migraciones de la base propia. Si la copia falla (la base, el tamaño, un
 * entorno sin la migración 0247) se registra y el cambio sigue: una copia que
 * no se pudo hacer no es motivo para que la persona no pueda publicar. (Restaurar
 * sí aborta si no puede hacer su copia previa: ver backups/store.ts.)
 *
 * El `import()` es diferido a propósito: store.ts importa versions.ts, que
 * llama a esta función; el diferido corta el ciclo en la carga.
 */
export async function backupBeforeChange(
  db: SupabaseClient,
  appId: string,
  userId: string | null,
  reason: string,
): Promise<string | null> {
  try {
    const { createBackup } = await import('./store');
    const backup = await createBackup(db, appId, { kind: 'antes_de_cambio', reason, userId });
    return backup.id;
  } catch (err) {
    logger.warn(
      { err, app: appId, reason },
      'backups: copia antes de cambio falló; el cambio sigue',
    );
    return null;
  }
}
