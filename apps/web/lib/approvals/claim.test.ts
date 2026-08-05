import { describe, expect, it } from 'vitest';
import {
  type ApprovalDecision,
  type ApprovalSnapshot,
  type ApprovalStore,
  claimApproval,
} from './claim';

/**
 * A store that behaves like the real table rather than like a Map.
 *
 * The single-use rule is a WHERE clause on one UPDATE statement, so the fake
 * evaluates all four conditions and writes in ONE synchronous critical section,
 * with the awaits either side of it. An implementation that read the row, went
 * away, and wrote it back would pass a Map-based test and still run the action
 * twice under two clicks a millisecond apart — this fake fails it.
 */
interface Row {
  id: string;
  user_id: string;
  agent_id: string;
  tool_id: string;
  input: unknown;
  expires_at: string;
  decision: ApprovalDecision | null;
  decided_at: string | null;
  decided_by: string | null;
  decided_via: string | null;
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const APPROVAL = '44444444-4444-4444-8444-444444444444';

function fakeStore(overrides: Partial<Row> = {}) {
  const rows = new Map<string, Row>();
  rows.set(APPROVAL, {
    id: APPROVAL,
    user_id: OWNER,
    agent_id: AGENT,
    tool_id: 'gmail.send_draft',
    input: { draftId: 'r-99' },
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    decision: null,
    decided_at: null,
    decided_by: null,
    decided_via: null,
    ...overrides,
  });

  let claimAttempts = 0;

  const store: ApprovalStore = {
    async claim(input) {
      claimAttempts += 1;
      // Simulate the round-trip BEFORE the statement runs: any implementation
      // that decided the outcome before this point is racy by construction.
      await Promise.resolve();
      const row = rows.get(input.id);
      if (!row) return null;
      // --- one statement, no awaits inside ---
      const matches =
        row.user_id === input.userId &&
        row.decision === null &&
        new Date(row.expires_at).getTime() > input.now.getTime();
      if (!matches) return null;
      row.decision = input.decision;
      row.decided_at = input.now.toISOString();
      row.decided_by = input.userId;
      row.decided_via = input.via;
      // --------------------------------------
      return {
        id: row.id,
        organizationId: 'org-a',
        userId: row.user_id,
        agentId: row.agent_id,
        toolId: row.tool_id,
        input: row.input,
      };
    },
    async peek(id): Promise<ApprovalSnapshot | null> {
      await Promise.resolve();
      const row = rows.get(id);
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        toolId: row.tool_id,
        expiresAt: row.expires_at,
        decision: row.decision,
        decidedAt: row.decided_at,
        decidedVia: row.decided_via,
      };
    },
  };

  return { store, rows, attempts: () => claimAttempts };
}

describe('claimApproval — single use', () => {
  it('executes once when the same button is clicked twice at the same time', async () => {
    const { store } = fakeStore();
    const now = new Date();

    const [first, second] = await Promise.all([
      claimApproval(store, {
        id: APPROVAL,
        userId: OWNER,
        decision: 'approved',
        via: 'google_chat',
        now,
      }),
      claimApproval(store, {
        id: APPROVAL,
        userId: OWNER,
        decision: 'approved',
        via: 'google_chat',
        now,
      }),
    ]);

    const claimed = [first, second].filter((o) => o.status === 'claimed');
    const refused = [first, second].filter((o) => o.status === 'already_decided');
    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(1);
  });

  it('refuses a second decision made later on another surface', async () => {
    const { store, rows } = fakeStore();
    const now = new Date();

    const inChat = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now,
    });
    expect(inChat.status).toBe('claimed');

    const onWeb = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'declined',
      via: 'web',
      now: new Date(now.getTime() + 1_000),
    });

    expect(onWeb).toMatchObject({
      status: 'already_decided',
      decision: 'approved',
      decidedVia: 'google_chat',
      toolId: 'gmail.send_draft',
    });
    // The first decision stands; the second surface must not overwrite it.
    expect(rows.get(APPROVAL)?.decision).toBe('approved');
    expect(rows.get(APPROVAL)?.decided_via).toBe('google_chat');
  });

  it('will not approve something already declined', async () => {
    const { store } = fakeStore();
    const now = new Date();
    await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'declined',
      via: 'web',
      now,
    });

    const retry = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now,
    });
    expect(retry).toMatchObject({ status: 'already_decided', decision: 'declined' });
  });
});

