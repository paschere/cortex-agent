import { randomUUID } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type AppScreenRow, type CustomAppRow, addScreen, listScreens } from '../store';
import { type CodeFiles, applyFileChanges, screenFilePath, validateCodeFiles } from './files';

/**
 * Lectura y escritura de los proyectos de código de las apps (migración 0243).
 *
 * `db` es un handle con alcance de espacio (`getOrgScopedClient`): una app o
 * un proyecto de otra empresa simplemente no existe. Aquí no se decide quién
 * puede escribir código: eso es de las rutas y de las herramientas del chat
 * (sólo owner/admin). Lo que sí se decide aquí es que lo que se guarda tenga
 * forma (rutas, límites) y que lo publicado sea una compilación que salió bien.
 */

/** Cuántas compilaciones se conservan por proyecto (la publicada nunca se borra). */
export const MAX_BUILDS_KEPT = 30;

const CODE_COLUMNS =
  'id, app_id, files, file_meta, sdk_version, published_build_id, updated_by, updated_at, created_at, github_repo, github_branch, github_path, github_last_sha';
const BUILD_COLUMNS =
  'id, code_id, number, files, bundles, functions, status, log, created_by, created_at';
/** Para listar: sin los archivos ni los bundles, que pesan. */
const BUILD_LIST_COLUMNS = 'id, code_id, number, status, log, created_by, created_at';

export interface AppCodeRow {
  id: string;
  app_id: string;
  /** El borrador: {ruta: contenido}. */
  files: CodeFiles;
  sdk_version: string;
  published_build_id: string | null;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
  /** Quién cambió cada archivo por última vez: id del miembro o 'cortex' (0245). */
  file_meta: FileMeta;
  /** Vínculo con GitHub (0245); null mientras no se conecte. */
  github_repo: string | null;
  github_branch: string | null;
  github_path: string | null;
  github_last_sha: string | null;
}

/** Autor que se anota cuando escribe el agente. */
export const CORTEX_AUTHOR = 'cortex';

export type FileMeta = Record<string, { by: string; at: string }>;

/** La base del guardado ya no es la última: alguien (Cortex o una persona) cambió el código mientras tanto. */
export class StaleCodeError extends ValidationError {
  constructor(
    msg = 'Alguien cambió el código mientras editabas. Vuelve a leerlo antes de guardar.',
  ) {
    super(msg);
    this.name = 'StaleCodeError';
  }
}

export type BundleMap = Record<string, { js: string; css: string }>;
/** Las funciones de servidor compiladas de una compilación: {nombre: js (CommonJS, con sus paquetes dentro)}. */
export type FunctionBundles = Record<string, string>;

export interface AppCodeBuildRow {
  id: string;
  code_id: string;
  number: number;
  files: CodeFiles;
  bundles: BundleMap;
  /** Funciones de servidor compiladas (0244). */
  functions: FunctionBundles;
  status: 'ok' | 'error';
  log: string;
  created_by: string | null;
  created_at: string;
}

/** Una compilación sin archivos ni bundles (para listas). */
export type AppCodeBuildSummary = Omit<AppCodeBuildRow, 'files' | 'bundles' | 'functions'>;

function adaptCode(row: Record<string, unknown>): AppCodeRow {
  const files =
    row.files && typeof row.files === 'object' && !Array.isArray(row.files) ? row.files : {};
  return {
    ...(row as unknown as AppCodeRow),
    files: files as CodeFiles,
    sdk_version: typeof row.sdk_version === 'string' ? row.sdk_version : '1',
    published_build_id: typeof row.published_build_id === 'string' ? row.published_build_id : null,
    file_meta: adaptFileMeta(row.file_meta),
    github_repo: str(row.github_repo),
    github_branch: str(row.github_branch),
    github_path: str(row.github_path),
    github_last_sha: str(row.github_last_sha),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function adaptFileMeta(raw: unknown): FileMeta {
  const out: FileMeta = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [path, v] of Object.entries(raw)) {
    const m = v as { by?: unknown; at?: unknown } | null;
    if (m && typeof m.by === 'string' && typeof m.at === 'string')
      out[path] = { by: m.by, at: m.at };
  }
  return out;
}

function adaptBuild(row: Record<string, unknown>): AppCodeBuildRow {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    ...(row as unknown as AppCodeBuildRow),
    files: obj(row.files) as CodeFiles,
    bundles: obj(row.bundles) as BundleMap,
    functions: obj(row.functions) as FunctionBundles,
    status: row.status === 'ok' ? 'ok' : 'error',
    log: typeof row.log === 'string' ? row.log : '',
    number: Number(row.number ?? 0),
  };
}

