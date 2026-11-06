import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { backupBeforeChange } from '../backups/before-change';
import { MIGRATION_DIR } from './app-db';
import { applyAppDbMigrations } from './app-db-store';
import {
  type AppCodeBuildRow,
  type AppCodeRow,
  getAppCode,
  getBuild,
  publishAppCode,
} from './store';

/**
 * PUBLICAR = APLICAR LAS MIGRACIONES DE ESA COMPILACIÓN Y LUEGO PUBLICAR.
 *
 * Las migraciones salen de los archivos de LA COMPILACIÓN (copia exacta de lo
 * compilado), no del borrador: lo que se publica es lo que se probó. Si una
 * migración falla (o un archivo aplicado cambió), la publicación NO ocurre: el
 * código nuevo suele necesitar las tablas nuevas, y publicar sin ellas rompe la
 * app. Sin archivos en db/migrations no se toca Postgres.
 */
export async function publishAppCodeWithMigrations(
  db: SupabaseClient,
  appId: string,
  buildId: string,
  userId: string,
): Promise<{ code: AppCodeRow; build: AppCodeBuildRow; migrationsApplied: string[] }> {
  const code = await getAppCode(db, appId);
  if (!code) throw new NotFoundError('Esta aplicación todavía no tiene código.');
  const build = await getBuild(db, code.id, buildId);
  if (!build) throw new NotFoundError('Esa compilación ya no existe.');
  if (build.status !== 'ok')
    throw new ValidationError(
      `La compilación ${build.number} falló; sólo se publican las que salieron bien.`,
    );
  // Foto de la app antes de publicar (cubre también las migraciones de abajo; no bloquea si falla).
  await backupBeforeChange(
    db,
    appId,
    userId,
    `Antes de publicar el código (compilación ${build.number})`,
  );
  let migrationsApplied: string[] = [];
  if (Object.keys(build.files).some((p) => p.startsWith(MIGRATION_DIR)))
    migrationsApplied = (
      await applyAppDbMigrations(db, appId, build.files, userId, { backup: false })
    ).applied;
  const published = await publishAppCode(db, appId, buildId, userId);
  return { ...published, migrationsApplied };
}
