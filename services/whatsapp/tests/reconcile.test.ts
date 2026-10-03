import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type DesiredSession,
  decideOnClaim,
  leaseAlive,
  planReconcile,
  sanitizeDesired,
} from '../src/reconcile';

const want = (...orgs: string[]): DesiredSession[] =>
  orgs.map((organizationId) => ({ organizationId, paired: true, pairingRequested: false }));

test('reconcile: starts what is wanted and stops what is not', () => {
  assert.deepEqual(
    planReconcile({ desired: want('a', 'b', 'c'), running: ['b', 'z'], maxSessions: 50 }),
    { start: ['a', 'c'], stop: ['z'] },
  );
});

test('reconcile: nothing wanted and nothing running is a no-op', () => {
  assert.deepEqual(planReconcile({ desired: [], running: [], maxSessions: 50 }), {
    start: [],
    stop: [],
  });
});

test('reconcile: an empty list from Cortex stops everything (all unlinked)', () => {
  assert.deepEqual(planReconcile({ desired: [], running: ['a', 'b'], maxSessions: 50 }), {
    start: [],
    stop: ['a', 'b'],
  });
});

test('reconcile: never starts past the cap, in Cortex priority order', () => {
  const plan = planReconcile({
    desired: want('p1', 'p2', 'p3', 'p4'),
    running: ['p2'],
    maxSessions: 3,
  });
  assert.deepEqual(plan, { start: ['p1', 'p3'], stop: [] });
});

test('reconcile: a session still stopping takes room and is not restarted twice', () => {
  const plan = planReconcile({
    desired: want('a', 'b', 'c'),
    running: ['a'],
    stopping: ['b'],
    maxSessions: 2,
  });
  // a runs, b is still shutting down: no room for c, and b is not started again.
  assert.deepEqual(plan, { start: [], stop: [] });
});

test('reconcile: a lowered cap stops the lowest-priority sessions', () => {
  const plan = planReconcile({
    desired: want('a', 'b', 'c'),
    running: ['c', 'a', 'b'],
    maxSessions: 2,
  });
  assert.deepEqual(plan, { start: [], stop: ['c'] });
});

test('reconcile: a session started moments ago survives a list that predates it', () => {
  const plan = planReconcile({
    desired: want('a'),
    running: ['a', 'fresh'],
    protected: ['fresh'],
    maxSessions: 50,
  });
  assert.deepEqual(plan, { start: [], stop: [] });
});

test('reconcile: duplicates and junk from the wire are ignored', () => {
  assert.deepEqual(
    sanitizeDesired([
      { organizationId: 'org-1', paired: true },
      { organizationId: 'org-1', paired: false },
      { organizationId: 'bad id with spaces' },
      { organizationId: 42 },
      null,
      'org-2',
    ]),
    [{ organizationId: 'org-1', paired: true, pairingRequested: false }],
  );
  assert.deepEqual(sanitizeDesired('nope'), []);
});

test('lease: alive until the margin before expiry, then not', () => {
  assert.equal(leaseAlive(null, 1_000, 60_000, 15_000), false);
  assert.equal(leaseAlive(0, 44_999, 60_000, 15_000), true);
  assert.equal(leaseAlive(0, 45_000, 60_000, 15_000), false);
});

test('claim: an answer is applied as-is', () => {
  const decision = decideOnClaim({
    mode: 'multi',
    reply: { sessions: want('a') },
    lastRenewedAt: null,
    now: 0,
    leaseMs: 60_000,
    marginMs: 15_000,
  });
  assert.deepEqual(decision, { kind: 'apply', desired: want('a') });
});

test('claim: no answer while the lease holds keeps the sockets up', () => {
  const decision = decideOnClaim({
    mode: 'multi',
    reply: null,
    lastRenewedAt: 100_000,
    now: 120_000,
    leaseMs: 60_000,
    marginMs: 15_000,
  });
  assert.deepEqual(decision, { kind: 'hold' });
});

test('claim: no answer past the lease lets go of everything', () => {
  const decision = decideOnClaim({
    mode: 'multi',
    reply: null,
    lastRenewedAt: 100_000,
    now: 150_000,
    leaseMs: 60_000,
    marginMs: 15_000,
  });
  assert.deepEqual(decision, { kind: 'release_all' });
  // And a process that never got a lease holds nothing to begin with.
  assert.deepEqual(
    decideOnClaim({
      mode: 'multi',
      reply: null,
      lastRenewedAt: null,
      now: 0,
      leaseMs: 60_000,
      marginMs: 15_000,
    }),
    { kind: 'release_all' },
  );
});

test('claim: single mode always wants its one workspace, whatever Cortex says', () => {
  for (const reply of [null, { sessions: [] }, { sessions: want('other') }]) {
    const decision = decideOnClaim({
      mode: 'single',
      reply,
      lastRenewedAt: null,
      now: 10 * 60_000,
      leaseMs: 60_000,
      marginMs: 15_000,
      organizationId: 'org-pinned',
    });
    assert.deepEqual(decision, {
      kind: 'apply',
      desired: [{ organizationId: 'org-pinned', paired: false, pairingRequested: false }],
    });
  }
});