/** El proyecto de código de la app, o null si todavía no tiene. */
export async function getAppCode(db: SupabaseClient, appId: string): Promise<AppCodeRow | null> {
  const { data, error } = await db
    .from('custom_app_code')
    .select(CODE_COLUMNS)
    .eq('app_id', appId)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptCode(data as Record<string, unknown>) : null;
}

/** El proyecto, creándolo vacío si la app aún no tiene. Dos llamadas a la vez terminan en la misma fila. */
export async function ensureAppCode(
  db: SupabaseClient,
  appId: string,
  userId: string,
): Promise<AppCodeRow> {
  const existing = await getAppCode(db, appId);
  if (existing) return existing;
  const { data, error } = await db
    .from('custom_app_code')
    .insert({ id: randomUUID(), app_id: appId, files: {}, updated_by: userId })
    .select(CODE_COLUMNS)
    .single();
  if (error) {
    // Otro la creó entre la lectura y el insert (índice único por app).
    if ((error as { code?: string }).code === '23505') {
      const again = await getAppCode(db, appId);
      if (again) return again;
    }
    throw error;
  }
  return adaptCode(data as Record<string, unknown>);
}

/**
 * Archivos que una persona cambió después de la última vez que escribió
 * Cortex (la marca más reciente de 'cortex'; si Cortex nunca escribió, todo
 * lo que tenga autor humano). Más nuevos primero, hasta 20.
 */
