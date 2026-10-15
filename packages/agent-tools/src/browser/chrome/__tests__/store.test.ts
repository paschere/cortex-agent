import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { generateDeviceToken, hashSecret } from '../credentials';
import {
  authenticateDeviceToken,
  getDeviceSession,
  redeemPairingCode,
  runOnDevice,
} from '../store';

interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  filters: Array<[string, ...unknown[]]>;
  payload?: unknown;
}
type Reply = { data?: unknown; error?: unknown; count?: number };

/** Un cliente de mentira: registra cada consulta y contesta lo que el test decida. */
function fakeDb(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const c: Call = { table, op: 'select', filters: [] };
    const b: unknown = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'then') {
            return (res: (v: unknown) => unknown) => {
              calls.push(c);
              return Promise.resolve(handler(c)).then(res);
            };
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return () => {
              calls.push(c);
              return Promise.resolve(handler(c));
            };
          }
          if (['insert', 'update', 'upsert', 'delete'].includes(prop)) {
            return (payload?: unknown) => {
              c.op = prop as Call['op'];
              c.payload = payload;
              return b;
            };
          }
          return (...args: unknown[]) => {
            c.filters.push([prop, ...args]);
            return b;
          };
        },
      },
    );
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, calls };
}

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();
const deviceRow = (over: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  organization_id: 'org-1',
  user_id: 'user-1',
  name: 'Mi Chrome',
  ext_version: '0.1.0',
  created_at: past,
  last_seen_at: new Date().toISOString(),
  expires_at: future,
  revoked_at: null,
  ...over,
});

