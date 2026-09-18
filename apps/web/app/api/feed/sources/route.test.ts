import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/activations/request', () => ({ isSameOrigin: vi.fn(() => true) }));
vi.mock('@/lib/feed/api-source', () => ({ refreshFeedSource: vi.fn() }));
vi.mock('@/lib/session', () => ({
  requireSession: vi.fn(async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    organization: { id: 'org-a' },
  })),
}));
vi.mock('@/lib/supabase/service', () => ({
  getOrgScopedClient: vi.fn(() => ({ from: mocks.from })),
}));

import { POST } from './route';

function updateChain(
  result: { data?: unknown; error?: unknown },
  statusFilter?: ReturnType<typeof vi.fn>,
) {
  const chain: Record<string, unknown> = {};
  chain.update = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.in = statusFilter ?? vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => result);
  // The automation update is awaited directly after `.in()`.
  Object.defineProperty(chain, 'then', {
    value: (resolve: (value: unknown) => void) => resolve(result),
  });
  return chain;
}

describe('POST /api/feed/sources disable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves needs-review automations when disabling their source', async () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const disabledSource = {
      id: sourceId,
      kind: 'api',
      name: 'ERP',
      enabled: false,
      status: 'disabled',
    };
    const statusFilter = vi.fn(() => automationUpdate);
    const sourceUpdate = updateChain({ data: disabledSource, error: null });
    const automationUpdate = updateChain({ error: null }, statusFilter);
    mocks.from.mockImplementation((table: string) =>
      table === 'feed_sources' ? sourceUpdate : automationUpdate,
    );

    const response = await POST(
      new Request('https://cortex.test/api/feed/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'disable', id: sourceId }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(statusFilter).toHaveBeenCalledWith('status', ['active', 'paused']);
    expect(statusFilter.mock.calls.flat()).not.toContain('needs_review');
  });
});
