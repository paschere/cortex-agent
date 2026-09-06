import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  model: vi.fn(),
  websocket: vi.fn(),
  context: vi.fn(),
  plan: vi.fn(),
}));
vi.mock('@/lib/session', () => ({
  requireSession: async () => ({ id: 'person', organization: { id: 'company' } }),
}));
vi.mock('@/lib/supabase/service', () => ({
  getOrgScopedClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: 'agent', system_prompt: 'Cortex' } }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/agent', () => ({ buildToolContext: mocks.context }));
vi.mock('@/lib/system-prompt', () => ({ buildSystemPrompt: async () => ({ system: 'Cortex' }) }));
vi.mock('ws', () => ({ default: mocks.websocket }));
vi.mock('@cortex/agent-tools', () => ({
  readWorkspacePlan: mocks.plan,
  voiceModel: () => 'test-model',
  runTool: mocks.run,
  listTools: () => [{ id: 'kb.search', description: 'Search', inputSchema: z.object({}) }],
}));
vi.mock('ai', () => ({ tool: (definition: unknown) => definition, streamText: mocks.model }));
import { NextRequest } from 'next/server';
import { POST } from './route';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DEEPGRAM_API_KEY', 'configured-but-must-not-be-used');
  mocks.plan.mockResolvedValue({ plan: { code: 'business' } });
  mocks.context.mockImplementation((value) => value);
  mocks.run.mockResolvedValue({ found: true });
  mocks.model.mockImplementation((options) => ({
    textStream: (async function* () {
      await options.tools.kb_search.execute({}, { abortSignal: options.abortSignal });
      yield 'Resultado verificado.';
    })(),
  }));
});
describe('Cortex voice tool bridge', () => {
  it('keeps identity, scope, confirmation and cancellation while bypassing TTS', async () => {
    const scope = '11111111-1111-4111-a111-111111111111';
    const req = new NextRequest('https://cortex.test/api/voice/turn', {
      method: 'POST',
      body: JSON.stringify({
        question: 'Consulta el documento',
        textOnly: true,
        spaceIds: [scope],
      }),
    });
    const response = await POST(req);
    expect(await response.text()).toContain('Resultado verificado.');
    expect(mocks.context).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'company', userId: 'person', kbSpaceIds: [scope] }),
    );
    expect(mocks.run).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      { confirmed: false },
    );
    expect(mocks.websocket).not.toHaveBeenCalled();
  });
  it('aborts model work when the response stream is cancelled', async () => {
    let finish: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.model.mockImplementation(() => ({
      textStream: (async function* () {
        await waiting;
        yield 'Respuesta tardía.';
      })(),
    }));
    const request = new NextRequest('https://cortex.test/api/voice/turn', {
      method: 'POST',
      body: JSON.stringify({ question: 'Consulta', textOnly: true }),
    });
    const response = await POST(request);
    await response.body?.cancel();
    const call = mocks.model.mock.calls[0];
    if (!call) throw new Error('Expected model invocation');
    expect(call[0].abortSignal.aborted).toBe(true);
    finish();
  });
});