describe('claimApproval — the person who clicks must own it', () => {
  it('refuses a stranger and leaves the approval decidable by its owner', async () => {
    const { store, rows } = fakeStore();
    const now = new Date();

    const stranger = await claimApproval(store, {
      id: APPROVAL,
      userId: STRANGER,
      decision: 'approved',
      via: 'google_chat',
      now,
    });
    expect(stranger.status).toBe('not_yours');
    expect(rows.get(APPROVAL)?.decision).toBeNull();

    const owner = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now,
    });
    expect(owner.status).toBe('claimed');
    expect(rows.get(APPROVAL)?.decided_by).toBe(OWNER);
  });

  it('tells a stranger nothing about an approval that was already decided', async () => {
    const { store } = fakeStore({
      decision: 'approved',
      decided_at: new Date().toISOString(),
      decided_by: OWNER,
      decided_via: 'web',
    });

    const outcome = await claimApproval(store, {
      id: APPROVAL,
      userId: STRANGER,
      decision: 'declined',
      via: 'google_chat',
      now: new Date(),
    });

    // 'not_yours', never 'already_decided' — the decision is not a stranger's
    // business, and neither is the fact that one was made.
    expect(outcome).toEqual({ status: 'not_yours' });
  });

  it('treats an unparseable id as unknown without touching the store', async () => {
    const { store, attempts } = fakeStore();
    const outcome = await claimApproval(store, {
      id: 'not-a-uuid',
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now: new Date(),
    });
    expect(outcome).toEqual({ status: 'unknown' });
    expect(attempts()).toBe(0);
  });

  it('reports an id that does not exist as unknown', async () => {
    const { store } = fakeStore();
    const outcome = await claimApproval(store, {
      id: '99999999-9999-4999-8999-999999999999',
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now: new Date(),
    });
    expect(outcome).toEqual({ status: 'unknown' });
  });
});

describe('claimApproval — expiry is decided by the server', () => {
  it('refuses a button clicked after the window closed', async () => {
    const { store, rows } = fakeStore({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const outcome = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now: new Date(),
    });

    expect(outcome).toEqual({ status: 'expired', toolId: 'gmail.send_draft' });
    expect(rows.get(APPROVAL)?.decision).toBeNull();
  });

  it('refuses on the exact expiry instant', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const { store } = fakeStore({ expires_at: expiresAt.toISOString() });

    const outcome = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now: expiresAt,
    });
    expect(outcome.status).toBe('expired');
  });

  it('accepts a click a second before the window closes', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const { store } = fakeStore({ expires_at: expiresAt.toISOString() });

    const outcome = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'approved',
      via: 'google_chat',
      now: new Date(expiresAt.getTime() - 1_000),
    });
    expect(outcome.status).toBe('claimed');
  });

  it('does not let an expired approval be declined into a decided state', async () => {
    // Declining an expired request is harmless, but it must still not rewrite
    // history — the row stays undecided and simply reads as expired.
    const { store, rows } = fakeStore({ expires_at: new Date(Date.now() - 1).toISOString() });
    const outcome = await claimApproval(store, {
      id: APPROVAL,
      userId: OWNER,
      decision: 'declined',
      via: 'google_chat',
      now: new Date(),
    });
    expect(outcome.status).toBe('expired');
    expect(rows.get(APPROVAL)?.decision).toBeNull();
  });
});
