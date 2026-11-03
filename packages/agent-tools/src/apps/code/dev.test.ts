import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  type Fetcher,
  gitBlobSha,
  isProjectFile,
  normalizeTarget,
  pullFilesFromGithub,
  pushFilesToGithub,
} from './github';
import {
  CORTEX_AUTHOR,
  StaleCodeError,
  ensureAppCode,
  getAppCode,
  githubLinkOf,
  humanChangedFiles,
  isStaleBase,
  saveAppCodeFiles,
  setGithubLink,
} from './store';

const ORG = 'org-postal';
const APP = '11111111-1111-4111-8111-111111111111';

function world() {
  const fake = createFakeSupabase({
    custom_apps: [
      {
        id: APP,
        organization_id: ORG,
        slug: 'planta',
        name: 'Planta',
        description: '',
        icon: '🏭',
        theme: {},
        home_screen: null,
        status: 'draft',
        version: 1,
        created_by: null,
        updated_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
        archived_at: null,
      },
    ],
    custom_app_screens: [],
    custom_views: [],
    custom_view_versions: [],
    custom_app_code: [],
    custom_app_code_builds: [],
  });
  return { db: createOrgScopedClient(fake.client, ORG) };
}

describe('concurrencia optimista del borrador', () => {
  it('isStaleBase: sin base no controla; null = proyecto nuevo; compara instantes', () => {
    expect(isStaleBase(undefined, '2026-11-04T10:00:00.000Z')).toBe(false);
    expect(isStaleBase(null, null)).toBe(false);
    expect(isStaleBase(null, '2026-11-04T10:00:00.000Z')).toBe(true);
    expect(isStaleBase('2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00+00:00')).toBe(false);
    expect(isStaleBase('2026-11-04T10:00:00.000Z', '2026-11-04T10:00:01.000Z')).toBe(true);
  });

  it('rechaza un guardado basado en una revisión vieja y acepta el vigente', async () => {
    const { db } = world();
    const first = await saveAppCodeFiles(db, APP, { write: { 'lib/a.ts': '1' } }, 'u-dev');
    // Cortex escribe encima (otra revisión).
    await new Promise((r) => setTimeout(r, 5));
    const byCortex = await saveAppCodeFiles(db, APP, { write: { 'lib/b.ts': '2' } }, 'u-dev', {
      baseUpdatedAt: first.updated_at,
      author: CORTEX_AUTHOR,
    });
    expect(byCortex.updated_at).not.toBe(first.updated_at);
    // La persona sigue con la revisión vieja.
    await expect(
      saveAppCodeFiles(db, APP, { write: { 'lib/a.ts': '9' } }, 'u-dev', {
        baseUpdatedAt: first.updated_at,
      }),
    ).rejects.toBeInstanceOf(StaleCodeError);
    expect((await getAppCode(db, APP))?.files['lib/a.ts']).toBe('1');
    // Con la revisión vigente sí.
    const ok = await saveAppCodeFiles(db, APP, { write: { 'lib/a.ts': '9' } }, 'u-dev', {
      baseUpdatedAt: byCortex.updated_at,
    });
    expect(ok.files['lib/a.ts']).toBe('9');
  });

  it('anota el último autor por archivo y olvida los borrados', async () => {
    const { db } = world();
    await saveAppCodeFiles(db, APP, { write: { 'lib/a.ts': '1', 'lib/b.ts': '1' } }, 'u-dev');
    const code = await saveAppCodeFiles(
      db,
      APP,
      { write: { 'lib/b.ts': '2' }, remove: ['lib/a.ts'] },
      'u-dev',
      {
        author: CORTEX_AUTHOR,
      },
    );
    expect(code.file_meta['lib/b.ts']?.by).toBe('cortex');
    expect(code.file_meta['lib/a.ts']).toBeUndefined();
  });

  it('humanChangedFiles: sólo lo humano posterior a la última escritura de Cortex', () => {
    const files = { a: '', b: '', c: '' };
    const meta = {
      a: { by: 'cortex', at: '2026-11-04T10:00:00Z' },
      b: { by: 'u1', at: '2026-11-04T11:00:00Z' },
      c: { by: 'u1', at: '2026-11-04T09:00:00Z' },
    };
    expect(humanChangedFiles(meta, files)).toEqual([{ path: 'b', at: '2026-11-04T11:00:00Z' }]);
    // Si Cortex nunca escribió, todo lo humano cuenta.
    expect(humanChangedFiles({ c: meta.c }, files).map((f) => f.path)).toEqual(['c']);
  });

  it('guarda y quita el vínculo con GitHub', async () => {
    const { db } = world();
    await ensureAppCode(db, APP, 'u');
    const code = await setGithubLink(db, APP, 'u', {
      repo: 'a/b',
      branch: 'main',
      path: 'app',
      lastSha: 'abc',
    });
    expect(githubLinkOf(code)).toEqual({
      repo: 'a/b',
      branch: 'main',
      path: 'app',
      lastSha: 'abc',
    });
    expect(githubLinkOf(await setGithubLink(db, APP, 'u', null))).toBeNull();
  });
});

// --- GitHub con un repo falso en memoria ---------------------------------

