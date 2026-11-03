'use server';

import { ensureAppDbDriver } from '@/lib/apps/app-db-driver';
import { buildCodeDeps } from '@/lib/apps/code-builder';
import { ensureFunctionRunner } from '@/lib/apps/function-runner';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getCodeBuildDeps } from '@cortex/agent-tools';
import {
  ADMIN_ROLE_KEY,
  type AppCodeBuildSummary,
  type AppDbStatus,
  CORTEX_AUTHOR,
  StaleCodeError,
  addCodeScreen as addCodeScreenInStore,
  appDbStatus,
  applyAppDbMigrations,
  assertSecretName,
  buildAppCode,
  deleteHook,
  ensureAppCode,
  functionNames,
  functionPath,
  getAppCode,
  githubLinkOf,
  listBuilds,
  listHooks,
  listRoles,
  listRunRows,
  listScreens,
  listSecretNames,
  mustGetApp,
  publishAppCodeWithMigrations,
  runAppDbQuery,
  runAppFunction,
  saveAppCodeFiles,
  setAppSecret,
  testAppAccess,
  upsertHook,
  viewerFromSession,
} from '@cortex/agent-tools';
import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * LO QUE HACEN LOS BOTONES DEL EDITOR DE CÓDIGO de una app (0243).
 *
 * Sólo quien administra la empresa (owner/admin): el código de una pantalla
 * decide qué ven y escriben, con su rol, las personas que la abren. Cada acción
 * resuelve la sesión y la app en el servidor y devuelve `{ ok: true, … }` o
 * `{ ok: false, error }` con el mensaje en español, igual que lib/apps/actions.ts.
 * Nada de lo que se guarda o compila llega a los usuarios hasta `publish`.
 */

export type CodeActionResult<T = object> =
  | ({ ok: true } & T)
  /** `stale`: alguien cambió el código mientras editabas (guardado con una revisión vieja). */
  | { ok: false; error: string; stale?: boolean };

export interface CodeScreenInfo {
  id: string;
  slug: string;
  title: string;
  /** Ruta del archivo de entrada, p.ej. `screens/torre.tsx`. */
  codeEntry: string | null;
}

export interface CodeBuildInfo {
  id: string;
  number: number;
  status: 'ok' | 'error';
  log: string;
  createdAt: string;
  /** Es la compilación que ven los usuarios. */
  published: boolean;
}

/** Quién tocó por última vez un archivo del borrador (0245). */
export interface CodeFileAuthor {
  by: 'cortex' | 'me' | 'other';
  at: string;
}

export interface CodeGithubLink {
  repo: string;
  branch: string;
  path: string;
  lastSha: string | null;
}

export interface CodeSnapshot {
  appId: string;
  /** Archivos del borrador: ruta → contenido. */
  files: Record<string, string>;
  screens: CodeScreenInfo[];
  /** Las últimas compilaciones, de la más nueva a la más vieja (sin bundles). */
  builds: CodeBuildInfo[];
  publishedBuildId: string | null;
  sdkVersion: string;
  /** Revisión del borrador: el editor la manda al guardar (concurrencia optimista). */
  updatedAt: string | null;
  /** Último autor por archivo. */
  fileAuthors: Record<string, CodeFileAuthor>;
  /** Vínculo con GitHub, o null si no está conectado. */
  github: CodeGithubLink | null;
}

function describe(err: unknown, fallback: string): string {
  if (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof ForbiddenError
  )
    return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 240 && !/[{}]|relation|column|violates/.test(message)
    ? message
    : fallback;
}

async function gate(appRef: string) {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    throw new ForbiddenError(
      'Sólo quien administra la empresa puede cambiar el código de una aplicación.',
    );
  const db = getOrgScopedClient(user.organization.id);
  const app = await mustGetApp(db, appRef);
  return { user, db, app };
}

function touched(app: { id: string; slug: string }) {
  revalidatePath(`/apps/${app.id}/edit`);
  revalidatePath(`/apps/${app.slug}`);
}

const toBuildInfo = (b: AppCodeBuildSummary, publishedId: string | null): CodeBuildInfo => ({
  id: b.id,
  number: b.number,
  status: b.status,
  log: b.log,
  createdAt: b.created_at,
  published: b.id === publishedId,
});

