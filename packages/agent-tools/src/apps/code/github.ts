import { createHash } from 'node:crypto';
import { IntegrationError, ValidationError } from '@cortex/core';
import {
  type CodeFiles,
  MAX_CODE_FILES,
  MAX_CODE_FILE_BYTES,
  pathProblem,
  validateCodeFiles,
} from './files';

/**
 * SINCRONIZAR EL CÓDIGO DE UNA APP CON UN REPO DE GITHUB (0245).
 *
 * Sólo la API REST de Git (refs / commits / trees / blobs) con el token que el
 * administrador ya conectó en Integraciones: un envío es UN commit con todos
 * los archivos del borrador, y traer reemplaza el borrador con la carpeta de
 * la rama. Nada aquí toca la base: el `fetch` se inyecta para probarlo sin red.
 *
 * Qué cuenta como «archivo del proyecto» en el repo (`isProjectFile`): texto
 * bajo la carpeta elegida, sin ocultos (.git, .github…), sin `node_modules` ni
 * lockfiles. Enviar sólo borra del repo lo que traer también traería y ya no
 * está en el borrador; el README y demás del repo nunca se tocan.
 */

const API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);
const CONCURRENCY = 8;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubTarget {
  token: string;
  /** «propietario/nombre». */
  repo: string;
  branch: string;
  /** Carpeta del repo ('' = la raíz). */
  path: string;
  fetcher?: Fetcher;
}

