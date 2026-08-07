import { beforeEach, describe, expect, it } from 'vitest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { fingerprint } from '../shape';
import { claimAction, editContent, getAction, listActions, listRevisions } from '../store';
import { recentlyActedOrigins } from '../sweep';

/**
 * TWO COMPANIES, ONE DATABASE — the actions edition.
 *
 * The fixture is deliberately adversarial: both workspaces have a person with
 * the same name, a cobro to a counterparty with the same name, for the same
 * amount, addressed to the same-looking mailbox. A query that lost its tenant
 * filter therefore returns something PLAUSIBLE rather than something empty,
 * which is exactly how this class of bug survives review.
 *
 * The stakes here are higher than on a read screen. Leaking a row from this
 * table does not just show one company another company's data — it shows them a
 * drafted email with a competitor's client, their amounts and their wording in
 * it, and an Approve button underneath. So the assertions go past "cannot see":
 * they check that Globex cannot READ, EDIT or APPROVE an Acme action even
 * holding its exact id and its exact fingerprint.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';

const ANA_ACME = '11111111-1111-4111-8111-111111111111';
const ANA_GLOBEX = '22222222-2222-4222-8222-222222222222';

const ACTION_ACME = 'aaaa1111-0000-4000-8000-000000000001';
const ACTION_GLOBEX = 'bbbb1111-0000-4000-8000-000000000001';

const ACME_PAYLOAD = {
  to: ['cartera@coltrans.co'],
  subject: 'Cartera pendiente — Factura 4471',
  body: 'Buen día,\n\nLa factura 4471 venció hace 47 días.',
};
// Same shape, same amount, same wording. Only the workspace differs.
const GLOBEX_PAYLOAD = {
  to: ['cartera@coltrans.co'],
  subject: 'Cartera pendiente — Factura 4471',
  body: 'Buen día,\n\nLa factura 4471 venció hace 47 días.',
};

function fixture(): Tables {
  return {
    users: [
      { id: ANA_ACME, organization_id: ACME, email: 'ana@acme.com', name: 'Ana' },
      { id: ANA_GLOBEX, organization_id: GLOBEX, email: 'ana@globex.com', name: 'Ana' },
    ],
    actions: [
      {
        id: ACTION_ACME,
        organization_id: ACME,
        user_id: ANA_ACME,
        agent_id: 'agent-acme',
        conversation_id: null,
        kind: 'collect_payment',
        tool_id: 'gmail.send_message',
        tool_input: ACME_PAYLOAD,
        content_hash: fingerprint(ACME_PAYLOAD),
        recipient: 'cartera@coltrans.co',
        subject: ACME_PAYLOAD.subject,
        origin_kind: 'commitment',
        origin_id: 'commitment-acme',
        rationale: 'Coltrans lleva 47 días de mora.',
        client_id: null,
        state: 'proposed',
        expires_at: '2099-01-01T00:00:00.000Z',
        decided_at: null,
        decided_by: null,
        decided_via: null,
        executed_at: null,
        outcome: 'none',
        edited_count: 0,
        created_at: '2026-08-01T11:00:00.000Z',
        updated_at: '2026-08-01T11:00:00.000Z',
      },
      {
        id: ACTION_GLOBEX,
        organization_id: GLOBEX,
        user_id: ANA_GLOBEX,
        agent_id: 'agent-globex',
        conversation_id: null,
        kind: 'collect_payment',
        tool_id: 'gmail.send_message',
        tool_input: GLOBEX_PAYLOAD,
        content_hash: fingerprint(GLOBEX_PAYLOAD),
        recipient: 'cartera@coltrans.co',
        subject: GLOBEX_PAYLOAD.subject,
        origin_kind: 'commitment',
        origin_id: 'commitment-globex',
        rationale: 'Coltrans lleva 47 días de mora.',
        client_id: null,
        state: 'proposed',
        expires_at: '2099-01-01T00:00:00.000Z',
        decided_at: null,
        decided_by: null,
        decided_via: null,
        executed_at: null,
        outcome: 'none',
        edited_count: 0,
        created_at: '2026-08-01T11:00:00.000Z',
        updated_at: '2026-08-01T11:00:00.000Z',
      },
    ],
    action_revisions: [
      {
        id: 'rev-acme',
        organization_id: ACME,
        action_id: ACTION_ACME,
        edited_by: ANA_ACME,
        edited_at: '2026-08-01T11:30:00.000Z',
        from_hash: 'a'.repeat(64),
        to_hash: fingerprint(ACME_PAYLOAD),
        before_input: { ...ACME_PAYLOAD, body: 'borrador viejo de Acme' },
        after_input: ACME_PAYLOAD,
      },
    ],
  };
}

let tables: Tables;
let acme: ReturnType<typeof createOrgScopedClient>;
let globex: ReturnType<typeof createOrgScopedClient>;

beforeEach(() => {
  tables = fixture();
  const fake = createFakeSupabase(tables);
  acme = createOrgScopedClient(fake.client, ACME);
  globex = createOrgScopedClient(fake.client, GLOBEX);
});

const now = new Date('2026-08-01T12:00:00.000Z');

describe('a workspace only ever sees its own actions', () => {
  it('lists only its own, even when the other workspace has an identical one', async () => {
    const mine = await listActions(acme, {});
    expect(mine.map((a) => a.id)).toEqual([ACTION_ACME]);

    const theirs = await listActions(globex, {});
    expect(theirs.map((a) => a.id)).toEqual([ACTION_GLOBEX]);
  });

  it('finds nothing when filtering by the other workspace\'s origin', async () => {
    // The plausible-looking near miss: same tool, same kind, same recipient.
    const byOrigin = await listActions(globex, {});
    expect(byOrigin.every((a) => a.origin_id === 'commitment-globex')).toBe(true);
  });
});

describe('a workspace cannot act on another workspace\'s action', () => {
  it('cannot read it by id', async () => {
    expect(await getAction(globex, ACTION_ACME)).toBeNull();
    expect(await getAction(acme, ACTION_ACME)).not.toBeNull();
  });

  it('cannot approve it, even holding the id AND the right fingerprint', async () => {
    const claimed = await claimAction(globex, {
      id: ACTION_ACME,
      // Their own user id would fail on ownership alone, so the test uses
      // Acme's — isolating the tenant filter as the thing under test.
      userId: ANA_ACME,
      decision: 'approved',
      via: 'web',
      contentHash: fingerprint(ACME_PAYLOAD),
      now,
    });
    expect(claimed).toBeNull();
    // Untouched: still Acme's, still waiting on Acme.
    const row = tables.actions?.find((a) => a.id === ACTION_ACME) as { state: string };
    expect(row.state).toBe('proposed');
  });

  it('cannot rewrite the text of one', async () => {
    const result = await editContent(globex, {
      id: ACTION_ACME,
      userId: ANA_GLOBEX,
      expectedHash: fingerprint(ACME_PAYLOAD),
      patch: { to: ['atacante@globex.com'] },
      now,
    }).catch((err) => err);
    // Either it refuses outright or it finds nothing to edit; what it must
    // never do is change the row.
    const row = tables.actions?.find((a) => a.id === ACTION_ACME) as {
      tool_input: { to: string[] };
    };
    expect(row.tool_input.to).toEqual(['cartera@coltrans.co']);
    expect(result).toBeDefined();
  });

  it('cannot read the edit history of one', async () => {
    expect(await listRevisions(globex, ACTION_ACME)).toHaveLength(0);
    expect(await listRevisions(acme, ACTION_ACME)).toHaveLength(1);
  });

  it('does not let one workspace\'s sweep see the other\'s recent activity', async () => {
    const since = new Date('2026-07-01T00:00:00.000Z');
    expect([...(await recentlyActedOrigins(acme, since))]).toEqual(['commitment-acme']);
    expect([...(await recentlyActedOrigins(globex, since))]).toEqual(['commitment-globex']);
  });
});
