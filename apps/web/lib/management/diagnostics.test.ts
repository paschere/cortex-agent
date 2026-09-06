import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const spaces = vi.hoisted(() => vi.fn());
vi.mock('@cortex/agent-tools', () => ({ listVisibleSpaces: spaces }));
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../../packages/agent-tools/src/tenancy/scoped-client';
import { readSetupDiagnostics } from './diagnostics';
beforeEach(() => {
  spaces.mockReset();
  spaces.mockResolvedValue([]);
  vi.stubEnv('BROWSER_SERVICE_URL', '');
  vi.stubEnv('BROWSER_SERVICE_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('automatic setup diagnostics', () => {
  it('does not use another person connection, private job or another organization', async () => {
    const { client } = createFakeSupabase({
      integrations: [{ organization_id: 'a', user_id: 'other', provider: 'gmail' }],
      scheduled_jobs: [
        { organization_id: 'a', user_id: 'other', is_global: false, status: 'active' },
      ],
    });
    const checks = await readSetupDiagnostics(createOrgScopedClient(client, 'a'), 'me');
    expect(checks.find((c) => c.id === 'connections')?.state).toBe('blocked');
    expect(checks.find((c) => c.id === 'routines')?.state).toBe('blocked');
  });
  it('server health does not prove an authenticated browser session', async () => {
    vi.stubEnv('BROWSER_SERVICE_URL', 'https://browser.example');
    vi.stubEnv('BROWSER_SERVICE_TOKEN', 'test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
    );
    const { client } = createFakeSupabase({});
    const checks = await readSetupDiagnostics(createOrgScopedClient(client, 'a'), 'me');
    expect(checks.find((c) => c.id === 'browser')?.state).toBe('unknown');
  });
  it('failed source reads remain unknown', async () => {
    spaces.mockRejectedValue(new Error('offline'));
    const { client } = createFakeSupabase({});
    const checks = await readSetupDiagnostics(createOrgScopedClient(client, 'a'), 'me');
    expect(checks.find((c) => c.id === 'sources')?.state).toBe('unknown');
  });
});
