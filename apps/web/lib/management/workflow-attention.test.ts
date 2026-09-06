import { beforeEach, describe, expect, it, vi } from 'vitest';
const notify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notifications/notify', () => ({ notify }));
import type { CollectionWorkflow } from '@cortex/agent-tools';
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../../packages/agent-tools/src/tenancy/scoped-client';
import { notifyWorkflowAttention } from './workflow-attention';
beforeEach(() => {
  notify.mockReset();
  notify.mockResolvedValue('notice');
});
const run = {
  id: 'workflow',
  user_id: 'me',
  state: 'waiting',
  action_id: 'action',
  detail: 'Respuesta pendiente',
} as CollectionWorkflow;
function db(outcome: string, user = 'me') {
  return createOrgScopedClient(
    createFakeSupabase({
      actions: [{ id: 'action', user_id: user, organization_id: 'org', outcome }],
    }).client,
    'org',
  );
}
describe('follow-up attention', () => {
  it('uses the same event identity across retries and never marks a reply paid', async () => {
    await notifyWorkflowAttention(db('replied'), run);
    await notifyWorkflowAttention(db('replied'), { ...run, revision: 90 });
    expect(notify.mock.calls[0]?.[1].dedupeKey).toBe(notify.mock.calls[1]?.[1].dedupeKey);
    expect(notify.mock.calls[0]?.[1].title).toContain('siguiente paso');
    expect(run.state).toBe('waiting');
  });
  it('does not notify from another person action or normal waiting', async () => {
    await notifyWorkflowAttention(db('replied', 'other'), run);
    await notifyWorkflowAttention(db('pending'), run);
    expect(notify).not.toHaveBeenCalled();
  });
  it('retries a failed notification and ignores stopped processes', async () => {
    notify.mockResolvedValue(null);
    await expect(notifyWorkflowAttention(db('replied'), run)).rejects.toThrow('aviso');
    notify.mockClear();
    await notifyWorkflowAttention(db('replied'), { ...run, state: 'cancelled' });
    expect(notify).not.toHaveBeenCalled();
  });
});
