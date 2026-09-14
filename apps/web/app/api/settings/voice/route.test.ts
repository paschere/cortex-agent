import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  activate: vi.fn(),
  save: vi.fn(),
  consume: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => ({ scoped: true }) }));
vi.mock('@/lib/workspace-voice', () => ({
  SPANISH_CONSENT_PHRASE: 'Frase oficial.',
  canManageWorkspaceVoice: (role: string) => role === 'owner' || role === 'admin',
  listWorkspaceVoices: mocks.list,
  activateWorkspaceVoice: mocks.activate,
  saveWorkspaceVoice: mocks.save,
}));
vi.mock('@cortex/agent-tools', () => ({ consumeToken: mocks.consume }));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';

const jsonRequest = (body: unknown) =>
  new NextRequest('https://cortex.test/api/settings/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('OPENAI_API_KEY', 'server-secret');
  mocks.session.mockResolvedValue({
    id: 'person',
    organization: { id: 'workspace-a', role: 'owner' },
  });
  mocks.list.mockResolvedValue([]);
  mocks.activate.mockResolvedValue(null);
  mocks.consume.mockResolvedValue(undefined);
});

describe('workspace custom voice settings boundary', () => {
  it('allows members to read safe metadata but blocks provider checks before fetch', async () => {
    mocks.session.mockResolvedValue({
      id: 'member',
      organization: { id: 'workspace-a', role: 'member' },
    });
    const view = await GET();
    expect(await view.json()).toMatchObject({ canManage: false, configured: true, profiles: [] });
    const mutation = await POST(jsonRequest({ action: 'check-access' }));
    expect(mutation.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not activate a profile outside the current workspace', async () => {
    mocks.activate.mockResolvedValue(undefined);
    const response = await POST(
      jsonRequest({ action: 'activate', profileId: '11111111-1111-4111-a111-111111111111' }),
    );
    expect(response.status).toBe(404);
    expect(mocks.activate).toHaveBeenCalledWith(
      'workspace-a',
      '11111111-1111-4111-a111-111111111111',
    );
  });

  it('treats the provider 404 as unconfirmed access without leaking its body', async () => {
    mocks.fetch.mockResolvedValue(new Response('internal provider details', { status: 404 }));
    const response = await POST(jsonRequest({ action: 'check-access' }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.access).toBe('blocked');
    expect(body.message).not.toContain('internal provider details');
  });

  it('returns the current Spanish phrase from a successful provider response', async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ data: [{ language: 'es', phrase: 'Frase española vigente.' }] }),
    );
    const response = await POST(jsonRequest({ action: 'check-access' }));
    expect(await response.json()).toMatchObject({
      access: 'enabled',
      consentPhrase: 'Frase española vigente.',
    });
  });

  it('fails closed when a successful response has no Spanish phrase', async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ data: [{ language: 'en', phrase: 'Current English phrase.' }] }),
    );
    const response = await POST(jsonRequest({ action: 'check-access' }));
    expect(await response.json()).toMatchObject({ access: 'blocked' });
  });

  it('rejects oversized recordings before any provider write', async () => {
    const request = new NextRequest('https://cortex.test/api/settings/voice', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '4500000' },
      body: '--x--',
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
