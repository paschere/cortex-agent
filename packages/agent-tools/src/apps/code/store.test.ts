import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { listScreens, mustGetApp } from '../store';
import { type Builder, buildAppCode } from './build';
import {
  MAX_BUILDS_KEPT,
  addCodeScreen,
  ensureAppCode,
  getAppCode,
  listBuilds,
  publishAppCode,
  recordBuild,
  saveAppCodeFiles,
} from './store';

const ORG = 'org-postal';
const USER = 'u-admin';

function world() {
  const fake = createFakeSupabase({
    custom_apps: [
      {
        id: '11111111-1111-4111-8111-111111111111',
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
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

const okBuilder = (slugs: string[]): Builder => ({
  build: async () => ({
    ok: true,
    bundles: Object.fromEntries(slugs.map((s) => [s, { js: `/*${s}*/`, css: '' }])),
    log: 'listo',
  }),
});

describe('proyecto de código', () => {
  it('guarda y borra archivos del borrador y valida las rutas', async () => {
    const { db } = world();
    await saveAppCodeFiles(
      db,
      '11111111-1111-4111-8111-111111111111',
      { write: { 'lib/a.ts': '1', 'lib/b.ts': '2' } },
      USER,
    );
    const code = await saveAppCodeFiles(
      db,
      '11111111-1111-4111-8111-111111111111',
      { remove: ['lib/a.ts'] },
      USER,
    );
    expect(Object.keys(code.files)).toEqual(['lib/b.ts']);
    await expect(
      saveAppCodeFiles(
        db,
        '11111111-1111-4111-8111-111111111111',
        { write: { '../x.ts': '1' } },
        USER,
      ),
    ).rejects.toThrow();
    // Una sola fila por app.
    await ensureAppCode(db, '11111111-1111-4111-8111-111111111111', USER);
    expect(await getAppCode(db, '11111111-1111-4111-8111-111111111111')).not.toBeNull();
  });
});

describe('compilaciones', () => {
  it('numera 1, 2, 3 y poda dejando las últimas 30 y la publicada', async () => {
    const { db } = world();
    const code = await ensureAppCode(db, '11111111-1111-4111-8111-111111111111', USER);
    const first = await recordBuild(db, code, {
      files: {},
      bundles: { a: { js: 'x', css: '' } },
      status: 'ok',
      log: '',
      userId: USER,
    });
    expect(first.number).toBe(1);
    const published = await publishAppCode(
      db,
      '11111111-1111-4111-8111-111111111111',
      first.id,
      USER,
    );
    for (let i = 0; i < MAX_BUILDS_KEPT + 4; i++)
      await recordBuild(db, published.code, {
        files: {},
        bundles: {},
        status: 'error',
        log: 'x',
        userId: USER,
      });
    const kept = await listBuilds(db, code.id, 100);
    expect(kept.length).toBe(MAX_BUILDS_KEPT + 1);
    expect(kept.some((b) => b.id === first.id)).toBe(true);
    expect(kept[0]?.number).toBe(MAX_BUILDS_KEPT + 5);
  });
  it('sólo se publican las que salieron bien', async () => {
    const { db } = world();
    const code = await ensureAppCode(db, '11111111-1111-4111-8111-111111111111', USER);
    const bad = await recordBuild(db, code, {
      files: {},
      bundles: {},
      status: 'error',
      log: 'x',
      userId: USER,
    });
    await expect(
      publishAppCode(db, '11111111-1111-4111-8111-111111111111', bad.id, USER),
    ).rejects.toThrow(/falló/);
    expect(
      (await getAppCode(db, '11111111-1111-4111-8111-111111111111'))?.published_build_id,
    ).toBeNull();
  });
});

describe('pantallas con código y buildAppCode', () => {
  it('addCodeScreen crea la pantalla `code`, su vista de relleno y el archivo de arranque', async () => {
    const { db } = world();
    const app = await mustGetApp(db, '11111111-1111-4111-8111-111111111111');
    const screen = await addCodeScreen(db, app, { title: 'Torre de control', userId: USER });
    expect(screen).toMatchObject({ kind: 'code', codeEntry: 'screens/torre_de_control.tsx' });
    const listed = (await listScreens(db, app.id))[0];
    expect(listed).toMatchObject({ kind: 'code', codeEntry: 'screens/torre_de_control.tsx' });
    const code = await getAppCode(db, app.id);
    expect(code?.files['screens/torre_de_control.tsx']).toContain('export default function Screen');
  });

  it('compila, guarda la build y rechaza paquetes fuera de la lista', async () => {
    const { db } = world();
    const app = await mustGetApp(db, '11111111-1111-4111-8111-111111111111');
    const screen = await addCodeScreen(db, app, { title: 'Torre', slug: 'torre', userId: USER });
    const ok = await buildAppCode(db, app.id, USER, okBuilder([screen.slug]), '{}');
    expect(ok).toMatchObject({ status: 'ok', number: 1 });
    expect(ok.bundles.torre?.js).toBe('/*torre*/');

    await saveAppCodeFiles(
      db,
      app.id,
      { write: { 'package.json': JSON.stringify({ dependencies: { lodash: '4' } }) } },
      USER,
    );
    const banned = await buildAppCode(db, app.id, USER, okBuilder([screen.slug]), '{}');
    expect(banned.status).toBe('error');
    expect(banned.log).toMatch(/lodash/);
    expect(banned.number).toBe(2);
  });

  it('un builder que revienta o no trae la pantalla deja una build con error', async () => {
    const { db } = world();
    const app = await mustGetApp(db, '11111111-1111-4111-8111-111111111111');
    await addCodeScreen(db, app, { title: 'Torre', slug: 'torre', userId: USER });
    const boom = await buildAppCode(
      db,
      app.id,
      USER,
      {
        build: async () => {
          throw new Error('sandbox caído');
        },
      },
      '{}',
    );
    expect(boom.status).toBe('error');
    expect(boom.log).toMatch(/sandbox caído/);
    const lacking = await buildAppCode(db, app.id, USER, okBuilder([]), '{}');
    expect(lacking.status).toBe('error');
    expect(lacking.log).toMatch(/torre/);
  });

  it('sin pantallas con código ni siquiera llama al builder', async () => {
    const { db } = world();
    const called: string[] = [];
    const res = await buildAppCode(
      db,
      '11111111-1111-4111-8111-111111111111',
      USER,
      {
        build: async () => {
          called.push('x');
          return { ok: true, bundles: {}, log: '' };
        },
      },
      '{}',
    );
    expect(res.status).toBe('error');
    expect(called).toHaveLength(0);
  });
});
