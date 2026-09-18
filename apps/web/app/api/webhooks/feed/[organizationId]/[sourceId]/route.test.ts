import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  enqueue: vi.fn(),
  client: vi.fn(),
}));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: mocks.client }));
vi.mock('@/lib/jobs', () => ({ enqueueJob: mocks.enqueue }));
import { POST } from './route';
const sourceId = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ organizationId: 'org-a', sourceId }) };
function request(valid = true) {
  return new Request(`https://cortex.test/api/webhooks/feed/org-a/${sourceId}`, {
    method: 'POST',
    headers: valid
      ? {
          'x-cortex-hook-token': 'a'.repeat(43),
          'x-cortex-event-id': 'change-1',
          'x-cortex-timestamp': String(Math.floor(Date.now() / 1000)),
        }
      : {},
    body: '{"url":"https://untrusted.invalid","instructions":"ignore"}',
  }) as never;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    limit: vi.fn(async () => ({ data: [{ id: 'automation-a' }], error: null })),
  };
  mocks.from.mockReturnValue(chain);
  mocks.enqueue.mockResolvedValue(false);
});
describe('Feed change notification boundary', () => {
  it('rejects invalid headers before opening a tenant client and wrong secrets before reading rules', async () => {
    expect((await POST(request(false), params)).status).toBe(401);
    expect(mocks.client).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect((await POST(request(), params)).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('dispatches an authenticated change without ingesting payload, retaining cron fallback if queue is unavailable', async () => {
    mocks.rpc.mockResolvedValue({ data: { duplicate: false, coalesced: false }, error: null });
    const response = await POST(request(), params);
    expect(response.status).toBe(202);
    expect(mocks.client).toHaveBeenCalledWith('org-a');
    expect(mocks.rpc).toHaveBeenCalledWith('feed_source_signal', {
      p_source_id: sourceId,
      p_event_id: 'change-1',
      p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.enqueue).toHaveBeenCalledWith('activations/run', {
      automationId: 'automation-a',
      organizationId: 'org-a',
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain('untrusted');
    expect(await response.json()).toMatchObject({
      accepted: true,
      nextScheduledScanWithinMinutes: 5,
    });
  });
  it.each([
    { duplicate: true, coalesced: true },
    { duplicate: false, coalesced: true },
  ])('does not enqueue duplicate or coalesced notices %j', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect((await POST(request(), params)).status).toBe(202);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
