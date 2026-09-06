import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { advanceCollectionWorkflow, assertCollectionActionCurrent } from './workflow';
import {
  type CollectionInvoice,
  type CollectionPayment,
  verifyCollectionBalance,
} from './workflow-shape';
const invoice: CollectionInvoice = {
  id: 'invoice',
  doc_number: 'F-42',
  counterparty_name: 'Cliente',
  client_id: null,
  total_amount: '100.30',
  currency: 'COP',
  due_on: null,
  review_state: 'confirmed',
  doc_type: 'invoice',
};
const payment = (overrides: Partial<CollectionPayment> = {}): CollectionPayment => ({
  id: 'payment',
  extraction_id: 'invoice',
  state: 'confirmed',
  currency: 'COP',
  kind: 'payment',
  amount: '100.30',
  paid_on: '2026-09-01',
  ...overrides,
});
describe('collection source verification', () => {
  it('computes exact partial balances without floating point drift', () =>
    expect(verifyCollectionBalance(invoice, [payment({ amount: '100.20' })]).balance).toBe(0.1));
  it('verifies complete payment and subtracts reversals', () => {
    expect(verifyCollectionBalance(invoice, [payment()]).balance).toBe(0);
    expect(
      verifyCollectionBalance(invoice, [
        payment(),
        payment({ id: 'reversal', kind: 'reversal', amount: '10.10' }),
      ]).balance,
    ).toBe(10.1);
  });
  it.each(['reported', 'disputed'])('blocks unresolved %s payments', (state) =>
    expect(() => verifyCollectionBalance(invoice, [payment({ state })])).toThrow(/conciliación/),
  );
  it('ignores discarded records', () =>
    expect(verifyCollectionBalance(invoice, [payment({ state: 'discarded' })]).balance).toBe(
      100.3,
    ));
  it.each([
    { extraction_id: 'other' },
    { currency: 'USD' },
    { amount: '100.301' },
    { kind: 'unknown' },
    { amount: '-10' },
  ])('fails closed on invalid linked movements %j', (bad) =>
    expect(() => verifyCollectionBalance(invoice, [payment(bad)])).toThrow(),
  );
  it('rejects a source that lost confirmation', () =>
    expect(() => verifyCollectionBalance({ ...invoice, review_state: 'pending' }, [])).toThrow(
      /confirmada/,
    ));
});
describe('last send gate', () => {
  it('leaves unrelated free-text manual origins unchanged', async () => {
    const { client } = createFakeSupabase({});
    await expect(
      assertCollectionActionCurrent(createOrgScopedClient(client, 'acme'), {
        id: 'other',
        origin_kind: 'manual',
        origin_id: 'follow-up:manual',
        rationale: '',
      }),
    ).resolves.toBeUndefined();
  });
  function fixture(balance = 100.3, state = 'approval', payments: CollectionPayment[] = []) {
    const fake = createFakeSupabase({
      management_workflows: [
        {
          id: '11111111-1111-4111-a111-111111111111',
          organization_id: 'acme',
          case_id: 'case',
          invoice_id: 'invoice',
          draft_balance: balance,
          state,
        },
      ],
      management_cases: [{ id: 'case', organization_id: 'acme', data: { state: 'working' } }],
      document_extractions: [{ ...invoice, organization_id: 'acme' }],
      payments: payments.map((p) => ({ ...p, organization_id: 'acme' })),
    });
    return createOrgScopedClient(fake.client, 'acme');
  }
  const action = {
    id: 'action',
    origin_kind: 'manual' as const,
    origin_id: '11111111-1111-4111-a111-111111111111',
    rationale: '[saldo:COP:100.3] Saldo consultado',
  };
  it('allows the unchanged outstanding balance', async () =>
    await expect(assertCollectionActionCurrent(fixture(), action)).resolves.toBeUndefined());
  it('blocks a fully paid invoice', async () =>
    await expect(
      assertCollectionActionCurrent(fixture(100.3, 'approval', [payment()]), action),
    ).rejects.toThrow(/pagada/));
  it('blocks a partial payment that changed the draft amount', async () =>
    await expect(
      assertCollectionActionCurrent(
        fixture(100.3, 'approval', [payment({ amount: '10' })]),
        action,
      ),
    ).rejects.toThrow(/saldo cambió/));
  it('blocks cancellation', async () =>
    await expect(
      assertCollectionActionCurrent(fixture(100.3, 'cancelled'), action),
    ).rejects.toThrow(/detenido/));
});

