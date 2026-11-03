import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cortex/core', async (orig) => ({
  ...(await orig<typeof import('@cortex/core')>()),
  encryptToken: (s: string) => `enc:${s}`,
  decryptToken: (s: string) => s.replace(/^enc:/, ''),
}));

import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { mustGetApp } from '../store';
import { type Builder, buildAppCode } from './build';
import { listRunRows, setAppSecret } from './function-store';
import {
  type FunctionJob,
  type FunctionRunner,
  setFunctionRunner,
  verifyFnToken,
} from './functions';
import { runAppFunction, systemAppAccess, testAppAccess } from './run-function';
import { addCodeScreen, publishAppCode, saveAppCodeFiles } from './store';

const ORG = 'org-postal';
const USER = 'u-admin';
const APP_ID = '11111111-1111-4111-8111-111111111111';

function world() {
  const fake = createFakeSupabase({
    custom_apps: [
      {
        id: APP_ID,
        organization_id: ORG,
        slug: 'planta',
        name: 'Planta',
        description: '',
        icon: '🏭',
        theme: {},
        home_screen: null,
        status: 'published',
        version: 1,
        created_by: USER,
        updated_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
        archived_at: null,
      },
    ],
    custom_app_screens: [],
    custom_app_roles: [
      {
        id: 'r1',
        organization_id: ORG,
        app_id: APP_ID,
        key: 'operario',
        name: 'Operario',
        position: 0,
        permissions: { tables: {}, export: false },
      },
    ],
    custom_views: [],
    custom_view_versions: [],
    custom_app_code: [],
    custom_app_code_builds: [],
    custom_app_code_secrets: [],
    custom_app_code_runs: [],
  });
  return createOrgScopedClient(fake.client, ORG);
}

const fnBuilder: Builder = {
  build: async (input) => ({
    ok: true,
    bundles: Object.fromEntries(Object.keys(input.entries).map((s) => [s, { js: '//', css: '' }])),
    functions: Object.fromEntries(Object.keys(input.functions).map((n) => [n, `//${n}`])),
    log: 'listo',
  }),
};

async function publishedWorld() {
  const db = world();
  const app = await mustGetApp(db, APP_ID);
  await addCodeScreen(db, app, { title: 'Torre', slug: 'torre', userId: USER });
  await saveAppCodeFiles(
    db,
    app.id,
    { write: { 'server/cobrar.ts': 'export default async () => 1' } },
    USER,
  );
  const build = await buildAppCode(db, app.id, USER, fnBuilder, '{}');
  expect(build.status).toBe('ok');
  expect(Object.keys(build.functions)).toEqual(['cobrar']);
  await publishAppCode(db, app.id, build.id, USER);
  return { db, app };
}

describe('runAppFunction', () => {
  const jobs: FunctionJob[] = [];
  const runner: FunctionRunner = {
    run: async (job) => {
      jobs.push(job);
      if (job.input && (job.input as { boom?: boolean }).boom)
        return { ok: false, error: 'Se cayó', log: 'traza' };
      return { ok: true, result: { cobrado: true }, log: 'listo' };
    },
  };
  beforeEach(() => {
    jobs.length = 0;
    process.env.JOBS_SECRET = 'secreto-de-prueba';
    setFunctionRunner(runner);
  });
  afterEach(() => setFunctionRunner(null));

  it('corre la publicada con el rol de quien llama, inyecta secretos y token, y anota la corrida', async () => {
    const { db, app } = await publishedWorld();
    await setAppSecret(db, app.id, 'SIIGO_KEY', 'k-123', USER);
    const access = await systemAppAccess(db, app, 'operario', USER, 'Regla «x»');
    const out = await runAppFunction(db, access, 'cobrar', { guia: 'G1' }, { trigger: 'rule' });
    expect(out).toMatchObject({ ok: true, result: { cobrado: true }, status: 'ok' });
    const job = jobs[0] as FunctionJob;
    expect(job.secrets).toEqual({ SIIGO_KEY: 'k-123' });
    expect(job.input).toEqual({ guia: 'G1' });
    expect(job.user?.role).toBe('operario');
    const claims = verifyFnToken(job.token);
    expect(claims).toMatchObject({ role: 'operario', app: app.id, fn: 'cobrar', readOnly: false });
    const [run] = await listRunRows(db, app.id);
    expect(run).toMatchObject({
      function_name: 'cobrar',
      trigger: 'rule',
      status: 'ok',
      role_key: 'operario',
    });
    expect(JSON.stringify(run)).not.toContain('k-123');
  });

  it('un error de la función vuelve como ok:false y queda en el registro', async () => {
    const { db, app } = await publishedWorld();
    const access = await testAppAccess(db, app, { id: USER, name: 'Admin' });
    const out = await runAppFunction(db, access, 'cobrar', { boom: true }, { trigger: 'chat' });
    expect(out).toMatchObject({ ok: false, error: 'Se cayó', status: 'error' });
    const [run] = await listRunRows(db, app.id);
    expect(run).toMatchObject({ status: 'error', error: 'Se cayó', trigger: 'chat' });
  });

  it('exige código publicado y una función que exista', async () => {
    const db = world();
    const app = await mustGetApp(db, APP_ID);
    const access = await testAppAccess(db, app, { id: USER, name: 'Admin' });
    await expect(runAppFunction(db, access, 'cobrar', {}, { trigger: 'chat' })).rejects.toThrow(
      /código/,
    );
    const p = await publishedWorld();
    const acc2 = await testAppAccess(p.db, p.app, { id: USER, name: 'Admin' });
    await expect(runAppFunction(p.db, acc2, 'otra', {}, { trigger: 'chat' })).rejects.toThrow(
      /no está en la compilación/,
    );
  });

  it('una regla o un webhook jamás corren como administrador ni con un rol inexistente', async () => {
    const { db, app } = await publishedWorld();
    await expect(systemAppAccess(db, app, 'administrador', USER, 'x')).rejects.toThrow(
      /administrador/,
    );
    await expect(systemAppAccess(db, app, 'fantasma', USER, 'x')).rejects.toThrow(/no existe/);
  });
});