describe('authenticateDeviceToken', () => {
  it('no toca la base si el token no tiene la forma', async () => {
    const { db, calls } = fakeDb(() => ({ data: deviceRow() }));
    expect(await authenticateDeviceToken(db, 'Bearer basura')).toBeNull();
    expect(await authenticateDeviceToken(db, null)).toBeNull();
    expect(await authenticateDeviceToken(db, 'Basic abc')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('busca por el HASH del token, nunca por el token', async () => {
    const { token, hash } = generateDeviceToken();
    const { db, calls } = fakeDb(() => ({ data: deviceRow() }));
    const who = await authenticateDeviceToken(db, `Bearer ${token}`);
    expect(who).toEqual({
      id: 'dev-1',
      organizationId: 'org-1',
      userId: 'user-1',
      name: 'Mi Chrome',
    });
    const eq = calls[0]?.filters.find((f) => f[0] === 'eq');
    expect(eq?.[2]).toBe(hash);
    expect(JSON.stringify(calls)).not.toContain(token);
  });

  it('rechaza el dispositivo revocado, el vencido y el inexistente', async () => {
    const { token } = generateDeviceToken();
    for (const row of [deviceRow({ revoked_at: past }), deviceRow({ expires_at: past }), null]) {
      const { db } = fakeDb(() => ({ data: row }));
      expect(await authenticateDeviceToken(db, `Bearer ${token}`)).toBeNull();
    }
  });
});

describe('redeemPairingCode', () => {
  it('no consulta nada con un código mal escrito', async () => {
    const { db, calls } = fakeDb(() => ({ data: null }));
    const r = await redeemPairingCode(db, 'hola', { deviceName: 'x' });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('un código usado o vencido (la baja atómica no devuelve fila) no canjea', async () => {
    const { db, calls } = fakeDb(() => ({ data: null }));
    const r = await redeemPairingCode(db, 'ABCD-EFGH', { deviceName: 'x' });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.table === 'browser_devices' && c.op === 'insert')).toBe(false);
  });

  it('canjea una sola vez: marca used_at filtrando por hash y por «sin usar»', async () => {
    const { db, calls } = fakeDb((c) => {
      if (c.table === 'browser_pairing_codes')
        return { data: { organization_id: 'org-9', user_id: 'user-9' } };
      if (c.table === 'browser_devices' && c.op === 'select') return { count: 0 };
      if (c.table === 'browser_devices' && c.op === 'insert')
        return { data: { id: 'dev-new', name: 'Portátil' } };
      return {};
    });
    const r = await redeemPairingCode(db, 'abcd efgh', { deviceName: 'Portátil' });
    expect(r.ok).toBe(true);
    const claim = calls.find((c) => c.table === 'browser_pairing_codes');
    expect(claim?.filters).toContainEqual(['eq', 'code_hash', hashSecret('ABCD-EFGH')]);
    expect(claim?.filters).toContainEqual(['is', 'used_at', null]);
    const insert = calls.find((c) => c.table === 'browser_devices' && c.op === 'insert');
    const row = insert?.payload as Record<string, unknown>;
    // La organización y el usuario salen del código, y solo se guarda el hash.
    expect(row.organization_id).toBe('org-9');
    expect(row.user_id).toBe('user-9');
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    if (r.ok) {
      expect(JSON.stringify(row)).not.toContain(r.token);
      expect(row.token_hash).toBe(hashSecret(r.token));
    }
  });

  it('respeta el máximo de dispositivos', async () => {
    const { db } = fakeDb((c) => {
      if (c.table === 'browser_pairing_codes')
        return { data: { organization_id: 'o', user_id: 'u' } };
      return { count: 5 };
    });
    const r = await redeemPairingCode(db, 'ABCD-EFGH', { deviceName: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('sesiones: solo las del dispositivo', () => {
  it('un dispositivo no ve la sesión de otro', async () => {
    const { db } = fakeDb(() => ({
      data: {
        id: 'chr_0123456789abcdef',
        organization_id: 'o',
        user_id: 'user-1',
        device_id: 'otro',
        purpose: '',
        status: 'open',
        action_cap: 150,
        actions_count: 0,
        awaiting: null,
        last_url: null,
        last_title: null,
        created_at: past,
      },
    }));
    expect(
      await getDeviceSession(db, { id: 'dev-1', userId: 'user-1' }, 'chr_0123456789abcdef'),
    ).toBeNull();
  });
});

describe('runOnDevice: las puertas antes de encolar', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'chr_0123456789abcdef',
    organization_id: 'org-1',
    user_id: 'user-1',
    device_id: 'dev-1',
    purpose: '',
    status: 'open',
    action_cap: 150,
    actions_count: 0,
    awaiting: null,
    last_url: 'https://www.bancolombia.com/inicio',
    last_title: null,
    created_at: past,
    ...over,
  });
  const world = (
    over: {
      session?: Record<string, unknown>;
      device?: Record<string, unknown>;
      sites?: unknown[];
    } = {},
  ) =>
    fakeDb((c) => {
      if (c.table === 'browser_device_sessions') return { data: session(over.session) };
      if (c.table === 'browser_devices') return { data: deviceRow(over.device) };
      if (c.table === 'browser_device_sites') return { data: over.sites ?? [] };
      return { data: null };
    });
  const base = {
    userId: 'user-1',
    sessionId: 'chr_0123456789abcdef',
    protectedSites: ['app.cortex.test'],
    timeoutMs: 50,
  };

  it('una sesión detenida por la persona no recibe órdenes', async () => {
    const { db, calls } = world({ session: { status: 'stopped' } });
    const r = await runOnDevice(db, { ...base, body: { op: 'click', ref: 'e1', name: 'x' } });
    expect(r).toMatchObject({ ok: false, code: 'stopped' });
    expect(calls.some((c) => c.table === 'browser_device_commands')).toBe(false);
  });

  it('un Chrome revocado, vencido o desconectado no recibe órdenes', async () => {
    for (const [device, code] of [
      [{ revoked_at: past }, 'device_gone'],
      [{ expires_at: past }, 'device_gone'],
      [{ last_seen_at: past }, 'offline'],
    ] as const) {
      const { db, calls } = world({ device });
      const r = await runOnDevice(db, { ...base, body: { op: 'read', offset: 0 } });
      expect(r).toMatchObject({ ok: false, code });
      expect(calls.some((c) => c.table === 'browser_device_commands')).toBe(false);
    }
  });

  it('el tope de acciones corta antes de encolar', async () => {
    const { db, calls } = world({ session: { actions_count: 150 } });
    const r = await runOnDevice(db, { ...base, body: { op: 'click', ref: 'e1', name: 'x' } });
    expect(r).toMatchObject({ ok: false, code: 'cap' });
    expect(calls.some((c) => c.table === 'browser_device_commands')).toBe(false);
  });

  it('un sitio dicho «nunca», la red privada y la página de Cortex no se abren', async () => {
    const never = world({
      sites: [
        {
          id: '1',
          device_id: 'dev-1',
          site: 'bancolombia.com',
          decision: 'never',
          created_at: past,
        },
      ],
    });
    expect(
      await runOnDevice(never.db, {
        ...base,
        body: { op: 'goto', url: 'https://login.bancolombia.com/' },
      }),
    ).toMatchObject({ ok: false, code: 'never' });
    for (const url of [
      'http://192.168.0.1/',
      'chrome://settings',
      'https://app.cortex.test/chat',
    ]) {
      const w = world();
      const r = await runOnDevice(w.db, { ...base, body: { op: 'open', url, purpose: 'x' } });
      expect(r).toMatchObject({ ok: false, code: 'blocked' });
      expect(w.calls.some((c) => c.table === 'browser_device_commands')).toBe(false);
    }
  });

  it('la sesión de otra persona no existe para quien pregunta (filtra por usuario)', async () => {
    const { db, calls } = fakeDb(() => ({ data: null }));
    const r = await runOnDevice(db, { ...base, body: { op: 'read', offset: 0 } });
    expect(r).toMatchObject({ ok: false, code: 'no_session' });
    const q = calls.find((c) => c.table === 'browser_device_sessions');
    expect(q?.filters).toContainEqual(['eq', 'user_id', 'user-1']);
  });
});
