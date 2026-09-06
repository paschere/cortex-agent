import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ notify: vi.fn(), board: vi.fn(), events: vi.fn() }));
vi.mock('@/lib/notifications/notify', () => ({ notify: mocks.notify }));
vi.mock('@cortex/agent-tools', async (original) => ({
  ...(await original<typeof import('@cortex/agent-tools')>()),
  readManagement: mocks.board,
  readOperationEvents: mocks.events,
  bogotaToday: () => '2026-09-06',
}));
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../../packages/agent-tools/src/tenancy/scoped-client';
import { notifyOperationAttention } from './operation-attention';
function db(state = 'active', enabled = true, org = 'org') {
  return createOrgScopedClient(
    createFakeSupabase({
      management_operations: [
        {
          id: 'cycle',
          organization_id: org,
          state,
          data: {
            notifyInApp: enabled,
            startOn: '2026-09-01',
            ownerId: 'manager',
            caseIds: ['case'],
          },
        },
      ],
    }).client,
    'org',
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.notify.mockResolvedValue('notice');
  mocks.board.mockResolvedValue({
    truncated: false,
    people: [{ id: 'owner' }, { id: 'manager' }],
    cases: [
      {
        id: 'case',
        data: {
          state: 'working',
          ownerId: 'owner',
          nextReviewOn: '2026-09-06',
          title: 'Cobrar factura',
          nextAction: 'Revisar soporte',
        },
      },
    ],
  });
  mocks.events.mockResolvedValue({ events: [], truncated: false });
});
describe('operation notification boundaries', () => {
  it('requires opt-in, an active cycle and matching tenant', async () => {
    await notifyOperationAttention(db('paused'), 'cycle');
    await notifyOperationAttention(db('active', false), 'cycle');
    await notifyOperationAttention(db('active', true, 'foreign'), 'cycle');
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('notifies the owner using a stable identity across retries', async () => {
    await notifyOperationAttention(db(), 'cycle');
    await notifyOperationAttention(db(), 'cycle');
    expect(mocks.notify.mock.calls[0]?.[1]).toMatchObject({
      userId: 'owner',
      dedupeKey: 'operation:cycle:case:case:owner:2026-09-06',
    });
    expect(mocks.notify.mock.calls[0]?.[1]).toEqual(mocks.notify.mock.calls[1]?.[1]);
  });
  it('rejects partial history and retries a failed write', async () => {
    mocks.events.mockResolvedValueOnce({ events: [], truncated: true });
    await expect(notifyOperationAttention(db(), 'cycle')).rejects.toThrow('parcial');
    expect(mocks.notify).not.toHaveBeenCalled();
    mocks.notify.mockResolvedValue(null);
    await expect(notifyOperationAttention(db(), 'cycle')).rejects.toThrow('aviso');
  });
  it('does not notify verified cases or decisions already resolved', async () => {
    mocks.board.mockResolvedValue({
      truncated: false,
      people: [{ id: 'manager' }],
      cases: [{ id: 'case', data: { state: 'verified' } }],
    });
    mocks.events.mockResolvedValue({
      truncated: false,
      events: [
        {
          id: 'decision',
          data: {
            kind: 'decision',
            decision: { dueOn: '2026-09-01', question: 'Elegir proveedor' },
          },
        },
        { data: { kind: 'resolve', decisionId: 'decision' } },
      ],
    });
    await notifyOperationAttention(db(), 'cycle');
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
