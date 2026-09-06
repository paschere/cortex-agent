import { beforeEach, describe, expect, it, vi } from 'vitest';
const board = vi.hoisted(() => vi.fn());
vi.mock('@cortex/agent-tools', () => ({ readManagement: board }));
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../../packages/agent-tools/src/tenancy/scoped-client';
import { readLaunchPlan } from './launch-store';
beforeEach(() => {
  board.mockReset();
  board.mockResolvedValue(null);
});
describe('launch plan source boundaries', () => {
  it('does not borrow another company data or another person private profiles and routines', async () => {
    const org = 'company-a';
    const { client } = createFakeSupabase({
      company_facts: [{ id: 'foreign', organization_id: 'company-b' }],
      browser_profiles: [{ id: 'private', organization_id: org, owner_id: 'other', shared: false }],
      scheduled_jobs: [
        {
          id: 'private-job',
          organization_id: org,
          user_id: 'other',
          is_global: false,
          status: 'active',
        },
      ],
    });
    const result = await readLaunchPlan(createOrgScopedClient(client, org), 'me', true);
    expect(result.steps.find((s) => s.id === 'company')?.state).toBe('pending');
    expect(result.steps.find((s) => s.id === 'browser')?.state).toBe('pending');
    expect(result.steps.find((s) => s.id === 'routine')?.state).toBe('pending');
    expect(result.steps.find((s) => s.id === 'authority')?.state).toBe('unknown');
  });
  it('a missing management source is unknown, never completed', async () => {
    board.mockRejectedValue(new Error('offline'));
    const { client } = createFakeSupabase({});
    const result = await readLaunchPlan(createOrgScopedClient(client, 'company-a'), 'me', false);
    expect(result.steps.find((s) => s.id === 'scope')?.state).toBe('unknown');
  });
});
