import { NotFoundError, ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentAutomationOrigin } from '../automations/emit';
import { ADMIN_ROLE_KEY, adminRole } from '../permissions';
import {
  type AppAccess,
  type AppScreenRow,
  type CustomAppRow,
  getApp,
  listRoles,
  listScreens,
  withPublishedVersion,
} from '../store';
import { loadAppSecrets, recordRun } from './function-store';
import {
  FN_MAX_OUTPUT_BYTES,
  FN_TIMEOUT_MS,
  type FnTokenClaims,
  type RunTrigger,
  assertFunctionName,
  capLog,
  checkFunctionInput,
  getFunctionRunner,
  mintFnToken,
} from './functions';
import { getAppCode, getBuild, latestBuild } from './store';

/**
 * CORRER UNA FUNCIÓN DE SERVIDOR (fase 2).
 *
 * Una sola puerta para los cinco disparadores (pantalla, regla, horario,
 * webhook, chat). Siempre corre con el rol de un `AppAccess` —el de quien abrió
 * la pantalla, o el que la regla/el webhook nombran—; la función nunca hereda
 * más permisos que ese rol porque lo único que tiene para hablar con Cortex es
 * un token de 5 minutos con ese rol (ver functions.ts y la ruta fn-sdk).
 */

export interface RunFunctionOptions {
  trigger: RunTrigger;
  /** La pantalla que la llamó (audita las escrituras como ediciones de esa pantalla). */
  screen?: Pick<AppScreenRow, 'id' | 'slug' | 'view_id'> | null;
  /** «Ver como…»: la función corre pero lo que escriba por el SDK se rechaza. */
  readOnly?: boolean;
  /** Qué compilación: la publicada (por omisión) o la última que salió bien (para probar antes de publicar). */
  build?: 'published' | 'latest';
  organizationId?: string;
  /** Texto para el registro cuando el actor no es una persona ("Regla «X»"). */
  actorLabel?: string;
  /**
   * La cadena de reglas que dispararon esta corrida (anti-bucle). Por omisión se
   * toma de `withAutomationOrigin` en curso: una regla que corre una función
   * pasa la cadena sin hacer nada más.
   */
  automation?: { chain: string[]; depth: number } | null;
}

export interface FunctionOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  log: string;
  durationMs: number;
  status: 'ok' | 'error' | 'timeout';
}

/**
 * El acceso de una regla o un webhook: el rol NOMBRADO (nunca el administrador)
 * a nombre de un miembro de Cortex (`memberId`: quien creó la regla o el
 * webhook, para que las escrituras tengan un autor real). Sin atributos: un rol
 * que ve «las filas donde Cliente = su cliente» no sirve para una función sin persona.
 */
export async function systemAppAccess(
  db: SupabaseClient,
  app: CustomAppRow,
  roleKey: string,
  memberId: string,
  label: string,
): Promise<AppAccess> {
  if (roleKey === ADMIN_ROLE_KEY)
    throw new ValidationError(
      'Una función disparada por una regla o un webhook no corre como administrador: nombra un rol de la app.',
    );
  const role = (await listRoles(db, app.id)).find((r) => r.key === roleKey);
  if (!role) throw new ValidationError(`El rol «${roleKey}» ya no existe en esta app.`);
  const screens = (await listScreens(db, app.id)).filter((s) => s.view_id);
  const access: AppAccess = {
    app,
    screens,
    role: { key: role.key, name: role.name, permissions: role.permissions, admin: false },
    user: { id: memberId, name: label, attributes: {} },
  };
  return (await withPublishedVersion(db, access)) ?? access;
}

/**
 * El acceso para PROBAR una función a mano (editor o chat): quien administra la
 * empresa corre como administrador, o como un rol de la app si lo pide (para
 * ver qué pasaría con los permisos de ese rol; con datos reales).
 */
export async function testAppAccess(
  db: SupabaseClient,
  app: CustomAppRow,
  user: { id: string; name: string },
  roleKey?: string | null,
): Promise<AppAccess> {
  const screens = (await listScreens(db, app.id)).filter((s) => s.view_id);
  if (!roleKey || roleKey === ADMIN_ROLE_KEY)
    return { app, screens, role: adminRole(), user: { ...user, attributes: {} } };
  const role = (await listRoles(db, app.id)).find((r) => r.key === roleKey);
  if (!role) throw new ValidationError(`El rol «${roleKey}» no existe en esta app.`);
  return {
    app,
    screens,
    role: { key: role.key, name: role.name, permissions: role.permissions, admin: false },
    user: { ...user, attributes: {} },
  };
}

/**
 * Del token de una corrida al acceso del que llama (para la ruta fn-sdk): el rol
 * se vuelve a leer de la base (permisos al día, no los del momento del token).
 * null si la app o el rol ya no existen.
 */
