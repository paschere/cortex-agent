import { expect, it } from 'vitest';
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../../packages/agent-tools/src/tenancy/scoped-client';
import { readRoutineAuthority } from './routine-authority';
it('ignores legacy approval in mandate mode and notices a live pause or owner change', async () => {
  const row = {
    id: 'job',
    organization_id: 'a',
    user_id: 'me',
    status: 'active',
    mandate_only: true,
    allow_unattended_writes: true,
  };
  const { client, tables } = createFakeSupabase({ scheduled_jobs: [row] });
  const db = createOrgScopedClient(client, 'a');
  expect(await readRoutineAuthority(db, 'job', 'me')).toEqual({
    scopedMandatesOnly: true,
    confirmed: false,
  });
  if (!tables.scheduled_jobs?.[0]) throw new Error('missing job');
  tables.scheduled_jobs[0].status = 'paused';
  await expect(readRoutineAuthority(db, 'job', 'me')).rejects.toThrow('detuvo');
  await expect(readRoutineAuthority(db, 'job', 'other')).rejects.toThrow();
  await expect(
    readRoutineAuthority(createOrgScopedClient(client, 'b'), 'job', 'me'),
  ).rejects.toThrow();
});