async function snapshotOf(
  db: ReturnType<typeof getOrgScopedClient>,
  appId: string,
  userId: string,
): Promise<CodeSnapshot> {
  const code = await getAppCode(db, appId);
  const screens = (await listScreens(db, appId))
    .filter((s) => s.kind === 'code')
    .map((s) => ({ id: s.id, slug: s.slug, title: s.title, codeEntry: s.codeEntry }));
  const builds = code ? await listBuilds(db, code.id, 30) : [];
  return {
    appId,
    files: code?.files ?? {},
    screens,
    builds: builds.map((b) => toBuildInfo(b, code?.published_build_id ?? null)),
    publishedBuildId: code?.published_build_id ?? null,
    sdkVersion: code?.sdk_version ?? '1',
    updatedAt: code?.updated_at ?? null,
    fileAuthors: Object.fromEntries(
      Object.entries(code?.file_meta ?? {}).map(([path, m]) => [
        path,
        { by: m.by === CORTEX_AUTHOR ? 'cortex' : m.by === userId ? 'me' : 'other', at: m.at },
      ]),
    ),
    github: githubLinkOf(code),
  };
}

/**
 * El proyecto de código de la app: borrador, pantallas con código y compilaciones.
 * Devuelve el resumen directo (no el `{ok}` de las demás): si no hay permiso o
 * la app no existe, LANZA con el mensaje en español, que el editor muestra.
 */
export async function readCode(appRef: string): Promise<CodeSnapshot> {
  try {
    const { user, db, app } = await gate(appRef);
    return await snapshotOf(db, app.id, user.id);
  } catch (err) {
    throw new Error(describe(err, 'No se pudo leer el código de la aplicación.'));
  }
}

const filesInput = z.object({
  /** Revisión (`updatedAt`) del borrador sobre la que se editó; si cambió, se rechaza. */
  baseUpdatedAt: z.string().nullable().optional(),
  write: z.record(z.string(), z.string()).optional(),
  remove: z.array(z.string()).max(200).optional(),
});

/** Escribe y/o borra archivos del borrador (cada `write` reemplaza el archivo entero). */
export async function saveFiles(
  appRef: string,
  raw: z.input<typeof filesInput>,
): Promise<CodeActionResult<{ files: Record<string, string>; updatedAt: string }>> {
  try {
    const changes = filesInput.parse(raw);
    const { user, db, app } = await gate(appRef);
    const code = await saveAppCodeFiles(
      db,
      app.id,
      { write: changes.write, remove: changes.remove },
      user.id,
      { baseUpdatedAt: changes.baseUpdatedAt, author: user.id },
    );
    touched(app);
    return { ok: true, files: code.files, updatedAt: code.updated_at };
  } catch (err) {
    if (err instanceof StaleCodeError) return { ok: false, error: err.message, stale: true };
    return { ok: false, error: describe(err, 'No se pudieron guardar los archivos.') };
  }
}

/**
 * Compila el borrador (Vercel Sandbox: puede tardar un par de minutos) y guarda
 * la compilación, buena o mala; el log de una mala trae el archivo, la línea y el mensaje.
 */
export async function build(appRef: string): Promise<CodeActionResult<{ build: CodeBuildInfo }>> {
  try {
    const { user, db, app } = await gate(appRef);
    // En el servidor que no pasó por instrumentation (local, pruebas) se arma al vuelo.
    let deps: ReturnType<typeof getCodeBuildDeps>;
    try {
      deps = getCodeBuildDeps();
    } catch {
      deps = buildCodeDeps();
    }
    const done = await buildAppCode(db, app.id, user.id, deps.builder, deps.sdkSource);
    touched(app);
    const code = await getAppCode(db, app.id);
    return {
      ok: true,
      build: {
        id: done.id,
        number: done.number,
        status: done.status,
        log: done.log,
        createdAt: done.created_at,
        published: done.id === code?.published_build_id,
      },
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo compilar. Intenta de nuevo.') };
  }
}

/** Publica una compilación que salió bien: desde ya la ven los usuarios de las pantallas con código. */
export async function publish(
  appRef: string,
  buildId: string,
): Promise<
  CodeActionResult<{ publishedBuildId: string; number: number; migrationsApplied: string[] }>
> {
  try {
    const { user, db, app } = await gate(appRef);
    // Si la compilación trae migraciones (db/migrations) se aplican antes; si una falla, no se publica nada.
    ensureAppDbDriver();
    const { build: published, migrationsApplied } = await publishAppCodeWithMigrations(
      db,
      app.id,
      buildId,
      user.id,
    );
    touched(app);
    return {
      ok: true,
      publishedBuildId: published.id,
      number: published.number,
      migrationsApplied,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo publicar la compilación.') };
  }
}

const screenInput = z.object({
  title: z.string().trim().min(1).max(60),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,47}$/)
    .optional(),
  icon: z.string().trim().max(60).optional(),
  roles: z.array(z.string().trim().min(1).max(32)).max(8).optional(),
});