/** Valida y normaliza lo que el administrador escribe; devuelve el destino limpio o lanza en español. */
export function normalizeTarget(input: { repo: string; branch: string; path?: string }): {
  repo: string;
  branch: string;
  path: string;
} {
  const repo = input.repo
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
  if (!REPO_RE.test(repo)) throw new ValidationError('El repo va como «propietario/nombre».');
  const branch = input.branch.trim();
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/'))
    throw new ValidationError('El nombre de la rama no es válido.');
  const path = (input.path ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (path) {
    const problem = pathProblem(path);
    if (problem) throw new ValidationError(`La carpeta no es válida: ${problem}`);
  }
  return { repo, branch, path };
}

class Api {
  private readonly f: Fetcher;
  constructor(
    private readonly token: string,
    private readonly repo: string,
    fetcher?: Fetcher,
  ) {
    this.f = fetcher ?? ((url, init) => fetch(url, init));
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.f(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.ok) return (r.status === 204 ? {} : await r.json()) as T;
    const detail = await r.text().catch(() => '');
    if (r.status === 401)
      throw new IntegrationError(
        'GitHub rechazó la conexión. Vuelve a conectar GitHub en Integraciones.',
        'github',
      );
    if (r.status === 404)
      throw new ValidationError(
        `No encuentro «${this.repo}» o esa rama, o tu cuenta de GitHub no tiene acceso (se necesita el permiso «repo»).`,
      );
    if (r.status === 403 || r.status === 429)
      throw new IntegrationError(
        `GitHub negó la operación (${r.status}): revisa permisos del repo o el límite de uso. ${detail.slice(0, 160)}`,
        'github',
      );
    if (r.status === 409 || r.status === 422)
      throw new ValidationError(
        `GitHub no pudo aplicar el cambio (${r.status}): la rama pudo moverse mientras enviabas; inténtalo de nuevo. ${detail.slice(0, 160)}`,
      );
    throw new IntegrationError(`GitHub ${r.status}: ${detail.slice(0, 200)}`, 'github');
  }
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

/** SHA de blob de Git: sha1("blob <bytes>\0" + contenido). Permite no re-subir lo que ya está igual. */
export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** ¿Este archivo del repo (ruta relativa a la carpeta) es parte del proyecto? */
export function isProjectFile(rel: string): boolean {
  if (pathProblem(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return false;
  return !LOCKFILES.has(parts[parts.length - 1] ?? '');
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

async function readHead(api: Api, repo: string, branch: string) {
  const ref = await api.call<{ object: { sha: string } }>(
    'GET',
    `/repos/${repo}/git/ref/heads/${enc(branch)}`,
  );
  const commit = await api.call<{ sha: string; tree: { sha: string } }>(
    'GET',
    `/repos/${repo}/git/commits/${ref.object.sha}`,
  );
  return { commitSha: commit.sha, treeSha: commit.tree.sha };
}

async function readTree(api: Api, repo: string, treeSha: string): Promise<TreeEntry[]> {
  const tree = await api.call<{ tree: TreeEntry[]; truncated?: boolean }>(
    'GET',
    `/repos/${repo}/git/trees/${treeSha}?recursive=1`,
  );
  if (tree.truncated)
    throw new ValidationError(
      'El repo es demasiado grande para sincronizarlo entero; elige otra rama o un repo más pequeño.',
    );
  return tree.tree.filter((e) => e.type === 'blob');
}

const join = (folder: string, rel: string) => (folder ? `${folder}/${rel}` : rel);

/** Repos a los que el token tiene acceso (los 100 más recientes). */
export async function listGithubRepos(
  token: string,
  fetcher?: Fetcher,
): Promise<Array<{ fullName: string; defaultBranch: string; private: boolean }>> {
  const api = new Api(token, 'tus repos', fetcher);
  const rows = await api.call<
    Array<{ full_name: string; default_branch: string; private: boolean }>
  >(
    'GET',
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
  );
  return rows.map((r) => ({
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
}

/** Ramas de un repo (hasta 100). */
export async function listGithubBranches(
  token: string,
  repo: string,
  fetcher?: Fetcher,
): Promise<string[]> {
  const { repo: clean } = normalizeTarget({ repo, branch: 'main' });
  const api = new Api(token, clean, fetcher);
  const rows = await api.call<Array<{ name: string }>>(
    'GET',
    `/repos/${clean}/branches?per_page=100`,
  );
  return rows.map((r) => r.name);
}

export interface PushResult {
  sha: string;
  /** false = el repo ya tenía exactamente estos archivos (no se hizo commit). */
  committed: boolean;
  url: string;
  added: number;
  changed: number;
  removed: number;
}

/** Un commit con los archivos del borrador en la carpeta de la rama. */
export async function pushFilesToGithub(
  target: GithubTarget,
  files: CodeFiles,
  message: string,
): Promise<PushResult> {
  const { repo, branch, path: folder } = normalizeTarget(target);
  validateCodeFiles(files);
  const api = new Api(target.token, repo, target.fetcher);
  const head = await readHead(api, repo, branch);
  const existing = await readTree(api, repo, head.treeSha);
  const prefix = folder ? `${folder}/` : '';
  const remote = new Map<string, string>(); // ruta relativa -> sha
  for (const e of existing) {
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (isProjectFile(rel)) remote.set(rel, e.sha);
  }

  const entries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
  let added = 0;
  let changed = 0;
  const toUpload: Array<[string, string]> = [];
  for (const [rel, content] of Object.entries(files)) {
    const have = remote.get(rel);
    if (have === gitBlobSha(content)) continue;
    toUpload.push([rel, content]);
    if (have) changed++;
    else added++;
  }
  const uploaded = await pool(toUpload, async ([rel, content]) => {
    const blob = await api.call<{ sha: string }>('POST', `/repos/${repo}/git/blobs`, {
      content,
      encoding: 'utf-8',
    });
    return { rel, sha: blob.sha };
  });
  for (const u of uploaded)
    entries.push({ path: join(folder, u.rel), mode: '100644', type: 'blob', sha: u.sha });
  let removed = 0;
  for (const rel of remote.keys()) {
    if (rel in files) continue;
    removed++;
    entries.push({ path: join(folder, rel), mode: '100644', type: 'blob', sha: null });
  }

  if (!entries.length)
    return {
      sha: head.commitSha,
      committed: false,
      url: `https://github.com/${repo}/commit/${head.commitSha}`,
      added: 0,
      changed: 0,
      removed: 0,
    };

  const tree = await api.call<{ sha: string }>('POST', `/repos/${repo}/git/trees`, {
    base_tree: head.treeSha,
    tree: entries,
  });
  const commit = await api.call<{ sha: string }>('POST', `/repos/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [head.commitSha],
  });
  // Sin `force`: si la rama avanzó mientras tanto, GitHub lo rechaza (422) y no se pierde nada.
  await api.call('PATCH', `/repos/${repo}/git/refs/heads/${enc(branch)}`, {
    sha: commit.sha,
    force: false,
  });
  return {
    sha: commit.sha,
    committed: true,
    url: `https://github.com/${repo}/commit/${commit.sha}`,
    added,
    changed,
    removed,
  };
}

export interface PullResult {
  files: CodeFiles;
  sha: string;
  /** Rutas del repo que no se trajeron y por qué (demasiado grandes, ruta no válida, binarias…). */
  skipped: string[];
}

/** El contenido de la carpeta de la rama, listo para reemplazar el borrador. */
export async function pullFilesFromGithub(target: GithubTarget): Promise<PullResult> {
  const { repo, branch, path: folder } = normalizeTarget(target);
  const api = new Api(target.token, repo, target.fetcher);
  const head = await readHead(api, repo, branch);
  const tree = await readTree(api, repo, head.treeSha);
  const prefix = folder ? `${folder}/` : '';
  const skipped: string[] = [];
  const wanted: Array<{ rel: string; sha: string }> = [];
  for (const e of tree) {
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (!isProjectFile(rel)) continue;
    if ((e.size ?? 0) > MAX_CODE_FILE_BYTES) {
      skipped.push(`${rel} (pesa más de 512 KB)`);
      continue;
    }
    wanted.push({ rel, sha: e.sha });
  }
  if (wanted.length > MAX_CODE_FILES)
    throw new ValidationError(
      `La carpeta tiene ${wanted.length} archivos y el máximo es ${MAX_CODE_FILES}. Elige una carpeta más específica.`,
    );
  const files: CodeFiles = {};
  await pool(wanted, async ({ rel, sha }) => {
    const blob = await api.call<{ content: string; encoding: string }>(
      'GET',
      `/repos/${repo}/git/blobs/${sha}`,
    );
    const buf = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8');
    // Un archivo con bytes nulos o que no es UTF-8 válido no es código de texto.
    const text = buf.toString('utf8');
    if (buf.includes(0) || text.includes('�')) {
      skipped.push(`${rel} (no es texto)`);
      return;
    }
    files[rel] = text;
  });
  return { files: validateCodeFiles(files), sha: head.commitSha, skipped: skipped.sort() };
}
