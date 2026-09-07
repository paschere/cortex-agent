import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  authSession: vi.fn(),
  memberships: vi.fn(),
  context: vi.fn(),
  plan: vi.fn(),
  rate: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.authSession } } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/organization', () => ({ listMemberships: mocks.memberships }));
vi.mock('@/lib/global-chat/context', () => ({ globalWorkspaceContext: mocks.context }));
vi.mock('@cortex/agent-tools', () => ({
  readWorkspacePlan: mocks.plan,
  consumeToken: mocks.rate,
}));

import { POST } from './route';

const request = (workspaceIds: string[]) =>
  new Request('https://cortex.test/api/chat/global/realtime', {
    method: 'POST',
    body: JSON.stringify({ sdp: 'v=0\no=browser-offer', workspaceIds, history: [] }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'server-secret');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.session.mockResolvedValue({});
  mocks.authSession.mockResolvedValue({ user: { id: 'ba-person' } });
  mocks.memberships.mockResolvedValue([
    { id: 'personal', name: 'Personal', role: 'owner', kind: 'personal' },
    { id: 'company', name: 'Acme', role: 'owner', kind: 'company' },
  ]);
  mocks.context.mockResolvedValue({ db: { personal: true }, ctx: { userId: 'directory-person' } });
  mocks.plan.mockResolvedValue({ plan: { code: 'business' } });
  mocks.rate.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(new Response('v=0\no=answer'));
});

describe('global realtime boundary', () => {
  it('rejects a stale workspace before metering or contacting OpenAI', async () => {
    const response = await POST(request(['removed-company']));
    expect(response.status).toBe(403);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows no company without falling back and meters the personal directory', async () => {
    const response = await POST(request([]));
    expect(response.status).toBe(200);
    expect(mocks.context).toHaveBeenCalledWith('ba-person', 'personal');
    expect(mocks.rate).toHaveBeenCalledWith(
      { personal: true },
      'directory-person',
      'voice.realtime',
      3,
    );
    const call = mocks.fetch.mock.calls[0];
    if (!call) throw new Error('Expected OpenAI request');
    const session = JSON.parse(call[1].body.get('session'));
    expect(session.tools[0].name).toBe('consult_cortex');
    expect(session.tools[0].description).toContain('ninguno');
    expect(session.instructions).toContain('No recibes datos internos automáticamente');
  });

  it('describes only memberships explicitly selected by the client', async () => {
    await POST(request(['company']));
    const call = mocks.fetch.mock.calls[0];
    if (!call) throw new Error('Expected OpenAI request');
    const session = JSON.parse(call[1].body.get('session'));
    expect(session.tools[0].description).toContain('Acme (company)');
    expect(session.tools[0].description).not.toContain('Personal (personal)');
  });
});
