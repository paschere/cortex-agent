import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usePostgresAuthState } from '../src/auth-state';
import type { Config } from '../src/config';
import { CortexClient, CortexControl, type HeartbeatReply, type RemoteState } from '../src/cortex';
import { WhatsappSession } from '../src/socket';

/**
 * One process, many workspaces: nothing of one may reach another. Every
 * request names its own workspace, every auth store is its own, every outbox
 * is delivered by the session whose heartbeat carried it, and a number that is
 * already another workspace's is logged out rather than served twice.
 */

const config: Config = {
  cortexBaseUrl: 'https://cortex.test',
  bridgeToken: 'secret',
  organizationId: null,
  mode: 'multi',
  instanceId: 'inst-1',
  maxSessions: 50,
  reconcileMs: 15_000,
  leaseMs: 60_000,
  startStaggerMs: 0,
  port: 0,
  batchIntervalMs: 30_000,
  batchSize: 50,
  heartbeatMs: 30_000,
  pairingHeartbeatMs: 10_000,
  ingestTickMs: 300_000,
  minBackoffMs: 2_000,
  maxBackoffMs: 300_000,
  pairingRetryMs: 3_000,
  pairingMaxBackoffMs: 30_000,
  browser: ['Cortex', 'Chrome', '1.0.0'],
  maxVoiceBytes: 1,
  maxDocumentBytes: 1,
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test('every request names the workspace of the session that made it', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ archiveGroups: [], replyGroups: [], dmEnabled: true }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  try {
    await new CortexClient(config, 'org-a').heartbeat({ status: 'connected' });
    await new CortexClient(config, 'org-b').heartbeat({ status: 'waiting' });
    await new CortexControl(config).claim({ running: ['org-a'] });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0]?.headers['x-cortex-organization'], 'org-a');
  assert.equal(seen[1]?.headers['x-cortex-organization'], 'org-b');
  for (const call of seen) {
    assert.equal(call.headers['x-cortex-bridge-mode'], 'multi');
    assert.equal(call.headers['x-cortex-bridge-instance'], 'inst-1');
  }
  // The control call is about every workspace, so it names none.
  assert.equal(seen[2]?.headers['x-cortex-organization'], undefined);
  assert.match(seen[2]?.url ?? '', /\/api\/whatsapp\/bridge\/sessions$/);
});

function fakeCortex(organizationId: string, keys: RemoteState['keys']) {
  const saved: unknown[] = [];
  return {
    saved,
    client: {
      organizationId,
      loadState: async (): Promise<RemoteState> => ({
        creds: { account: { details: 'x' }, me: { id: `${organizationId}@s.whatsapp.net` } },
        status: 'connected',
        phoneNumber: null,
        keys,
      }),
      saveState: async (body: unknown) => {
        saved.push(body);
        return {};
      },
    } as unknown as CortexClient,
  };
}

test('auth state: each workspace reads and writes only its own key store', async () => {
  const a = fakeCortex('org-a', { 'pre-key': { '1': { a: true } } });
  const b = fakeCortex('org-b', { 'pre-key': { '2': { b: true } } });
  const authA = await usePostgresAuthState(a.client);
  const authB = await usePostgresAuthState(b.client);

  assert.deepEqual(Object.keys(await authA.state.keys.get('pre-key', ['1', '2'])), ['1']);
  assert.deepEqual(Object.keys(await authB.state.keys.get('pre-key', ['1', '2'])), ['2']);

  await authA.state.keys.set({ session: { 'peer-1': new Uint8Array([1, 2, 3]) as never } });
  await authA.flush();
  await authB.flush();
  assert.equal(a.saved.length, 1);
  assert.equal(b.saved.length, 0);
  assert.deepEqual(Object.keys(await authB.state.keys.get('session', ['peer-1'])), []);
});

test('auth state: a discarded store never pushes again (an unlink must stay wiped)', async () => {
  const a = fakeCortex('org-a', {});
  const auth = await usePostgresAuthState(a.client);
  await auth.saveCreds();
  await auth.discard();
  await auth.flush();
  await new Promise((r) => setTimeout(r, 500)); // past the 400 ms debounce
  assert.equal(a.saved.length, 0);
});

/** A session with a fake socket and a scripted Cortex, driven through its heartbeat. */
function session(org: string, replies: Array<Partial<HeartbeatReply>>) {
  const calls = { logout: 0, wipes: [] as string[], beats: 0 };
  const cortex = {
    organizationId: org,
    heartbeat: async (): Promise<HeartbeatReply> => {
      calls.beats += 1;
      return {
        archiveGroups: [],
        replyGroups: [],
        dmEnabled: true,
        ...(replies.shift() ?? {}),
      };
    },
    wipeState: async (reason: string) => {
      calls.wipes.push(reason);
      return {};
    },
  } as unknown as CortexClient;
  const s = new WhatsappSession(config, org, cortex);
  const inner = s as unknown as {
    sock: unknown;
    status: string;
    phoneNumber: string | null;
    heartbeat: () => Promise<void>;
    onMessage: (raw: unknown) => Promise<void>;
    onDirectMessage: (raw: unknown) => Promise<void>;
    deliverOutbox: (items: unknown[]) => Promise<void>;
  };
  inner.sock = {
    logout: async () => {
      calls.logout += 1;
    },
    end: () => undefined,
  };
  inner.status = 'connected';
  inner.phoneNumber = '573001112233';
  const delivered: unknown[] = [];
  inner.deliverOutbox = async (items) => {
    delivered.push(...items);
  };
  const answered: unknown[] = [];
  inner.onDirectMessage = async (raw) => {
    answered.push(raw);
  };
  return { s, inner, calls, delivered, answered };
}

const dm = { key: { remoteJid: '573009998877@s.whatsapp.net', id: 'm1', fromMe: false } };

test('outbox: a person reply is delivered by the session whose heartbeat carried it', async () => {
  const outbox = [
    {
      id: '0f8b3b3e-6a0e-4a8e-9a3c-1b2c3d4e5f60',
      jid: '573009998877@s.whatsapp.net',
      text: 'Hola',
    },
  ];
  const a = session('org-a', [{ outbox }]);
  const b = session('org-b', [{}]);
  await a.inner.heartbeat();
  await b.inner.heartbeat();
  assert.equal(a.delivered.length, 1);
  assert.equal(b.delivered.length, 0);
});

test('messages wait for Cortex to accept the number, then are handled', async () => {
  const a = session('org-a', [{}]);
  await a.inner.onMessage(dm);
  assert.equal(a.answered.length, 0);
  await a.inner.heartbeat();
  await settle();
  assert.equal(a.answered.length, 1);
});

test('a number that is another workspace’s is logged out and wiped, and answers nothing', async () => {
  const a = session('org-a', [{ unlink: 'phone_taken' }, {}]);
  await a.inner.onMessage(dm);
  await a.inner.heartbeat();
  await settle();
  assert.equal(a.calls.logout, 1);
  assert.deepEqual(a.calls.wipes, ['phone_taken']);
  assert.equal(a.answered.length, 0);
  const snap = a.s.snapshot();
  assert.equal(snap.status, 'logged_out');
  assert.match(String(snap.lastError), /otro espacio de trabajo/);
  assert.equal(snap.phoneNumber, null);
  await a.s.stop();
});

test('«Desvincular» logs out and wipes with its own reason', async () => {
  const a = session('org-a', [{ unlink: 'requested' }, {}]);
  await a.inner.heartbeat();
  await settle();
  assert.equal(a.calls.logout, 1);
  assert.deepEqual(a.calls.wipes, ['unlink']);
  await a.s.stop();
});
