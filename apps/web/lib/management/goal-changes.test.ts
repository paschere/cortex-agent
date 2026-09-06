import { expect, it } from 'vitest';
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../../packages/agent-tools/src/tenancy/scoped-client';
import { readGoalChanges } from './goal-changes';
it('preserves creation and retirement as separate events with exact period and company boundaries', async () => {
  const base = {
    label: 'Cumplimiento',
    target_value: 90,
    unit: 'percent',
    cadence: 'week',
    created_by: 'a',
    archived_by: 'b',
  };
  const { client } = createFakeSupabase({
    goals: [
      {
        ...base,
        id: 'old',
        organization_id: 'a',
        created_at: '2026-08-01T12:00:00Z',
        archived_at: '2026-09-02T12:00:00Z',
      },
      {
        ...base,
        id: 'new',
        organization_id: 'a',
        created_at: '2026-09-02T12:00:00Z',
        archived_at: null,
      },
      {
        ...base,
        id: 'foreign',
        organization_id: 'b',
        created_at: '2026-09-02T12:00:00Z',
        archived_at: null,
      },
      {
        ...base,
        id: 'next',
        organization_id: 'a',
        created_at: '2026-09-07T05:00:00Z',
        archived_at: null,
      },
    ],
  });
  const r = await readGoalChanges(
    createOrgScopedClient(client, 'a'),
    '2026-08-31T05:00:00Z',
    '2026-09-07T05:00:00Z',
  );
  expect(r.changes.map((c) => c.key).sort()).toEqual(['new:created', 'old:archived']);
  expect(r.changes.find((c) => c.action === 'archived')?.actorId).toBe('b');
});