/** Agrega una pantalla con código (con su archivo de arranque) al menú de la app. */
export async function addCodeScreen(
  appRef: string,
  raw: z.input<typeof screenInput>,
): Promise<
  CodeActionResult<{ screen: CodeScreenInfo; files: Record<string, string>; updatedAt: string }>
> {
  try {
    const input = screenInput.parse(raw);
    const { user, db, app } = await gate(appRef);
    const screen = await addCodeScreenInStore(db, app, { ...input, userId: user.id });
    const code = await ensureAppCode(db, app.id, user.id);
    touched(app);
    return {
      ok: true,
      screen: {
        id: screen.id,
        slug: screen.slug,
        title: screen.title,
        codeEntry: screen.codeEntry,
      },
      files: code.files,
      updatedAt: code.updated_at,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo agregar la pantalla.') };
  }
}

// ---------------------------------------------------------------------------
// Fase 2: funciones de servidor — secretos, corridas, prueba y webhooks (0244)
// ---------------------------------------------------------------------------

export interface CodeSecretInfo {
  name: string;
  updatedAt: string;
}

/** Los secretos de la app: SOLO nombre y fecha. El valor no vuelve nunca al navegador. Lanza si no hay permiso. */
export async function listSecrets(appRef: string): Promise<CodeSecretInfo[]> {
  try {
    const { db, app } = await gate(appRef);
    return await listSecretNames(db, app.id);
  } catch (err) {
    throw new Error(describe(err, 'No se pudieron leer los secretos.'));
  }
}

/**
 * Pone o reemplaza un secreto (`value` texto) o lo borra (`null`). El nombre va
 * en MAYÚSCULAS (SIIGO_API_KEY); la función lo lee en `ctx.secrets.SIIGO_API_KEY`.
 */
export async function setSecret(
  appRef: string,
  name: string,
  value: string | null,
): Promise<CodeActionResult> {
  try {
    const { user, db, app } = await gate(appRef);
    const clean = String(name ?? '').trim();
    assertSecretName(clean);
    await setAppSecret(db, app.id, clean, value, user.id);
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el secreto.') };
  }
}

export interface CodeRunInfo {
  id: string;
  function: string;
  trigger: 'screen' | 'rule' | 'schedule' | 'webhook' | 'chat';
  actor: string | null;
  role: string | null;
  buildNumber: number | null;
  status: 'ok' | 'error' | 'timeout';
  durationMs: number;
  log: string;
  error: string | null;
  createdAt: string;
}

/** Las últimas corridas de funciones (más nueva primero). Sin secretos: el log lo escribe la función. Lanza si no hay permiso. */
export async function listRuns(
  appRef: string,
  opts: { limit?: number; function?: string } = {},
): Promise<CodeRunInfo[]> {
  try {
    const { db, app } = await gate(appRef);
    const rows = await listRunRows(db, app.id, {
      limit: opts.limit ?? 50,
      functionName: opts.function,
    });
    return rows.map((r) => ({
      id: r.id,
      function: r.function_name,
      trigger: r.trigger,
      actor: r.actor,
      role: r.role_key,
      buildNumber: r.build_number,
      status: r.status,
      durationMs: r.duration_ms,
      log: r.log,
      error: r.error,
      createdAt: r.created_at,
    }));
  } catch (err) {
    throw new Error(describe(err, 'No se pudieron leer las corridas.'));
  }
}

/**
 * Prueba una función a mano con una entrada. Corre de verdad (lee y ESCRIBE
 * filas reales por `ctx.cortex`) con el rol `opts.role` o, si no se da, como
 * administrador. Por omisión usa la última compilación buena (para probar antes
 * de publicar); `opts.published` usa la publicada.
 */
export async function runFunction(
  appRef: string,
  name: string,
  input: unknown,
  opts: { role?: string; published?: boolean } = {},
): Promise<
  | { ok: true; result: unknown; log: string; durationMs: number }
  | { ok: false; error: string; log: string }
> {
  try {
    const { user, db, app } = await gate(appRef);
    ensureFunctionRunner();
    const access = await testAppAccess(
      db,
      app,
      { id: user.id, name: user.name ?? 'Administrador' },
      opts.role,
    );
    const out = await runAppFunction(db, access, name, input ?? {}, {
      trigger: 'chat',
      build: opts.published ? 'published' : 'latest',
      organizationId: user.organization.id,
      actorLabel: `${user.name ?? user.id} (prueba)`,
    });
    return out.ok
      ? { ok: true, result: out.result ?? null, log: out.log, durationMs: out.durationMs }
      : { ok: false, error: out.error ?? 'La función falló.', log: out.log };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo correr la función.'), log: '' };
  }
}

export interface CodeWebhookInfo {
  name: string;
  role: string;
  url: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function hookUrl(appId: string, name: string): string {
  const base = (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/apps/${appId}/code/hooks/${name}`;
}

/** Los webhooks de la app (sin token: sólo se ve al crearlo). Lanza si no hay permiso. */
export async function listWebhooks(appRef: string): Promise<CodeWebhookInfo[]> {
  try {
    const { db, app } = await gate(appRef);
    return (await listHooks(db, app.id)).map((h) => ({
      name: h.name,
      role: h.role_key,
      url: hookUrl(app.id, h.name),
      createdAt: h.created_at,
      lastUsedAt: h.last_used_at,
    }));
  } catch (err) {
    throw new Error(describe(err, 'No se pudieron leer los webhooks.'));
  }
}

/**
 * Crea el webhook de una función (o lo rota: el token anterior deja de servir).
 * Corre con `role` —un rol de la app, nunca el administrador— a nombre de quien
 * lo crea. El token sale UNA vez, aquí.
 */
export async function createWebhook(
  appRef: string,
  input: { name: string; role: string },
): Promise<CodeActionResult<{ url: string; token: string }>> {
  try {
    const { user, db, app } = await gate(appRef);
    const name = String(input.name ?? '').trim();
    const role = String(input.role ?? '').trim();
    const code = await getAppCode(db, app.id);
    if (!code || !(functionPath(name) in code.files))
      throw new ValidationError(`La app no tiene la función «${name}» (server/${name}.ts).`);
    if (role === ADMIN_ROLE_KEY)
      throw new ValidationError('Un webhook no corre como administrador: elige un rol de la app.');
    if (!(await listRoles(db, app.id)).some((r) => r.key === role))
      throw new ValidationError(`El rol «${role}» no existe en esta app.`);
    const { token } = await upsertHook(db, app.id, { name, roleKey: role, userId: user.id });
    touched(app);
    return { ok: true, url: hookUrl(app.id, name), token };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo crear el webhook.') };
  }
}

/** Borra el webhook de una función: su URL deja de responder. */
export async function deleteWebhook(appRef: string, name: string): Promise<CodeActionResult> {
  try {
    const { db, app } = await gate(appRef);
    await deleteHook(db, app.id, String(name ?? '').trim());
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo borrar el webhook.') };
  }
}

// ---------------------------------------------------------------------------
// Fase 3: base de datos propia (0246)
// ---------------------------------------------------------------------------

export type CodeDbStatus = AppDbStatus;

/**
 * El estado de la base propia: esquema, tamaño contra la cuota, migraciones
 * aplicadas y las del borrador que faltan. Lanza (mensaje en español) si no hay permiso.
 */
export async function dbStatus(appRef: string): Promise<CodeDbStatus> {
  try {
    const { db, app } = await gate(appRef);
    ensureAppDbDriver();
    const code = await getAppCode(db, app.id);
    return await appDbStatus(db, app.id, code?.files ?? {});
  } catch (err) {
    throw new Error(describe(err, 'No se pudo leer el estado de la base de datos.'));
  }
}

/**
 * Aplica las migraciones pendientes del BORRADOR (cada una en su transacción,
 * como el rol de la app). Para probar antes de publicar; publicar aplica las de
 * la compilación publicada.
 */
export async function applyMigrations(
  appRef: string,
): Promise<CodeActionResult<{ applied: string[]; warnings: string[] }>> {
  try {
    const { user, db, app } = await gate(appRef);
    ensureAppDbDriver();
    const code = await getAppCode(db, app.id);
    const out = await applyAppDbMigrations(db, app.id, code?.files ?? {}, user.id);
    touched(app);
    return { ok: true, applied: out.applied, warnings: out.warnings };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron aplicar las migraciones.') };
  }
}

export interface CodeDbQueryResult {
  fields: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

/** Consola de administración: UNA consulta de sólo lectura sobre la base propia (10 s, 1000 filas). */
export async function dbQuery(
  appRef: string,
  sql: string,
): Promise<CodeActionResult<CodeDbQueryResult>> {
  try {
    const { db, app } = await gate(appRef);
    ensureAppDbDriver();
    const out = await runAppDbQuery(db, app.id, { sql: String(sql ?? ''), readOnly: true });
    return {
      ok: true,
      fields: out.fields,
      // Fechas y bigint a texto: el resultado cruza a un componente de cliente.
      rows: JSON.parse(
        JSON.stringify(out.rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ),
      rowCount: out.rowCount,
      truncated: out.truncated,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo consultar la base de datos.') };
  }
}