export async function accessFromClaims(
  db: SupabaseClient,
  claims: FnTokenClaims,
): Promise<AppAccess | null> {
  const app = await getApp(db, claims.app);
  if (!app) return null;
  const screens = (await listScreens(db, app.id)).filter((s) => s.view_id);
  const user = {
    id: claims.actor.id,
    name: claims.actor.name,
    attributes: claims.attributes,
    ...(claims.actor.kind === 'external' ? { external: true } : {}),
  };
  if (claims.role === ADMIN_ROLE_KEY) return { app, screens, role: adminRole(), user };
  if (app.status !== 'published') return null;
  const role = (await listRoles(db, app.id)).find((r) => r.key === claims.role);
  if (!role) return null;
  const access: AppAccess = {
    app,
    screens,
    role: { key: role.key, name: role.name, permissions: role.permissions, admin: false },
    user,
  };
  return withPublishedVersion(db, access);
}

export function claimsOf(
  access: AppAccess,
  organizationId: string,
  name: string,
  opts: RunFunctionOptions,
): Omit<FnTokenClaims, 'v' | 'exp'> {
  const origin = opts.automation === undefined ? currentAutomationOrigin() : opts.automation;
  return {
    org: organizationId,
    app: access.app.id,
    actor: {
      kind: access.user.external ? 'external' : 'member',
      id: access.user.id,
      name: access.user.name,
    },
    role: access.role.key,
    attributes: access.user.attributes,
    ...(opts.screen ? { screen: opts.screen.id } : {}),
    readOnly: Boolean(opts.readOnly),
    fn: name,
    ...(origin && (origin.depth > 0 || origin.chain.length)
      ? { chain: origin.chain.slice(0, 16), depth: origin.depth }
      : {}),
  };
}

/** Corre la función y anota la corrida. Lanza sólo por precondiciones (sin código publicado, función inexistente); un error DE la función vuelve en `ok: false`. */
export async function runAppFunction(
  db: SupabaseClient,
  access: AppAccess,
  name: string,
  input: unknown,
  opts: RunFunctionOptions,
): Promise<FunctionOutcome> {
  assertFunctionName(name);
  const checked = checkFunctionInput(input);
  const organizationId = opts.organizationId ?? access.app.organization_id;
  if (!organizationId) throw new Error('runAppFunction: falta la empresa de la app.');

  const code = await getAppCode(db, access.app.id);
  if (!code) throw new NotFoundError('Esta aplicación todavía no tiene código.');
  const wantLatest = opts.build === 'latest';
  const build = wantLatest
    ? await latestOkBuild(db, code.id)
    : code.published_build_id
      ? await getBuild(db, code.id, code.published_build_id)
      : null;
  if (!build)
    throw new ValidationError(
      wantLatest
        ? 'No hay una compilación que haya salido bien. Compila primero.'
        : 'El código de esta aplicación no está publicado. Compila y publica para que las funciones corran.',
    );
  const js = build.functions[name];
  if (!js)
    throw new NotFoundError(
      `La función «${name}» no está en la compilación ${build.number}${wantLatest ? '' : ' (la publicada)'}. Escribe server/${name}.ts, compila y publica.`,
    );

  const secrets = await loadAppSecrets(db, access.app.id);
  const token = mintFnToken(claimsOf(access, organizationId, name, opts));
  const started = Date.now();
  let outcome: FunctionOutcome;
  try {
    const done = await getFunctionRunner().run({
      organizationId,
      appId: access.app.id,
      buildId: build.id,
      name,
      functions: build.functions,
      input: checked,
      secrets,
      user: {
        id: access.user.id,
        name: access.user.name,
        role: access.role.key,
        attributes: access.user.attributes,
      },
      token,
      timeoutMs: FN_TIMEOUT_MS,
      maxOutputBytes: FN_MAX_OUTPUT_BYTES,
    });
    const durationMs = Date.now() - started;
    outcome = {
      ok: done.ok,
      result: done.ok ? done.result : undefined,
      error: done.ok ? undefined : (done.error ?? 'La función falló.'),
      log: capLog(done.log ?? ''),
      durationMs,
      status: done.ok ? 'ok' : done.timedOut ? 'timeout' : 'error',
    };
  } catch (err) {
    // El runner (Sandbox) no pudo ni arrancar: no es un error de la función.
    logger.warn({ err, app: access.app.id, fn: name }, 'app-code: function runner failed');
    outcome = {
      ok: false,
      error: 'No se pudo ejecutar la función ahora. Intenta de nuevo.',
      log: '',
      durationMs: Date.now() - started,
      status: 'error',
    };
  }
  await recordRun(db, access.app.id, {
    functionName: name,
    trigger: opts.trigger,
    actor: opts.actorLabel ?? access.user.id,
    roleKey: access.role.key,
    buildNumber: build.number,
    status: outcome.status,
    durationMs: outcome.durationMs,
    log: outcome.log,
    error: outcome.error ?? null,
  });
  return outcome;
}

async function latestOkBuild(db: SupabaseClient, codeId: string) {
  const latest = await latestBuild(db, codeId);
  if (latest?.status === 'ok') return latest;
  // La última pudo fallar: se busca hacia atrás la más reciente que salió bien.
  const { data, error } = await db
    .from('custom_app_code_builds')
    .select('id')
    .eq('code_id', codeId)
    .eq('status', 'ok')
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return getBuild(db, codeId, (data as { id: string }).id);
}
