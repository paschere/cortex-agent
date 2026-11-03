import { describe, expect, it, vi } from 'vitest';

// La llave de cifrado real sale del entorno completo; aquí basta un cifrado reversible.
vi.mock('@cortex/core', async (orig) => ({
  ...(await orig<typeof import('@cortex/core')>()),
  encryptToken: (s: string) => `enc:${s}`,
  decryptToken: (s: string) => s.replace(/^enc:/, ''),
}));

import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  getHook,
  listHooks,
  listRunRows,
  listSecretNames,
  loadAppSecrets,
  recordRun,
  setAppSecret,
  upsertHook,
} from './function-store';
import { MAX_RUNS_KEPT, hookTokenMatches } from './functions';

const ORG = 'org-postal';
const APP = '11111111-1111-4111-8111-111111111111';

function world() {
  const fake = createFakeSupabase({
    custom_app_code_secrets: [],
    custom_app_code_runs: [],
    custom_app_code_hooks: [],
  });
  return createOrgScopedClient(fake.client, ORG);
}

describe('secretos', () => {
  it('se guardan cifrados, la lista no trae valores y se pueden reemplazar y borrar', async () => {
    const db = world();
    await setAppSecret(db, APP, 'SIIGO_API_KEY', 'abc123', 'u1');
    const names = await listSecretNames(db, APP);
    expect(names.map((n) => n.name)).toEqual(['SIIGO_API_KEY']);
    expect(JSON.stringify(names)).not.toContain('abc123');
    expect(await loadAppSecrets(db, APP)).toEqual({ SIIGO_API_KEY: 'abc123' });
    await setAppSecret(db, APP, 'SIIGO_API_KEY', 'nuevo', 'u1');
    expect(await listSecretNames(db, APP)).toHaveLength(1);
    expect((await loadAppSecrets(db, APP)).SIIGO_API_KEY).toBe('nuevo');
    await setAppSecret(db, APP, 'SIIGO_API_KEY', null, 'u1');
    expect(await listSecretNames(db, APP)).toEqual([]);
  });
  it('rechaza nombres malos y valores vacíos', async () => {
    const db = world();
    await expect(setAppSecret(db, APP, 'minuscula', 'x', 'u1')).rejects.toThrow();
    await expect(setAppSecret(db, APP, 'OK_KEY', '', 'u1')).rejects.toThrow();
  });
});

describe('corridas', () => {
  it('guarda la corrida, recorta el log y poda a las últimas 500', async () => {
    const db = world();
    const base = {
      functionName: 'cobrar',
      trigger: 'screen' as const,
      actor: 'u1',
      roleKey: 'operario',
      buildNumber: 3,
      status: 'ok' as const,
      durationMs: 120,
      log: 'x'.repeat(50_000),
      error: null,
    };
    await recordRun(db, APP, base);
    const [row] = await listRunRows(db, APP);
    expect(row?.log.length).toBeLessThan(21_000);
    expect(row?.function_name).toBe('cobrar');
    for (let i = 0; i < MAX_RUNS_KEPT + 5; i++)
      await recordRun(db, APP, { ...base, log: `n${i}`, durationMs: i });
    const all = await listRunRows(db, APP, { limit: 200 });
    expect(all.length).toBe(200);
  }, 30_000);
});

describe('webhooks', () => {
  it('crea, rota el token (el anterior deja de servir) y guarda sólo el hash', async () => {
    const db = world();
    const a = await upsertHook(db, APP, { name: 'cobrar', roleKey: 'operario', userId: 'u1' });
    const hook = await getHook(db, APP, 'cobrar');
    expect(hook?.token_hash).not.toContain(a.token);
    expect(hookTokenMatches(a.token, hook?.token_hash ?? '')).toBe(true);
    const b = await upsertHook(db, APP, { name: 'cobrar', roleKey: 'gerencia', userId: 'u1' });
    const after = await getHook(db, APP, 'cobrar');
    expect(after?.role_key).toBe('gerencia');
    expect(hookTokenMatches(a.token, after?.token_hash ?? '')).toBe(false);
    expect(hookTokenMatches(b.token, after?.token_hash ?? '')).toBe(true);
    const listed = await listHooks(db, APP);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('token_hash');
  });
});
