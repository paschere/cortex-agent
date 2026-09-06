import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  plan: vi.fn(),
  rate: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => ({ scoped: true }) }));
vi.mock('@cortex/agent-tools', () => ({ readWorkspacePlan: mocks.plan, consumeToken: mocks.rate }));
import { POST } from './route';
const request = (body: unknown = { sdp: 'v=0\no=browser-offer' }) =>
  new Request('https://cortex.test/api/voice/realtime', {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('OPENAI_API_KEY', 'server-secret');
  mocks.session.mockResolvedValue({ id: 'person', organization: { id: 'company' } });
  mocks.plan.mockResolvedValue({ plan: { code: 'business' } });
  mocks.rate.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(new Response('v=0\no=answer'));
});
describe('realtime session boundary', () => {
  it('requires a session before contacting the provider', async () => {
    mocks.session.mockRejectedValue(new Error('Unauthenticated'));
    await expect(POST(request())).rejects.toThrow('Unauthenticated');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('refuses unsupported plans, invalid input and unavailable configuration', async () => {
    expect((await POST(request({ sdp: '' }))).status).toBe(400);
    mocks.plan.mockResolvedValue({ plan: { code: 'free' } });
    expect((await POST(request())).status).toBe(402);
    mocks.plan.mockResolvedValue({ plan: { code: 'business' } });
    vi.stubEnv('OPENAI_API_KEY', '');
    expect((await POST(request())).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('keeps the key server-side and sends only the SDP answer to the client', async () => {
    const response = await POST(request());
    expect(await response.text()).toBe('v=0\no=answer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const call = mocks.fetch.mock.calls[0];
    if (!call) throw new Error('Expected provider request');
    const [, options] = call;
    expect(options.headers.Authorization).toBe('Bearer server-secret');
    expect(options.headers['OpenAI-Safety-Identifier']).not.toContain('person');
    expect(JSON.parse(options.body.get('session')).tools[0].name).toBe('consult_cortex');
    expect(mocks.rate).toHaveBeenCalledWith(expect.anything(), 'person', 'voice.realtime', 3);
  });
  it('rate limits session creation and does not leak provider errors', async () => {
    mocks.rate.mockRejectedValueOnce(new Error('limit'));
    expect((await POST(request())).status).toBe(429);
    mocks.fetch.mockResolvedValue(new Response('provider secret debug', { status: 500 }));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret');
  });
});
