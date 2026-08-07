import { beforeEach, describe, expect, it } from 'vitest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import {
  type ActionRow,
  type MessagePayload,
  assertExecutable,
  fingerprint,
} from '../shape';
import { claimAction, editContent, listRevisions, proposeAction, recordExecution } from '../store';

/**
 * The four properties this feature is sold on, exercised against real product
 * code and a real (if small) PostgREST.
 *
 *   1. Something nobody approved never runs.
 *   2. What runs is byte-for-byte what was approved.
 *   3. Approving twice sends once.
 *   4. Editing is conditional on the text that was edited, and leaves a record.
 *
 * Nothing here asserts that a filter was "called". Every assertion is about the
 * rows that came back, because a mock that returns canned rows tests that the
 * code talks to a database — and the failure mode this whole design exists to
 * prevent is a WHERE clause that matched the wrong thing.
 */

const ORG = 'org-coltrans';
const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const ACTION = 'aaaaaaaa-1111-4111-8111-111111111111';

const PAYLOAD: MessagePayload = {
  to: ['cartera@coltrans.co'],
  subject: 'Cartera pendiente — Factura 4471',
  body: 'Buen día,\n\nLa factura 4471 venció hace 47 días.\n\nQuedamos atentos.',
};

const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

/**
 * A row as the database would have made it: defaults applied, fingerprint in
 * step with the content. Written by hand rather than through `proposeAction`
 * so the tests below are about reading, editing and claiming rather than about
 * which column has a default.
 */
function seed(over: Partial<ActionRow> = {}): ActionRow {
  const input = (over.tool_input ?? PAYLOAD) as MessagePayload;
  return {
    id: ACTION,
    user_id: ANA,
    agent_id: 'agent-1',
    conversation_id: null,
    kind: 'collect_payment',
    tool_id: 'gmail.send_message',
    tool_input: input,
    content_hash: fingerprint(input),
    recipient: input.to.join(', '),
    subject: input.subject,
    origin_kind: 'commitment',
    origin_id: 'commitment-1',
    rationale: 'Coltrans lleva 47 días de mora en la factura 4471.',
    client_id: null,
    state: 'proposed',
    expires_at: FAR_FUTURE,
    decided_at: null,
    decided_by: null,
    decided_via: null,
    dismissed_reason: null,
    executed_at: null,
    execution_status: null,
    execution_error: null,
    execution_result: null,
    thread_id: null,
    outcome: 'none',
    outcome_at: null,
    outcome_note: null,
    edited_count: 0,
    created_at: '2026-08-01T11:00:00.000Z',
    updated_at: '2026-08-01T11:00:00.000Z',
    ...over,
  };
}

function fixture(rows: ActionRow[] = [seed()]): Tables {
  return {
    users: [
      { id: ANA, organization_id: ORG, email: 'ana@coltrans.co', name: 'Ana Gómez' },
      { id: BEN, organization_id: ORG, email: 'ben@coltrans.co', name: 'Ben Ruiz' },
    ],
    actions: rows.map((r) => ({ ...r, organization_id: ORG })),
    action_revisions: [],
  };
}

let tables: Tables;
let db: ReturnType<typeof createOrgScopedClient>;

beforeEach(() => {
  tables = fixture();
  db = createOrgScopedClient(createFakeSupabase(tables).client, ORG);
});

const now = new Date('2026-08-01T12:00:00.000Z');

describe('proposing', () => {
  it('stores the fingerprint of the payload it stored, computed from that payload', () => {
    // The two are written by one expression and can never be handed in
    // separately: no caller of proposeAction may supply a hash.
    tables.actions = [];
    return proposeAction(db, {
      userId: ANA,
      agentId: 'agent-1',
      kind: 'remind_owner',
      toolId: 'gmail.send_message',
      payload: PAYLOAD,
      originKind: 'commitment',
      originId: 'commitment-9',
      rationale: 'Vence en 3 días.',
      now,
    }).then(() => {
      const written = tables.actions?.[0] as unknown as ActionRow;
      expect(written.content_hash).toBe(fingerprint(written.tool_input));
      expect(written.state).toBe('proposed');
      // A proposal is never born executed, and never born with an outcome.
      expect(written.executed_at ?? null).toBeNull();
    });
  });
});