function fakeGithub(initial: Record<string, string>) {
  const blobs = new Map<string, string>();
  const tree = new Map<string, string>(); // ruta -> sha de blob
  const put = (c: string) => {
    const sha = gitBlobSha(c);
    blobs.set(sha, c);
    return sha;
  };
  for (const [p, c] of Object.entries(initial)) tree.set(p, put(c));
  let head = 'c0';
  const trees = new Map<string, Map<string, string>>([['t0', new Map(tree)]]);
  const commits = new Map<string, { tree: string }>([['c0', { tree: 't0' }]]);
  const posts: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetcher: Fetcher = async (url, init) => {
    const u = url.replace('https://api.github.com/repos/o/r', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (u.startsWith('/git/ref/heads/main')) return json({ object: { sha: head } });
    if (u.startsWith('/git/ref/heads/')) return json({}, 404);
    let m = /^\/git\/commits\/(.+)$/.exec(u);
    if (m && method === 'GET')
      return json({ sha: m[1], tree: { sha: commits.get(m[1] as string)?.tree } });
    m = /^\/git\/trees\/(.+)\?recursive=1$/.exec(u);
    if (m)
      return json({
        tree: [...(trees.get(m[1] as string) ?? [])].map(([path, sha]) => ({
          path,
          type: 'blob',
          sha,
          size: (blobs.get(sha) ?? '').length,
        })),
      });
    m = /^\/git\/blobs\/(.+)$/.exec(u);
    if (m && method === 'GET')
      return json({
        content: Buffer.from(blobs.get(m[1] as string) ?? '').toString('base64'),
        encoding: 'base64',
      });
    if (u === '/git/blobs' && method === 'POST') {
      posts.push('blob');
      return json({ sha: put(body.content) });
    }
    if (u === '/git/trees' && method === 'POST') {
      posts.push('tree');
      const next = new Map(trees.get(body.base_tree));
      for (const e of body.tree) e.sha === null ? next.delete(e.path) : next.set(e.path, e.sha);
      const id = `t${trees.size}`;
      trees.set(id, next);
      return json({ sha: id });
    }
    if (u === '/git/commits' && method === 'POST') {
      posts.push('commit');
      const id = `c${commits.size}`;
      commits.set(id, { tree: body.tree });
      return json({ sha: id });
    }
    if (u.startsWith('/git/refs/heads/main') && method === 'PATCH') {
      head = body.sha;
      return json({});
    }
    return json({ message: 'no' }, 404);
  };
  return {
    fetcher,
    posts,
    current: () => new Map(trees.get(commits.get(head)?.tree as string)),
    blobs,
  };
}

describe('GitHub', () => {
  const target = { token: 't', repo: 'o/r', branch: 'main', path: 'app' };

  it('normaliza el destino', () => {
    expect(
      normalizeTarget({ repo: 'https://github.com/o/r.git', branch: 'main', path: '/app/' }),
    ).toEqual({
      repo: 'o/r',
      branch: 'main',
      path: 'app',
    });
    expect(() => normalizeTarget({ repo: 'solo', branch: 'main' })).toThrow();
    expect(() => normalizeTarget({ repo: 'o/r', branch: 'a..b' })).toThrow();
    expect(() => normalizeTarget({ repo: 'o/r', branch: 'main', path: '../x' })).toThrow();
  });

  it('envía un solo commit con lo cambiado, lo nuevo y lo borrado, sin tocar el resto del repo', async () => {
    const gh = fakeGithub({
      'README.md': 'hola',
      'app/screens/x.tsx': 'viejo',
      'app/lib/same.ts': 'igual',
      'app/lib/gone.ts': 'borrar',
    });
    const res = await pushFilesToGithub(
      { ...target, fetcher: gh.fetcher },
      { 'screens/x.tsx': 'nuevo', 'lib/same.ts': 'igual', 'lib/new.ts': 'n' },
      'Cortex: guardar',
    );
    expect(res).toMatchObject({ committed: true, added: 1, changed: 1, removed: 1, sha: 'c1' });
    expect(gh.posts.filter((p) => p === 'commit')).toHaveLength(1);
    expect(gh.posts.filter((p) => p === 'blob')).toHaveLength(2); // el igual no se resube
    const now = gh.current();
    expect([...now.keys()].sort()).toEqual([
      'README.md',
      'app/lib/new.ts',
      'app/lib/same.ts',
      'app/screens/x.tsx',
    ]);
  });

  it('no hace commit si no hay diferencias', async () => {
    const gh = fakeGithub({ 'app/a.ts': '1' });
    const res = await pushFilesToGithub({ ...target, fetcher: gh.fetcher }, { 'a.ts': '1' }, 'm');
    expect(res.committed).toBe(false);
    expect(gh.posts).toHaveLength(0);
  });

  it('trae la carpeta, salta ocultos, lockfiles y binarios', async () => {
    const gh = fakeGithub({
      'README.md': 'fuera',
      'app/screens/x.tsx': 'x',
      'app/package.json': '{}',
      'app/package-lock.json': '{}',
      'app/.env': 'S=1',
      'app/img.bin': 'a\u0000b',
    });
    const res = await pullFilesFromGithub({ ...target, fetcher: gh.fetcher });
    expect(Object.keys(res.files).sort()).toEqual(['package.json', 'screens/x.tsx']);
    expect(res.skipped.join()).toContain('img.bin');
    expect(res.sha).toBe('c0');
  });

  it('explica la rama que no existe', async () => {
    const gh = fakeGithub({});
    await expect(
      pullFilesFromGithub({ ...target, branch: 'otra', fetcher: gh.fetcher }),
    ).rejects.toThrow(/No encuentro/);
  });

  it('isProjectFile', () => {
    expect(isProjectFile('lib/a.ts')).toBe(true);
    expect(isProjectFile('.github/x.yml')).toBe(false);
    expect(isProjectFile('node_modules/a/b.js')).toBe(false);
    expect(isProjectFile('pnpm-lock.yaml')).toBe(false);
  });
});