export function humanChangedFiles(
  meta: FileMeta,
  files: Record<string, string>,
): Array<{ path: string; at: string }> {
  let lastCortex = Number.NEGATIVE_INFINITY;
  for (const m of Object.values(meta))
    if (m.by === CORTEX_AUTHOR) lastCortex = Math.max(lastCortex, Date.parse(m.at) || 0);
  return Object.entries(meta)
    .filter(
      ([path, m]) =>
        path in files && m.by !== CORTEX_AUTHOR && (Date.parse(m.at) || 0) > lastCortex,
    )
    .map(([path, m]) => ({ path, at: m.at }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
}

/** ¿Dos marcas de tiempo son la misma? (la base devuelve microsegundos; JS, milisegundos). */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/**
 * La revisión del guardado coincide con la del borrador? `base === undefined`
 * = sin control (compatibilidad); `null` = «el proyecto aún no existía».
 */
export function isStaleBase(base: string | null | undefined, current: string | null): boolean {
  if (base === undefined) return false;
  return !sameInstant(base, current);
}

/**
 * Escribe y/o borra archivos del borrador. Valida rutas y límites sobre el
 * resultado completo. `write` reemplaza el archivo entero (no hay parches).
 *
 * Concurrencia optimista (0245): con `baseUpdatedAt` el guardado sólo procede
 * si el borrador sigue como lo leyó quien guarda; si no, lanza `StaleCodeError`.
 * `author` anota quién cambió cada archivo ('cortex' o el id del miembro; por
 * omisión, `userId`).
 */
export async function saveAppCodeFiles(
  db: SupabaseClient,
  appId: string,
  changes: { write?: Record<string, string>; remove?: string[] },
  userId: string,
  opts: { baseUpdatedAt?: string | null; author?: string } = {},
): Promise<AppCodeRow> {
  const existing = await getAppCode(db, appId);
  if (isStaleBase(opts.baseUpdatedAt, existing?.updated_at ?? null)) throw new StaleCodeError();
  const code = existing ?? (await ensureAppCode(db, appId, userId));
  const files = applyFileChanges(code.files, changes);
  const now = new Date().toISOString();
  const by = opts.author ?? userId;
  const meta: FileMeta = {};
  for (const [path, m] of Object.entries(code.file_meta)) if (path in files) meta[path] = m;
  for (const path of Object.keys(changes.write ?? {}))
    if (path in files) meta[path] = { by, at: now };
  let q = db
    .from('custom_app_code')
    .update({ files, file_meta: meta, updated_by: userId, updated_at: now })
    .eq('id', code.id);
  // Guardia atómica: si alguien escribió entre la lectura y este update, no toca nada.
  if (opts.baseUpdatedAt !== undefined) q = q.eq('updated_at', code.updated_at);
  const { data, error } = await q.select(CODE_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!data) throw new StaleCodeError();
  return adaptCode(data as Record<string, unknown>);
}

/** Las compilaciones del proyecto, de la más nueva a la más vieja, sin archivos ni bundles. */
export async function listBuilds(
  db: SupabaseClient,
  codeId: string,
  limit = MAX_BUILDS_KEPT,
): Promise<AppCodeBuildSummary[]> {
  const { data, error } = await db
    .from('custom_app_code_builds')
    .select(BUILD_LIST_COLUMNS)
    .eq('code_id', codeId)
    .order('number', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => {
    const {
      files: _f,
      bundles: _b,
      functions: _fn,
      ...rest
    } = adaptBuild(r as Record<string, unknown>);
    return rest;
  });
}

/** Una compilación completa (con bundles), o null si ya no está. */
export async function getBuild(
  db: SupabaseClient,
  codeId: string,
  buildId: string,
): Promise<AppCodeBuildRow | null> {
  const { data, error } = await db
    .from('custom_app_code_builds')
    .select(BUILD_COLUMNS)
    .eq('code_id', codeId)
    .eq('id', buildId)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptBuild(data as Record<string, unknown>) : null;
}

/** La última compilación, con bundles. */
export async function latestBuild(
  db: SupabaseClient,
  codeId: string,
): Promise<AppCodeBuildRow | null> {
  const { data, error } = await db
    .from('custom_app_code_builds')
    .select(BUILD_COLUMNS)
    .eq('code_id', codeId)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptBuild(data as Record<string, unknown>) : null;
}

/**
 * Guarda una compilación con el número siguiente y poda las viejas: quedan las
 * últimas `MAX_BUILDS_KEPT` y la publicada, que nunca se borra. El número sale
 * de leer el último + 1; si dos compilaciones chocan (índice único), reintenta.
 */
export async function recordBuild(
  db: SupabaseClient,
  code: Pick<AppCodeRow, 'id' | 'published_build_id'>,
  input: {
    files: CodeFiles;
    bundles: BundleMap;
    functions?: FunctionBundles;
    status: 'ok' | 'error';
    log: string;
    userId: string;
  },
): Promise<AppCodeBuildRow> {
  let row: AppCodeBuildRow | null = null;
  for (let attempt = 0; attempt < 4 && !row; attempt++) {
    const { data: last, error: lastError } = await db
      .from('custom_app_code_builds')
      .select('number')
      .eq('code_id', code.id)
      .order('number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;
    const number = Number((last as { number?: number } | null)?.number ?? 0) + 1;
    const { data, error } = await db
      .from('custom_app_code_builds')
      .insert({
        // El id lo pone el servidor y no la base: la compilación se devuelve y se publica por él.
        id: randomUUID(),
        code_id: code.id,
        number,
        files: input.files,
        bundles: input.bundles,
        functions: input.functions ?? {},
        status: input.status,
        log: input.log,
        created_by: input.userId,
      })
      .select(BUILD_COLUMNS)
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') continue;
      throw error;
    }
    row = adaptBuild(data as Record<string, unknown>);
  }
  if (!row) throw new Error('No se pudo numerar la compilación. Vuelve a intentarlo.');
  await pruneBuilds(db, code);
  return row;
}

/** Deja las últimas `MAX_BUILDS_KEPT` compilaciones y la publicada. */
async function pruneBuilds(
  db: SupabaseClient,
  code: Pick<AppCodeRow, 'id' | 'published_build_id'>,
): Promise<void> {
  const { data, error } = await db
    .from('custom_app_code_builds')
    .select('id')
    .eq('code_id', code.id)
    .order('number', { ascending: false });
  if (error) return;
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  const doomed = ids.slice(MAX_BUILDS_KEPT).filter((id) => id !== code.published_build_id);
  if (!doomed.length) return;
  // Podar no puede tumbar la compilación que acaba de salir bien.
  await db.from('custom_app_code_builds').delete().eq('code_id', code.id).in('id', doomed);
}

/** Publica una compilación: sólo las que salieron bien. Devuelve el proyecto ya actualizado. */
export async function publishAppCode(
  db: SupabaseClient,
  appId: string,
  buildId: string,
  userId: string,
): Promise<{ code: AppCodeRow; build: AppCodeBuildRow }> {
  const code = await getAppCode(db, appId);
  if (!code) throw new NotFoundError('Esta aplicación todavía no tiene código.');
  const build = await getBuild(db, code.id, buildId);
  if (!build) throw new NotFoundError('Esa compilación ya no existe.');
  if (build.status !== 'ok')
    throw new ValidationError(
      `La compilación ${build.number} falló; sólo se publican las que salieron bien.`,
    );
  const { data, error } = await db
    .from('custom_app_code')
    // `updated_at` es del borrador (control de concurrencia, 0245): publicar no lo mueve.
    .update({ published_build_id: build.id, updated_by: userId })
    .eq('id', code.id)
    .select(CODE_COLUMNS)
    .single();
  if (error) throw error;
  return { code: adaptCode(data as Record<string, unknown>), build };
}

// ---------------------------------------------------------------------------
// Vínculo con GitHub (0245)
// ---------------------------------------------------------------------------

export interface GithubLink {
  repo: string;
  branch: string;
  path: string;
  lastSha: string | null;
}

/** Guarda (o quita, con null) el vínculo con GitHub del proyecto. */
export async function setGithubLink(
  db: SupabaseClient,
  appId: string,
  userId: string,
  link: GithubLink | null,
): Promise<AppCodeRow> {
  const code = await ensureAppCode(db, appId, userId);
  const { data, error } = await db
    .from('custom_app_code')
    .update({
      github_repo: link?.repo ?? null,
      github_branch: link?.branch ?? null,
      github_path: link ? link.path : null,
      github_last_sha: link?.lastSha ?? null,
    })
    .eq('id', code.id)
    .select(CODE_COLUMNS)
    .single();
  if (error) throw error;
  return adaptCode(data as Record<string, unknown>);
}

/** El vínculo de un proyecto, o null si no está conectado. */
export function githubLinkOf(code: AppCodeRow | null): GithubLink | null {
  if (!code?.github_repo || !code.github_branch) return null;
  return {
    repo: code.github_repo,
    branch: code.github_branch,
    path: code.github_path ?? '',
    lastSha: code.github_last_sha,
  };
}

// ---------------------------------------------------------------------------
// Pantallas con código
// ---------------------------------------------------------------------------

/** La vista mínima de relleno de una pantalla con código: sirve de ancla de roles, orden y menú. */
function placeholderSpec(title: string) {
  return {
    version: 1,
    blocks: [
      {
        id: 'codigo',
        type: 'text',
        markdown: `**${title}** se muestra con código. Esta vista sólo la ancla en el menú.`,
      },
    ],
  };
}

/** El archivo con que nace una pantalla nueva (Cortex o el desarrollador lo reemplazan). */
export function starterScreenSource(title: string): string {
  return `import { useUser } from '@cortex/app-sdk';

export default function Screen() {
  const { user } = useUser();
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>${title.replace(/[`$\\<>{}]/g, '')}</h1>
      <p>Hola{user ? \`, \${user.name}\` : ''}.</p>
    </main>
  );
}
`;
}

