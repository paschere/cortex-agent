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

describe('source readiness evidence', () => {
  it('checks only the owner’s unexpired Feed entries in the selected company', async () => {
    const { client } = createFakeSupabase({
      chat_attachments: [
        { organization_id: 'a', created_by: 'me', feed_kind: 'text', purge_at: '2099-01-01' },
        { organization_id: 'b', created_by: 'me', feed_kind: 'text', purge_at: '2099-01-01' },
        { organization_id: 'a', created_by: 'other', feed_kind: 'text', purge_at: '2099-01-01' },
        { organization_id: 'a', created_by: 'me', feed_kind: 'text', purge_at: '2000-01-01' },
      ],
    });
    const checks = await readSetupDiagnostics(createOrgScopedClient(client, 'a'), 'me');
    expect(checks.find((c) => c.id === 'feed')).toMatchObject({
      state: 'checked',
      detail: expect.stringContaining('1 entradas'),
    });
    expect(checks.every((c) => Number.isFinite(Date.parse(c.checkedAt)))).toBe(true);
  });

  it('keeps expired or superseded documents out of a healthy source result', async () => {
    spaces.mockResolvedValue([{ id: 'visible-space' }]);
    const { client } = createFakeSupabase({
      kb_documents: [
        {
          id: 'expired',
          organization_id: 'a',
          collection_id: 'visible-space',
          status: 'ready',
          valid_until: '2000-01-01',
        },
        {
          id: 'replaced',
          organization_id: 'a',
          collection_id: 'visible-space',
          status: 'ready',
          superseded_by: 'new',
        },
        { id: 'hidden', organization_id: 'a', collection_id: 'private-space', status: 'ready' },
      ],
    });
    const checks = await readSetupDiagnostics(createOrgScopedClient(client, 'a'), 'me');
    expect(checks.find((c) => c.id === 'sources')).toMatchObject({
      state: 'unknown',
      detail: expect.stringContaining('2 documentos examinados; 2 requieren'),
    });
  });

  it('does not report workflows or previously tested APIs as operationally verified', async () => {
    const { client } = createFakeSupabase({
      management_workflows: [{ id: 'mission', organization_id: 'a', user_id: 'me' }],
      custom_tools: [
        {
          id: 'api',
          organization_id: 'a',
          enabled: true,
          last_tested_at: '2026-01-01',
          last_error: null,
        },
      ],
    });
    const checks = await readSetupDiagnostics(createOrgScopedClient(client, 'a'), 'me');
    expect(checks.find((c) => c.id === 'workflows')?.state).toBe('unknown');
    expect(checks.find((c) => c.id === 'custom-tools')?.state).toBe('unknown');
  });

  it('surfaces own MCP failures and company API failures without exposing stored errors', async () => {
    const { client } = createFakeSupabase({
      user_mcp_servers: [
        { organization_id: 'a', user_id: 'me', enabled: true, last_error: 'secret-url' },
        { organization_id: 'a', user_id: 'other', enabled: true, last_error: 'private' },
      ],
      custom_tools: [
        { organization_id: 'a', enabled: true, last_error: 'secret-api' },
        { organization_id: 'b', enabled: true, last_error: 'other-company' },
      ],
    });
    const checks = await readSetupDiagnostics(createOrgScopedClient(client, 'a'), 'me');
    for (const id of ['custom-tools', 'mcp']) {
      expect(checks.find((c) => c.id === id)).toMatchObject({
        state: 'blocked',
        detail: expect.stringContaining('1 con error'),
      });
    }
    expect(JSON.stringify(checks)).not.toMatch(/secret|private|other-company/);
  });
});
