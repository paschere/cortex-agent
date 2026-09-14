import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  find: vi.fn(),
  consume: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => ({ scoped: true }) }));
vi.mock('@/lib/workspace-voice', () => ({
  canManageWorkspaceVoice: (role: string) => role === 'owner' || role === 'admin',
  findWorkspaceVoice: mocks.find,
}));
vi.mock('@cortex/agent-tools', () => ({ consumeToken: mocks.consume }));
import { NextRequest } from 'next/server';
import { POST } from './route';

const ID = '11111111-1111-4111-a111-111111111111';
const request = () =>
  new NextRequest('https://cortex.test/api/settings/voice/preview', {
    method: 'POST',
    body: JSON.stringify({ profileId: ID }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('OPENAI_API_KEY', 'server-secret');
  mocks.session.mockResolvedValue({
    id: 'person',
    organization: { id: 'workspace-a', role: 'owner' },
  });
  mocks.find.mockResolvedValue({ id: ID, providerId: 'voice_private', active: true });
  mocks.consume.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(new Response('mp3-bytes'));
});

describe('custom voice preview boundary', () => {
  it('uses only the provider id resolved from the current workspace', async () => {
    const response = await POST(request());
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(mocks.find).toHaveBeenCalledWith('workspace-a', ID);
    const call = mocks.fetch.mock.calls[0];
    if (!call) throw new Error('Expected provider request');
    const [, options] = call;
    expect(JSON.parse(options.body)).toMatchObject({
      voice: { id: 'voice_private' },
      response_format: 'mp3',
      instructions: 'Habla en español colombiano, con tono conversacional y pausas naturales.',
    });
    expect(JSON.parse(options.body)).not.toHaveProperty('language');
    expect(JSON.parse(options.body)).not.toHaveProperty('format');
  });

  it('does not contact OpenAI for another workspace but allows an owned inactive profile', async () => {
    mocks.find.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    mocks.find.mockResolvedValue({ id: ID, providerId: 'voice_private', active: false });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
