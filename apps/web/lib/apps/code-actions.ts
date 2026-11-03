'use server';

import { buildCodeDeps } from '@/lib/apps/code-builder';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getCodeBuildDeps } from '@cortex/agent-tools';
import {
  type AppCodeBuildSummary,
  addCodeScreen as addCodeScreenInStore,
  buildAppCode,
  ensureAppCode,
  getAppCode,
  listBuilds,
  listScreens,
  mustGetApp,
  publishAppCode,
  saveAppCodeFiles,
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

export type CodeActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

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

export interface CodeSnapshot {
  appId: string;
  /** Archivos del borrador: ruta → contenido. */
  files: Record<string, string>;
  screens: CodeScreenInfo[];
  /** Las últimas compilaciones, de la más nueva a la más vieja (sin bundles). */
  builds: CodeBuildInfo[];
  publishedBuildId: string | null;
  sdkVersion: string;
  updatedAt: string | null;
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
  };
}

/**
 * El proyecto de código de la app: borrador, pantallas con código y compilaciones.
 * Devuelve el resumen directo (no el `{ok}` de las demás): si no hay permiso o
 * la app no existe, LANZA con el mensaje en español, que el editor muestra.
 */
export async function readCode(appRef: string): Promise<CodeSnapshot> {
  try {
    const { db, app } = await gate(appRef);
    return await snapshotOf(db, app.id);
  } catch (err) {
    throw new Error(describe(err, 'No se pudo leer el código de la aplicación.'));
  }
}

const filesInput = z.object({
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
    const code = await saveAppCodeFiles(db, app.id, changes, user.id);
    touched(app);
    return { ok: true, files: code.files, updatedAt: code.updated_at };
  } catch (err) {
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
): Promise<CodeActionResult<{ publishedBuildId: string; number: number }>> {
  try {
    const { user, db, app } = await gate(appRef);
    const { build: published } = await publishAppCode(db, app.id, buildId, user.id);
    touched(app);
    return { ok: true, publishedBuildId: published.id, number: published.number };
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
): Promise<CodeActionResult<{ screen: CodeScreenInfo; files: Record<string, string> }>> {
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
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo agregar la pantalla.') };
  }
}
