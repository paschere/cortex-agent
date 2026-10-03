import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ManagedSession, SessionManager } from '../src/manager';
import type { ClaimReply } from '../src/reconcile';

/**
 * The manager with fake sessions and a fake Cortex: what gets started, what
 * gets stopped, and when everything is let go. No Baileys, no network.
 */

class FakeSession implements ManagedSession {
  started = 0;
  stopped = 0;
  constructor(readonly organizationId: string) {}
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  snapshot() {
    return { status: 'connected' };
  }
  currentQr(): string | null {
    return null;
  }
}

function harness(opts: {
  mode?: 'single' | 'multi';
  organizationId?: string | null;
  maxSessions?: number;
  replies: Array<ClaimReply | null>;
}) {
  let clock = 1_000_000;
  const created: FakeSession[] = [];
  const claims: string[][] = [];
  let released = 0;
  const replies = [...opts.replies];
  const manager = new SessionManager(
    {
      mode: opts.mode ?? 'multi',
      organizationId: opts.organizationId ?? null,
      instanceId: 'test-instance',
      maxSessions: opts.maxSessions ?? 50,
      reconcileMs: 15_000,
      leaseMs: 60_000,
      startStaggerMs: 0,
    },
    {
      control: {
        async claim({ running }) {
          claims.push(running);
          return replies.length > 0 ? (replies.shift() ?? null) : null;
        },
        async release() {
          released += 1;
        },
      },
      createSession: (org) => {
        const s = new FakeSession(org);
        created.push(s);
        return s;
      },
      now: () => clock,
      schedule: (fn) => fn(),
    },
  );
  return {
    manager,
    created,
    claims,
    released: () => released,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const want = (...orgs: string[]): ClaimReply => ({
  sessions: orgs.map((organizationId) => ({
    organizationId,
    paired: true,
    pairingRequested: false,
  })),
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

test('multi: starts every leased workspace, then stops one Cortex no longer lists', async () => {
  const h = harness({ replies: [want('a', 'b'), want('b')] });
  await h.manager.reconcileOnce();
  assert.deepEqual(h.manager.running(), ['a', 'b']);
  assert.deepEqual(
    h.created.map((s) => [s.organizationId, s.started]),
    [
      ['a', 1],
      ['b', 1],
    ],
  );

  h.advance(60_000); // past the grace a fresh session gets
  await h.manager.reconcileOnce();
  await settle();
  assert.deepEqual(h.manager.running(), ['b']);
  assert.equal(h.created[0]?.stopped, 1);
  assert.deepEqual(h.claims[1], ['a', 'b']);
});

test('multi: lazy — nothing leased, nothing started', async () => {
  const h = harness({ replies: [{ sessions: [] }] });
  await h.manager.reconcileOnce();
  assert.deepEqual(h.manager.running(), []);
  assert.equal(h.created.length, 0);
});

test('multi: WHATSAPP_MAX_SESSIONS is a hard ceiling', async () => {
  const h = harness({ maxSessions: 2, replies: [want('a', 'b', 'c')] });
  await h.manager.reconcileOnce();
  assert.deepEqual(h.manager.running(), ['a', 'b']);
});

test('multi: a Cortex blip inside the lease keeps sockets; past it, everything is let go', async () => {
  const h = harness({ replies: [want('a', 'b'), null, null] });
  await h.manager.reconcileOnce();
  h.advance(20_000);
  await h.manager.reconcileOnce(); // no answer, lease still fresh
  assert.deepEqual(h.manager.running(), ['a', 'b']);

  h.advance(40_000); // 60 s since the last renewal: the lease may be someone else's now
  await h.manager.reconcileOnce();
  await settle();
  assert.deepEqual(h.manager.running(), []);
  assert.ok(h.created.every((s) => s.stopped === 1));
});

test('single mode: the pinned workspace starts at boot without Cortex and is never stopped', async () => {
  const h = harness({
    mode: 'single',
    organizationId: 'org-pinned',
    replies: [null, { sessions: [] }, want('someone-else')],
  });
  await h.manager.start();
  h.advance(10 * 60_000);
  await h.manager.reconcileOnce();
  await h.manager.reconcileOnce();
  await settle();
  assert.deepEqual(h.manager.running(), ['org-pinned']);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0]?.stopped, 0);
  await h.manager.stop();
});

test('shutdown stops every session and hands the leases back', async () => {
  const h = harness({ replies: [want('a', 'b')] });
  await h.manager.reconcileOnce();
  await h.manager.stop();
  assert.deepEqual(h.manager.running(), []);
  assert.ok(h.created.every((s) => s.stopped === 1));
  assert.equal(h.released(), 1);
});