describe('durable progression', () => {
  async function progress(
    action: Record<string, unknown> | null,
    payments: CollectionPayment[] = [],
  ) {
    const run = {
      id: '11111111-1111-4111-a111-111111111111',
      organization_id: 'acme',
      case_id: 'case',
      invoice_id: 'invoice',
      user_id: 'owner',
      recipient: 'client@example.com',
      state: 'ready',
      draft_balance: 100.3,
      detail: '',
      evidence: null,
      action_id: null,
    };
    const fake = createFakeSupabase(
      {
        management_cases: [{ id: 'case', organization_id: 'acme', data: { state: 'working' } }],
        document_extractions: [{ ...invoice, organization_id: 'acme' }],
        payments: payments.map((p) => ({ ...p, organization_id: 'acme' })),
        actions: action
          ? [
              {
                ...action,
                id: 'existing',
                organization_id: 'acme',
                origin_kind: 'manual',
                origin_id: '11111111-1111-4111-a111-111111111111',
                user_id: 'owner',
              },
            ]
          : [],
        users: [{ id: 'owner', organization_id: 'acme' }],
        agents: [{ id: 'agent', organization_id: 'acme', slug: 'cortex', archived: false }],
      },
      {
        management_workflow_claim: () => run,
        management_workflow_checkpoint: () => null,
        management_workflow_settle: (args) => ({
          ...run,
          state: args.p_state,
          detail: args.p_detail,
          evidence: args.p_evidence,
          action_id: args.p_action_id,
        }),
      },
    );
    const result = await advanceCollectionWorkflow(
      createOrgScopedClient(fake.client, 'acme'),
      '11111111-1111-4111-a111-111111111111',
    );
    return { result, tables: fake.tables };
  }
  it('recovers a proposed action without duplicating it', async () => {
    const { result, tables } = await progress({ state: 'proposed', expires_at: '2099-01-01' });
    expect(result?.state).toBe('approval');
    expect(tables.actions).toHaveLength(1);
  });
  it('does not retry an ambiguous approved send', async () => {
    const { result, tables } = await progress({ state: 'approved', execution_status: null });
    expect(result?.state).toBe('blocked');
    expect(tables.actions).toHaveLength(1);
  });
  it('waits after a confirmed send without creating another message', async () => {
    const { result, tables } = await progress({
      state: 'approved',
      execution_status: 'ok',
      outcome: 'replied',
    });
    expect(result?.state).toBe('waiting');
    expect(result?.detail).toMatch(/no demuestra/);
    expect(tables.actions).toHaveLength(1);
  });
  it('offers payment evidence without preparing a message when already paid', async () => {
    const { result, tables } = await progress(null, [payment()]);
    expect(result?.state).toBe('review');
    expect(tables.actions).toHaveLength(0);
  });
  it('never resurrects a dismissed proposal', async () => {
    const { result, tables } = await progress({ state: 'dismissed' });
    expect(result?.state).toBe('blocked');
    expect(tables.actions).toHaveLength(1);
  });
  it('binds a new draft to an active agent and immutable source amount', async () => {
    const { tables, result } = await progress(null);
    expect(tables.actions, result?.detail).toHaveLength(1);
    expect(tables.actions?.[0]?.agent_id).toBe('agent');
    expect(tables.actions?.[0]?.rationale).toContain('[saldo:COP:100.3]');
    expect(tables.actions?.[0]?.state).toBe('proposed');
  });
});