describe('nothing runs without an approval', () => {
  it('refuses to execute a proposal that nobody has decided', () => {
    const row = seed();
    expect(() => assertExecutable(row, row.content_hash)).toThrow(/not approved/);
  });

  it('refuses to execute something that was discarded', async () => {
    const claimed = await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'dismissed',
      via: 'web',
      now,
    });
    expect(claimed?.state).toBe('dismissed');
    expect(() => assertExecutable(claimed as ActionRow, claimed?.content_hash as string)).toThrow(
      /dismissed/,
    );
  });

  it('leaves a stale proposal unapprovable — expiry revokes, it never executes', async () => {
    tables.actions = fixture([seed({ expires_at: '2026-07-01T00:00:00.000Z' })]).actions ?? [];
    const claimed = await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'approved',
      via: 'web',
      contentHash: fingerprint(PAYLOAD),
      now,
    });
    expect(claimed).toBeNull();
    // And, crucially, it is still sitting there in 'proposed' — expiring did
    // not decide anything on the person's behalf, in either direction.
    expect((tables.actions?.[0] as { state: string }).state).toBe('proposed');
  });

  it('refuses an approval from somebody who is not the action\'s owner', async () => {
    const claimed = await claimAction(db, {
      id: ACTION,
      userId: BEN,
      decision: 'approved',
      via: 'web',
      contentHash: fingerprint(PAYLOAD),
      now,
    });
    expect(claimed).toBeNull();
    expect((tables.actions?.[0] as { state: string }).state).toBe('proposed');
  });
});

describe('what runs is what was approved', () => {
  it('hands back the payload whose fingerprint the claim required', async () => {
    const hash = fingerprint(PAYLOAD);
    const claimed = await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'approved',
      via: 'web',
      contentHash: hash,
      now,
    });
    expect(claimed).not.toBeNull();
    // The bytes handed to the executor, re-fingerprinted, are the bytes the
    // approver signed off on. This is the property; everything else is scaffolding.
    expect(fingerprint((claimed as ActionRow).tool_input)).toBe(hash);
    expect(() => assertExecutable(claimed as ActionRow, hash)).not.toThrow();
  });

  it('refuses the approval when the text moved since it was displayed', async () => {
    const shownHash = fingerprint(PAYLOAD);

    // Somebody rewrites the draft — another tab, a colleague, a redraft.
    const edited = await editContent(db, {
      id: ACTION,
      userId: ANA,
      expectedHash: shownHash,
      patch: { body: 'Buen día,\n\nNos deben $80.000.000. Paguen ya.' },
      now,
    });
    expect(edited.outcome).toBe('edited');

    // The approval carrying the OLD fingerprint matches nothing. Without this,
    // the click that meant "send the polite one" would send the rude one.
    const stale = await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'approved',
      via: 'web',
      contentHash: shownHash,
      now,
    });
    expect(stale).toBeNull();
    expect((tables.actions?.[0] as { state: string }).state).toBe('proposed');

    // The approval carrying the fingerprint of what is actually on screen works.
    const fresh = await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'approved',
      via: 'web',
      contentHash: (edited as { action: ActionRow }).action.content_hash,
      now,
    });
    expect(fresh).not.toBeNull();
    expect((fresh as ActionRow).tool_input.body).toContain('Paguen ya');
  });

  it('will not approve against a fingerprint nobody ever showed', async () => {
    const claimed = await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'approved',
      via: 'web',
      contentHash: 'a'.repeat(64),
      now,
    });
    expect(claimed).toBeNull();
  });
});

