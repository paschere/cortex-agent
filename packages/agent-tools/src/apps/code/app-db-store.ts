import { randomUUID } from 'node:crypto';
import { ForbiddenError, ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AppDbTarget,
  DB_MAX_RESULT_BYTES,
  DB_MAX_ROWS,
  DB_MAX_SQL_CHARS,
  DB_MIGRATION_TIMEOUT_MS,
  DB_SCHEMA_QUOTA_BYTES,
  DB_SIZE_TTL_MS,
  DB_STATEMENT_TIMEOUT_MS,
  type DbResult,
  type MigrationFile,
  appDbNames,
  assertQuotaAllows,
  assertReadOnlySql,
  assertSingleStatement,
  checkDbParams,
  getAppDbDriver,
  peekAppDbDriver,
  planMigrations,
  quotaState,
  statementKind,
} from './app-db';
import type { CodeFiles } from './files';

/**
 * LA BASE PROPIA DE UNA APP, CON LA BASE DE CORTEX DE POR MEDIO (0246).
 *
 * Lleva la cuenta de qué migraciones se aplicaron (`custom_app_db_migrations`)
 * y de si el esquema existe (`custom_app_db`), y es el único camino por el que
 * se ejecuta SQL de una app: las funciones, las pantallas (sólo lectura) y la
 * consola del editor llaman `runAppDbQuery`. Quién puede llamarlo (el rol, el
 * permiso de pantallas, el tope por minuto) lo decide quien lo invoca; aquí se
 * decide que el SQL sea UNA sentencia, que sólo lea cuando debe, que el
 * esquema no pase de su cuota, y que corra COMO el rol de la app.
 */

export interface AppDbRow {
  schema_name: string;
  created_at: string;
}

export async function getAppDbRow(db: SupabaseClient, appId: string): Promise<AppDbRow | null> {
  const { data, error } = await db
    .from('custom_app_db')
    .select('schema_name, created_at')
    .eq('app_id', appId)
    .maybeSingle();
  if (error) throw error;
  return (data as AppDbRow | null) ?? null;
}

export interface AppliedMigrationRow {
  name: string;
  checksum: string;
  applied_at: string;
}

