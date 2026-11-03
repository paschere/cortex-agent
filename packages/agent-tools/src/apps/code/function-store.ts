import { randomUUID } from 'node:crypto';
import { ValidationError, decryptToken, encryptToken, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_RUNS_KEPT,
  MAX_SECRETS_PER_APP,
  MAX_SECRET_BYTES,
  type RunTrigger,
  assertFunctionName,
  assertSecretName,
  capLog,
  hashHookToken,
  newHookToken,
} from './functions';

/**
 * SECRETOS, REGISTRO DE CORRIDAS Y WEBHOOKS de las funciones de servidor
 * (migración 0244). `db` es un handle con alcance de espacio. Quién puede
 * llamar esto (sólo owner/admin) lo decide la ruta o la herramienta.
 */

// ---------------------------------------------------------------------------
// Secretos
// ---------------------------------------------------------------------------

export interface SecretSummary {
  name: string;
  updatedAt: string;
}

/** Los secretos de la app SIN valor: nombre y fecha. El valor nunca sale de aquí hacia el navegador. */
export async function listSecretNames(db: SupabaseClient, appId: string): Promise<SecretSummary[]> {
  const { data, error } = await db
    .from('custom_app_code_secrets')
    .select('name, updated_at')
    .eq('app_id', appId)
    .order('name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<{ name: string; updated_at: string }>).map((r) => ({
    name: r.name,
    updatedAt: r.updated_at,
  }));
}

/** Pone, reemplaza (`value` texto) o borra (`null`) un secreto. */
export async function setAppSecret(
  db: SupabaseClient,
  appId: string,
  name: string,
  value: string | null,
  userId: string,
): Promise<void> {
  assertSecretName(name);
  if (value === null) {
    const { error } = await db
      .from('custom_app_code_secrets')
      .delete()
      .eq('app_id', appId)
      .eq('name', name);
    if (error) throw error;
    return;
  }
  if (!value.length) throw new ValidationError('El valor del secreto no puede estar vacío.');
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES)
    throw new ValidationError(`Un secreto pesa hasta ${MAX_SECRET_BYTES / 1024} KB.`);
  const existing = await listSecretNames(db, appId);
  if (!existing.some((s) => s.name === name) && existing.length >= MAX_SECRETS_PER_APP)
    throw new ValidationError(`Una app guarda hasta ${MAX_SECRETS_PER_APP} secretos.`);
  const now = new Date().toISOString();
  const encrypted = encryptToken(value);
  if (existing.some((s) => s.name === name)) {
    const { error } = await db
      .from('custom_app_code_secrets')
      .update({ value_encrypted: encrypted, updated_by: userId, updated_at: now })
      .eq('app_id', appId)
      .eq('name', name);
    if (error) throw error;
    return;
  }
  const { error } = await db.from('custom_app_code_secrets').insert({
    id: randomUUID(),
    app_id: appId,
    name,
    value_encrypted: encrypted,
    updated_by: userId,
    updated_at: now,
  });
  if (error) throw error;
}

/**
 * Los secretos descifrados, SÓLO para inyectarlos en `ctx.secrets` de una
 * corrida. Un secreto que no se puede descifrar (llave cambiada) se omite y se
 * avisa en el log del servidor, sin tumbar la función.
 */
