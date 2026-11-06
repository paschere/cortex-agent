'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type GithubLink,
  StaleCodeError,
  createIntegrationsClient,
  ensureAppCode,
  getAppCode,
  githubLinkOf,
  listGithubBranches,
  listGithubRepos,
  mustGetApp,
  normalizeTarget,
  pullFilesFromGithub,
  pushFilesToGithub,
  saveAppCodeFiles,
  setGithubLink,
  viewerFromSession,
} from '@cortex/agent-tools';
import {
  ForbiddenError,
  IntegrationError,
  NotFoundError,
  ValidationError,
  logger,
} from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * SINCRONIZAR EL CÓDIGO DE UNA APP CON GITHUB (apps con código, fase 4).
 *
 * Sólo owner/admin. Se usa la conexión de GitHub de quien pulsa el botón
 * (Integraciones, permiso «repo»): cada commit queda a su nombre en GitHub.
 * `enviar` hace un commit con el borrador; `traer` reemplaza el borrador con
 * la carpeta de la rama (rechazado si el borrador cambió desde que se leyó).
 * Ninguna de las dos publica ni compila.
 */

export type GithubActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; stale?: boolean };

function describe(err: unknown, fallback: string): string {
  if (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof ForbiddenError
  )
    return err.message;
  if (err instanceof IntegrationError) {
    if (/No github integration|No refresh token|No refresher/i.test(err.message))
      return 'Conecta tu cuenta de GitHub en Integraciones (con el permiso «repo») y vuelve a intentarlo.';
    return err.message.length < 300 ? err.message : fallback;
  }
  return fallback;
}

async function gate(appRef: string) {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    throw new ForbiddenError(
      'Sólo quien administra la empresa puede sincronizar el código con GitHub.',
    );
  const db = getOrgScopedClient(user.organization.id);
  const app = await mustGetApp(db, appRef);
  const integrations = createIntegrationsClient(db, user.id, logger);
  const token = async () => (await integrations.getAccessToken('github')).token;
  return { user, db, app, token };
}

const touched = (app: { id: string; slug: string }) => revalidatePath(`/apps/${app.id}/edit`);

/** Repos a los que tiene acceso la cuenta de GitHub conectada. */
export async function githubRepos(appRef: string): Promise<
  GithubActionResult<{
    repos: Array<{ fullName: string; defaultBranch: string; private: boolean }>;
  }>
> {
  try {
    const { token } = await gate(appRef);
    return { ok: true, repos: await listGithubRepos(await token()) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron listar tus repos de GitHub.') };
  }
}

/** Ramas de un repo. */
export async function githubBranches(
  appRef: string,
  repo: string,
): Promise<GithubActionResult<{ branches: string[] }>> {
  try {
    const { token } = await gate(appRef);
    return { ok: true, branches: await listGithubBranches(await token(), repo) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron listar las ramas.') };
  }
}

const linkInput = z.object({
  repo: z.string().trim().min(3).max(140),
  branch: z.string().trim().min(1).max(120),
  path: z.string().trim().max(150).optional(),
});

/** Conecta el proyecto con un repo, rama y carpeta (comprueba que la rama exista y se pueda leer). */
export async function connectGithub(
  appRef: string,
  raw: z.input<typeof linkInput>,
): Promise<GithubActionResult<{ github: GithubLink }>> {
  try {
    const input = linkInput.parse(raw);
    const { user, db, app, token } = await gate(appRef);
    const target = normalizeTarget(input);
    // Una lectura de prueba: falla con un mensaje claro si no hay acceso o no existe la rama.
    const probe = await pullFilesFromGithub({ ...target, token: await token() });
    const code = await setGithubLink(db, app.id, user.id, { ...target, lastSha: probe.sha });
    touched(app);
    const github = githubLinkOf(code);
    if (!github) throw new Error('No se pudo guardar el vínculo.');
    return { ok: true, github };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo conectar con GitHub.') };
  }
}

/** Quita el vínculo (no borra nada en GitHub ni en el borrador). */
export async function disconnectGithub(appRef: string): Promise<GithubActionResult> {
  try {
    const { user, db, app } = await gate(appRef);
    await setGithubLink(db, app.id, user.id, null);
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo desconectar.') };
  }
}

/** Un commit con los archivos del borrador guardado en la carpeta de la rama. */
export async function pushToGithub(
  appRef: string,
  message?: string,
): Promise<
  GithubActionResult<{
    sha: string;
    url: string;
    committed: boolean;
    summary: string;
    github: GithubLink;
  }>
> {
  try {
    const { user, db, app, token } = await gate(appRef);
    const code = await getAppCode(db, app.id);
    const link = githubLinkOf(code);
    if (!code || !link)
      throw new ValidationError('Primero conecta el código con un repo de GitHub.');
    const text = (message ?? '').trim().slice(0, 200) || `Cortex: ${app.name} — actualizar código`;
    const res = await pushFilesToGithub({ ...link, token: await token() }, code.files, text);
    const next = githubLinkOf(
      await setGithubLink(db, app.id, user.id, { ...link, lastSha: res.sha }),
    );
    touched(app);
    return {
      ok: true,
      sha: res.sha,
      url: res.url,
      committed: res.committed,
      summary: res.committed
        ? `Commit enviado: ${res.added} nuevos, ${res.changed} cambiados, ${res.removed} borrados.`
        : 'GitHub ya tenía exactamente estos archivos.',
      github: next ?? link,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo enviar a GitHub.') };
  }
}

/**
 * Reemplaza el borrador con la carpeta de la rama. `baseUpdatedAt` es la
 * revisión del borrador que ve el editor: si cambió, no se pisa.
 */
export async function pullFromGithub(
  appRef: string,
  baseUpdatedAt: string | null,
): Promise<
  GithubActionResult<{
    files: Record<string, string>;
    updatedAt: string;
    skipped: string[];
    github: GithubLink;
  }>
> {
  try {
    const { user, db, app, token } = await gate(appRef);
    const existing = await getAppCode(db, app.id);
    const code = existing ?? (await ensureAppCode(db, app.id, user.id));
    const link = githubLinkOf(code);
    if (!link) throw new ValidationError('Primero conecta el código con un repo de GitHub.');
    const pulled = await pullFilesFromGithub({ ...link, token: await token() });
    if (!Object.keys(pulled.files).length)
      throw new ValidationError(
        `No encontré archivos en «${link.path || '/'}» de ${link.repo}@${link.branch}.`,
      );
    const gone = Object.keys(code.files).filter((p) => !(p in pulled.files));
    // Sólo se reescribe lo que de verdad cambió (el autor por archivo no se ensucia).
    const write = Object.fromEntries(
      Object.entries(pulled.files).filter(([p, c]) => code.files[p] !== c),
    );
    const saved = await saveAppCodeFiles(db, app.id, { write, remove: gone }, user.id, {
      baseUpdatedAt: existing ? baseUpdatedAt : undefined,
      author: user.id,
    });
    const next = githubLinkOf(
      await setGithubLink(db, app.id, user.id, { ...link, lastSha: pulled.sha }),
    );
    touched(app);
    return {
      ok: true,
      files: saved.files,
      updatedAt: saved.updated_at,
      skipped: pulled.skipped,
      github: next ?? link,
    };
  } catch (err) {
    if (err instanceof StaleCodeError) return { ok: false, error: err.message, stale: true };
    return { ok: false, error: describe(err, 'No se pudo traer el código de GitHub.') };
  }
}