export async function listAppliedMigrations(
  db: SupabaseClient,
  appId: string,
): Promise<AppliedMigrationRow[]> {
  const { data, error } = await db
    .from('custom_app_db_migrations')
    .select('name, checksum, applied_at')
    .eq('app_id', appId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as AppliedMigrationRow[];
}

// Recordar el tamaño unos segundos evita una consulta al catálogo por cada escritura.
const sizeCache = new Map<string, { at: number; bytes: number }>();

export function forgetDbSize(schema?: string): void {
  if (schema) sizeCache.delete(schema);
  else sizeCache.clear();
}

async function cachedSize(
  driver: ReturnType<typeof getAppDbDriver>,
  target: AppDbTarget,
  now = Date.now(),
): Promise<number> {
  const hit = sizeCache.get(target.schema);
  if (hit && now - hit.at < DB_SIZE_TTL_MS) return hit.bytes;
  const bytes = await driver.sizeBytes(target);
  sizeCache.set(target.schema, { at: now, bytes });
  return bytes;
}

/** Crea el esquema y el rol si faltan y anota que existen. Devuelve el objetivo. */
async function ensureAppDb(
  db: SupabaseClient,
  appId: string,
  driver: ReturnType<typeof getAppDbDriver>,
): Promise<AppDbTarget> {
  const target = appDbNames(appId);
  const problem = await driver.preflight();
  if (problem) throw new ValidationError(problem);
  await driver.ensure(target);
  if (!(await getAppDbRow(db, appId))) {
    const { error } = await db
      .from('custom_app_db')
      .insert({ id: randomUUID(), app_id: appId, schema_name: target.schema });
    if (error) {
      // Dos apps con los mismos 12 primeros dígitos del id (≈ imposible) chocan en la llave única.
      if ((error as { code?: string }).code === '23505' && !(await getAppDbRow(db, appId)))
        throw new ValidationError(
          'El nombre del esquema de esta app ya lo usa otra. Avisa a soporte.',
        );
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }
  return target;
}

export interface ApplyResult {
  applied: string[];
  warnings: string[];
}

/**
 * Aplica las migraciones pendientes de `files` en orden, cada una en su propia
 * transacción y COMO el rol de la app. Se detiene en la primera que falla (esa se
 * deshace; las anteriores quedan aplicadas). Lanza `ValidationError` con el motivo.
 * Sin migraciones pendientes no toca Postgres.
 */
export async function applyAppDbMigrations(
  db: SupabaseClient,
  appId: string,
  files: CodeFiles,
  userId: string,
): Promise<ApplyResult> {
  const applied = await listAppliedMigrations(db, appId);
  const plan = planMigrations(files, applied);
  if (plan.errors.length) throw new ValidationError(plan.errors.join(' '));
  if (!plan.pending.length) return { applied: [], warnings: plan.warnings };

  const driver = getAppDbDriver();
  const target = await ensureAppDb(db, appId, driver);
  assertQuotaAllows(quotaState(await driver.sizeBytes(target)), 'write');

  const done: string[] = [];
  for (const m of plan.pending) {
    let ran: boolean;
    try {
      ran = await driver.migrate(target, {
        name: m.name,
        checksum: m.checksum,
        sql: m.sql,
        timeoutMs: DB_MIGRATION_TIMEOUT_MS,
      });
    } catch (err) {
      forgetDbSize(target.schema);
      const why = err instanceof ValidationError ? err.message : 'Error inesperado de la base.';
      if (!(err instanceof ValidationError))
        logger.error({ err, app: appId, migration: m.name }, 'app-db: migration failed');
      throw new ValidationError(
        `La migración «${m.name}» falló y se deshizo: ${why}${done.length ? ` (ya se habían aplicado: ${done.join(', ')})` : ''}`,
      );
    }
    await recordMigration(db, appId, m, userId);
    if (ran) done.push(m.name);
  }
  forgetDbSize(target.schema);
  return { applied: done, warnings: plan.warnings };
}

async function recordMigration(
  db: SupabaseClient,
  appId: string,
  m: MigrationFile,
  userId: string,
): Promise<void> {
  const { data } = await db
    .from('custom_app_db_migrations')
    .select('id')
    .eq('app_id', appId)
    .eq('name', m.name)
    .maybeSingle();
  if (data) return;
  const { error } = await db.from('custom_app_db_migrations').insert({
    id: randomUUID(),
    app_id: appId,
    name: m.name,
    checksum: m.checksum,
    applied_by: userId,
  });
  if (error && (error as { code?: string }).code !== '23505') throw error;
}

export interface AppDbStatus {
  schema: string;
  /** El esquema ya se creó (la primera migración lo crea). */
  exists: boolean;
  sizeBytes: number | null;
  quotaBytes: number;
  percent: number | null;
  migrations: Array<{ name: string; appliedAt: string }>;
  /** Archivos de db/migrations del borrador que faltan por aplicar. */
  pending: string[];
  /** Lo que impide aplicar (archivo cambiado, fuera de orden…). */
  errors: string[];
  warnings: string[];
  /** Este servidor tiene el motor de bases propias. */
  available: boolean;
}

export async function appDbStatus(
  db: SupabaseClient,
  appId: string,
  files: CodeFiles,
): Promise<AppDbStatus> {
  const target = appDbNames(appId);
  const row = await getAppDbRow(db, appId);
  const applied = await listAppliedMigrations(db, appId);
  const plan = planMigrations(files, applied);
  const driver = peekAppDbDriver();
  let sizeBytes: number | null = null;
  if (row && driver) {
    try {
      sizeBytes = await driver.sizeBytes(target);
    } catch (err) {
      logger.warn({ err, app: appId }, 'app-db: size could not be read');
    }
  }
  return {
    schema: target.schema,
    exists: Boolean(row),
    sizeBytes,
    quotaBytes: DB_SCHEMA_QUOTA_BYTES,
    percent: sizeBytes === null ? null : quotaState(sizeBytes).percent,
    migrations: applied.map((a) => ({ name: a.name, appliedAt: a.applied_at })),
    pending: plan.pending.map((m) => m.name),
    errors: plan.errors,
    warnings: plan.warnings,
    available: Boolean(driver),
  };
}

/**
 * Una sentencia SQL sobre la base de la app, COMO su rol. `readOnly` la corre en
 * una transacción READ ONLY (y además exige que empiece como consulta).
 */
export async function runAppDbQuery(
  db: SupabaseClient,
  appId: string,
  input: { sql: string; params?: unknown; readOnly: boolean },
): Promise<DbResult> {
  if (input.sql.length > DB_MAX_SQL_CHARS)
    throw new ValidationError(`El SQL pasa de ${DB_MAX_SQL_CHARS} caracteres.`);
  const code = assertSingleStatement(input.sql);
  if (input.readOnly) assertReadOnlySql(input.sql);
  const params = checkDbParams(input.params);
  const row = await getAppDbRow(db, appId);
  if (!row)
    throw new ValidationError(
      'Esta app todavía no tiene base de datos propia. Agrega db/migrations/0001_….sql al código y aplica las migraciones (o publica).',
    );
  const driver = getAppDbDriver();
  const target = appDbNames(appId);
  const kind = statementKind(code);
  if (!input.readOnly && kind === 'write')
    assertQuotaAllows(quotaState(await cachedSize(driver, target)), kind);
  const result = await driver.run(target, {
    sql: input.sql,
    params,
    readOnly: input.readOnly,
    timeoutMs: DB_STATEMENT_TIMEOUT_MS,
    maxRows: DB_MAX_ROWS,
    maxBytes: DB_MAX_RESULT_BYTES,
  });
  if (!input.readOnly && kind !== 'read') forgetDbSize(target.schema);
  return result;
}

/**
 * Borra el esquema y el rol de la app (cascade) ANTES de borrar la app. Sin fila
 * en `custom_app_db` no hay nada que borrar y no toca Postgres. Si hay base pero
 * este servidor no tiene el motor, o el borrado falla, LANZA: es preferible que
 * «Eliminar» falle a dejar datos huérfanos para siempre.
 */
export async function dropAppDb(db: SupabaseClient, appId: string): Promise<boolean> {
  let row: AppDbRow | null;
  try {
    row = await getAppDbRow(db, appId);
  } catch (err) {
    // Antes de la migración 0246 (o sin la tabla en un entorno de pruebas) no hay base propia que borrar.
    const code = (err as { code?: string })?.code;
    if (code === '42P01' || code === 'PGRST205') return false;
    throw err;
  }
  if (!row) return false;
  const driver = peekAppDbDriver();
  if (!driver)
    throw new ForbiddenError(
      'Esta app tiene base de datos propia y este servidor no puede borrarla. Elimina la app desde el servidor principal.',
    );
  const target = appDbNames(appId);
  // El nombre guardado manda sólo si coincide con el derivado: nunca se borra un esquema que no sea de esta app.
  if (row.schema_name !== target.schema)
    throw new ValidationError('El esquema registrado no corresponde a esta app; no se borra.');
  await driver.drop(target);
  forgetDbSize(target.schema);
  return true;
}