export async function loadAppSecrets(
  db: SupabaseClient,
  appId: string,
): Promise<Record<string, string>> {
  const { data, error } = await db
    .from('custom_app_code_secrets')
    .select('name, value_encrypted')
    .eq('app_id', appId);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ name: string; value_encrypted: string }>) {
    try {
      out[row.name] = decryptToken(row.value_encrypted);
    } catch (err) {
      logger.warn({ err, app: appId, secret: row.name }, 'app-code: secret could not be decrypted');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corridas
// ---------------------------------------------------------------------------

export interface FunctionRunRow {
  id: string;
  function_name: string;
  trigger: RunTrigger;
  actor: string | null;
  role_key: string | null;
  build_number: number | null;
  status: 'ok' | 'error' | 'timeout';
  duration_ms: number;
  log: string;
  error: string | null;
  created_at: string;
}

const RUN_COLUMNS =
  'id, function_name, trigger, actor, role_key, build_number, status, duration_ms, log, error, created_at';

/** Anota una corrida y poda el registro a las últimas `MAX_RUNS_KEPT` de la app. Nunca lanza: el registro no tumba la función. */
export async function recordRun(
  db: SupabaseClient,
  appId: string,
  run: {
    functionName: string;
    trigger: RunTrigger;
    actor: string | null;
    roleKey: string | null;
    buildNumber: number | null;
    status: 'ok' | 'error' | 'timeout';
    durationMs: number;
    log: string;
    error: string | null;
  },
): Promise<void> {
  try {
    const { error } = await db.from('custom_app_code_runs').insert({
      id: randomUUID(),
      app_id: appId,
      function_name: run.functionName,
      trigger: run.trigger,
      actor: run.actor,
      role_key: run.roleKey,
      build_number: run.buildNumber,
      status: run.status,
      duration_ms: Math.max(0, Math.round(run.durationMs)),
      log: capLog(run.log),
      error: run.error ? run.error.slice(0, 2000) : null,
    });
    if (error) throw error;
    await pruneRuns(db, appId);
  } catch (err) {
    logger.warn({ err, app: appId }, 'app-code: run could not be recorded');
  }
}

async function pruneRuns(db: SupabaseClient, appId: string): Promise<void> {
  const { data, error } = await db
    .from('custom_app_code_runs')
    .select('id')
    .eq('app_id', appId)
    .order('created_at', { ascending: false })
    .range(MAX_RUNS_KEPT, MAX_RUNS_KEPT + 199);
  if (error || !data?.length) return;
  await db
    .from('custom_app_code_runs')
    .delete()
    .eq('app_id', appId)
    .in(
      'id',
      (data as Array<{ id: string }>).map((r) => r.id),
    );
}

export async function listRunRows(
  db: SupabaseClient,
  appId: string,
  opts: { limit?: number; functionName?: string } = {},
): Promise<FunctionRunRow[]> {
  let q = db
    .from('custom_app_code_runs')
    .select(RUN_COLUMNS)
    .eq('app_id', appId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  if (opts.functionName) q = q.eq('function_name', opts.functionName);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as FunctionRunRow[];
}

// ---------------------------------------------------------------------------
// Webhooks de entrada
// ---------------------------------------------------------------------------

export interface HookRow {
  id: string;
  app_id: string;
  name: string;
  role_key: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
}

const HOOK_COLUMNS = 'id, app_id, name, role_key, token_hash, created_by, created_at, last_used_at';

export async function getHook(
  db: SupabaseClient,
  appId: string,
  name: string,
): Promise<HookRow | null> {
  const { data, error } = await db
    .from('custom_app_code_hooks')
    .select(HOOK_COLUMNS)
    .eq('app_id', appId)
    .eq('name', name)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as HookRow | null) ?? null;
}

export async function listHooks(
  db: SupabaseClient,
  appId: string,
): Promise<Array<Omit<HookRow, 'token_hash'>>> {
  const { data, error } = await db
    .from('custom_app_code_hooks')
    .select(HOOK_COLUMNS)
    .eq('app_id', appId)
    .order('name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as HookRow[]).map(({ token_hash: _t, ...rest }) => rest);
}

/**
 * Crea el webhook de la función `name` (o lo rota: un token nuevo invalida el
 * anterior). Devuelve el token EN CLARO, que no se vuelve a poder leer. `role`
 * tiene que ser un rol de la app, nunca el administrador (lo valida quien llama,
 * que conoce los roles).
 */
export async function upsertHook(
  db: SupabaseClient,
  appId: string,
  input: { name: string; roleKey: string; userId: string },
): Promise<{ token: string }> {
  assertFunctionName(input.name);
  const token = newHookToken();
  const existing = await getHook(db, appId, input.name);
  if (existing) {
    const { error } = await db
      .from('custom_app_code_hooks')
      .update({
        role_key: input.roleKey,
        token_hash: hashHookToken(token),
        created_by: input.userId,
      })
      .eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await db.from('custom_app_code_hooks').insert({
      id: randomUUID(),
      app_id: appId,
      name: input.name,
      role_key: input.roleKey,
      token_hash: hashHookToken(token),
      created_by: input.userId,
    });
    if (error) throw error;
  }
  return { token };
}

export async function deleteHook(db: SupabaseClient, appId: string, name: string): Promise<void> {
  const { error } = await db
    .from('custom_app_code_hooks')
    .delete()
    .eq('app_id', appId)
    .eq('name', name);
  if (error) throw error;
}

export async function touchHook(db: SupabaseClient, hookId: string): Promise<void> {
  await db
    .from('custom_app_code_hooks')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', hookId);
}
