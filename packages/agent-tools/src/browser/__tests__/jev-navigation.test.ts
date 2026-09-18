import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../index';
const transport = vi.hoisted(() => ({ read: vi.fn(), act: vi.fn() }));
vi.mock('../client', () => ({ createHttpTransport: () => transport }));
import { browserReadPage } from '../live';
import { browserActorKey } from '../profiles';
import { emptySnapshot } from './fixtures';

const fetchMock = vi.fn();
const ctx = { organizationId: 'org-a', userId: 'person-a', logger: {} } as ToolContext;
const element = {
  ref: 'e1',
  role: 'link',
  name: 'Certificados',
  tag: 'a',
  type: null,
  disabled: false,
  value: null,
  targets: [{ kind: 'role' as const, value: 'link', name: 'Certificados' }],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TYPESAFE_API_KEY', 'test');
  vi.stubEnv('JEV_BROWSER_NAVIGATION', 'on');
  vi.stubGlobal('fetch', fetchMock);
  transport.read.mockResolvedValue({ ok: true, data: emptySnapshot({ elements: [element] }) });
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: {
          target: {
            type: 'choice',
            choice: 'candidate_0',
            confidence: 0.99,
            probabilities: { none: 0.01, candidate_0: 0.99 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const input = {
  sessionId: 'session-a',
  findControl: { goal: 'Abrir certificados', action: 'click' as const },
};
describe('live navigation with Jev', () => {
  it('reads within the existing actor scope and only suggests a current control', async () => {
    const out = await browserReadPage.handler(input, ctx);
    expect(transport.read).toHaveBeenCalledWith('session-a', browserActorKey('org-a', 'person-a'));
    expect(out.controlSuggestion).toEqual({
      status: 'matched',
      ref: 'e1',
      name: 'Certificados',
      confidence: 0.99,
    });
    expect(transport.act).not.toHaveBeenCalled();
    expect(browserReadPage.outputSchema.safeParse(out).success).toBe(true);
  });
  it('still reads the page when Jev is disabled', async () => {
    vi.stubEnv('JEV_BROWSER_NAVIGATION', 'off');
    const out = await browserReadPage.handler(input, ctx);
    expect(out.page.elements[0]?.ref).toBe('e1');
    expect(out.controlSuggestion?.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not send a page to Jev if the profile denies access', async () => {
    transport.read.mockResolvedValue({ ok: false, reason: 'Forbidden' });
    await expect(browserReadPage.handler(input, ctx)).rejects.toThrow('Forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('leaves normal reads untouched unless a control was requested', async () => {
    const out = await browserReadPage.handler({ sessionId: 'session-a' }, ctx);
    expect(out.controlSuggestion).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('limits suggestions to the same visible control page', async () => {
    const out = await browserReadPage.handler({ ...input, elementOffset: 50 }, ctx);
    expect(out.page.elements).toHaveLength(0);
    expect(out.controlSuggestion?.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
