import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), from: vi.fn(), run: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/agent', () => ({ buildToolContext: () => ({}) }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/tool-access', () => ({
  deniedToolPatterns: async () => [],
  isToolDenied: () => false,
}));
vi.mock('@cortex/agent-tools', () => ({
  getTool: () => ({}),
  toolIdAllowed: () => true,
  runTool: mocks.run,
}));
import { POST } from './route';
let stored: unknown;
let loseClaim = false;
const input = { meetUrl: 'https://meet.google.com/abc-defg-hij' };
const pending = {
  toolCallId: 'call-1',
  toolName: 'meetings_join',
  result: { __requires_confirmation: true, toolId: 'meetings.join', input },
};
const parts = [
  { type: 'tool-invocation', toolInvocation: { ...pending, state: 'result', args: input } },
];
beforeEach(() => {
  vi.clearAllMocks();
  stored = [];
  loseClaim = false;
  mocks.session.mockResolvedValue({ id: 'user', organization: { id: 'company' } });
  mocks.run.mockResolvedValue({ joined: true });
  mocks.from.mockImplementation((table: string) => {
    let update: { tool_results: unknown } | undefined;
    let expected: string | null | undefined;
    let list = false;
    const resolve = () => {
      if (table === 'conversations') return { data: { agent_id: 'agent' } };
      if (table === 'agents') return { data: { allowed_tool_ids: ['meetings.join'] } };
      if (update) {
        const matches = expected === null ? stored === null : JSON.stringify(stored) === expected;
        if (loseClaim || !matches) return { data: null };
        stored = update.tool_results;
        return { data: { id: 'message' } };
      }
      return {
        data: list ? [{ id: 'message', tool_results: stored, parts }] : { tool_results: stored },
      };
    };
    const q = {
      select: () => q,
      eq: (key: string, value: string) => {
        if (key === 'tool_results') expected = value;
        return q;
      },
      is: (key: string, value: null) => {
        if (key === 'tool_results') expected = value;
        return q;
      },
      order: () => q,
      limit: () => {
        list = true;
        return q;
      },
      update: (value: { tool_results: unknown }) => {
        update = value;
        return q;
      },
      single: async () => resolve(),
      maybeSingle: async () => resolve(),
      // biome-ignore lint/suspicious/noThenProperty: Models the Supabase awaitable query builder.
      then: (fn: (value: unknown) => unknown) => Promise.resolve(resolve()).then(fn),
    };
    return q;
  });
});
const request = (args = input) =>
  new Request('https://cortex.test/api/chat/confirm', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: '00000000-0000-4000-8000-000000000001',
      toolId: 'meetings.join',
      toolCallId: 'call-1',
      input: args,
    }),
  });
describe('confirmation of a legacy multi-step response', () => {
  it.each([[], null])(
    'claims missing legacy results and refuses a second execution (%j)',
    async (initial) => {
      stored = initial;
      expect((await POST(request() as never)).status).toBe(200);
      expect((await POST(request() as never)).status).toBe(409);
      expect(mocks.run).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses edited input and lost concurrent claims', async () => {
    expect(
      (await POST(request({ meetUrl: 'https://meet.google.com/other' }) as never)).status,
    ).toBe(409);
    loseClaim = true;
    expect((await POST(request() as never)).status).toBe(409);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