describe('approving twice does not send twice', () => {
  it('lets exactly one of two concurrent approvals through', async () => {
    const hash = fingerprint(PAYLOAD);
    const claim = () =>
      claimAction(db, {
        id: ACTION,
        userId: ANA,
        decision: 'approved',
        via: 'web',
        contentHash: hash,
        now,
      });

    // Both are issued before either resolves — the double-click, the retried
    // request, the two open tabs. A read-then-write implementation passes a
    // sequential version of this test and fails this one.
    const [first, second] = await Promise.all([claim(), claim()]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('refuses a second approval after the first has already run', async () => {
    const hash = fingerprint(PAYLOAD);
    const claimed = await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'approved',
      via: 'web',
      contentHash: hash,
      now,
    });
    await recordExecution(db, {
      id: ACTION,
      status: 'ok',
      result: { messageId: 'm1' },
      threadId: 't1',
      now,
    });

    // The claim is spent…
    expect(
      await claimAction(db, {
        id: ACTION,
        userId: ANA,
        decision: 'approved',
        via: 'web',
        contentHash: hash,
        now,
      }),
    ).toBeNull();

    // …and even holding the original claimed row, the executor refuses it,
    // because the row now records that it ran.
    const after = tables.actions?.[0] as unknown as ActionRow;
    expect(after.executed_at).toBeTruthy();
    expect(after.outcome).toBe('awaiting');
    expect(() => assertExecutable(after, (claimed as ActionRow).content_hash)).toThrow(
      /already ran/,
    );
  });
});

describe('editing', () => {
  it('records who changed what, with both sides in full', async () => {
    const before = fingerprint(PAYLOAD);
    await editContent(db, {
      id: ACTION,
      userId: BEN,
      expectedHash: before,
      patch: { subject: 'Cartera pendiente — Factura 4471 (segundo aviso)' },
      now,
    });

    const revisions = await listRevisions(db, ACTION);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.edited_by).toBe(BEN);
    expect(revisions[0]?.from_hash).toBe(before);
    expect(revisions[0]?.before_input.subject).toBe(PAYLOAD.subject);
    expect(revisions[0]?.after_input.subject).toContain('segundo aviso');
    expect((tables.actions?.[0] as { edited_count: number }).edited_count).toBe(1);
  });

  it('refuses an edit against text that already moved', async () => {
    await editContent(db, {
      id: ACTION,
      userId: ANA,
      expectedHash: fingerprint(PAYLOAD),
      patch: { body: 'Primera reescritura.' },
      now,
    });
    // A second editor, still holding the original fingerprint.
    const late = await editContent(db, {
      id: ACTION,
      userId: BEN,
      expectedHash: fingerprint(PAYLOAD),
      patch: { body: 'Segunda reescritura, sobre la versión vieja.' },
      now,
    });
    expect(late.outcome).toBe('stale');
    expect((tables.actions?.[0] as { tool_input: MessagePayload }).tool_input.body).toBe(
      'Primera reescritura.',
    );
  });

  it('writes no revision when nothing actually changed', async () => {
    const result = await editContent(db, {
      id: ACTION,
      userId: ANA,
      expectedHash: fingerprint(PAYLOAD),
      patch: { subject: PAYLOAD.subject },
      now,
    });
    expect(result.outcome).toBe('unchanged');
    expect(await listRevisions(db, ACTION)).toHaveLength(0);
  });

  it('cannot rewrite an action that has already been decided', async () => {
    await claimAction(db, {
      id: ACTION,
      userId: ANA,
      decision: 'approved',
      via: 'web',
      contentHash: fingerprint(PAYLOAD),
      now,
    });
    const late = await editContent(db, {
      id: ACTION,
      userId: ANA,
      expectedHash: fingerprint(PAYLOAD),
      patch: { body: 'Cambiado después de aprobar.' },
      now,
    });
    expect(late.outcome).toBe('stale');
  });
});