/**
 * Crea una pantalla `code` en la app: la misma pantalla que `addScreen` (con
 * su vista mínima de relleno, orden, ícono y roles) marcada con `kind: 'code'`
 * y su entrada. Si el archivo de la entrada no existe en el borrador, lo crea
 * con una pantalla de arranque.
 */
export async function addCodeScreen(
  db: SupabaseClient,
  app: CustomAppRow,
  input: {
    title: string;
    slug?: string;
    icon?: string;
    roles?: string[];
    userId: string;
    /** Archivo de entrada; por omisión `screens/<slug>.tsx`. */
    entry?: string;
  },
): Promise<AppScreenRow> {
  const screen = await addScreen(db, app, {
    title: input.title,
    slug: input.slug,
    icon: input.icon,
    roles: input.roles,
    spec: placeholderSpec(input.title),
    userId: input.userId,
  });
  const entry = input.entry ?? screenFilePath(screen.slug);
  const { data, error } = await db
    .from('custom_app_screens')
    .update({ kind: 'code', code_entry: entry })
    .eq('app_id', app.id)
    .eq('id', screen.id)
    .select(
      'id, app_id, view_id, slug, title, icon, position, roles, kind, code_entry, created_at, updated_at',
    )
    .single();
  if (error) throw error;
  const code = await ensureAppCode(db, app.id, input.userId);
  if (!(entry in code.files))
    await saveAppCodeFiles(
      db,
      app.id,
      { write: { [entry]: starterScreenSource(input.title) } },
      input.userId,
    );
  const row = data as Record<string, unknown>;
  return {
    ...(row as unknown as AppScreenRow),
    roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
    position: Number(row.position ?? 0),
    kind: 'code',
    codeEntry: entry,
  };
}

/** Las pantallas de la app que son de código. */
export async function codeScreens(db: SupabaseClient, appId: string): Promise<AppScreenRow[]> {
  return (await listScreens(db, appId)).filter((s) => s.kind === 'code');
}

export { validateCodeFiles };
