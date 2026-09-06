import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  session: vi.fn(),
  refused: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@cortex/agent-tools', async (original) => ({
  ...(await original<typeof import('@cortex/agent-tools')>()),
  consumeToken: vi.fn(),
  checkMeter: vi.fn(),
  isRefused: mocks.refused,
  readManagement: async () => ({ profile: { data: {} } }),
  utilityModel: () => 'structured-model',
  commandOperation: mocks.save,
}));
vi.mock('ai', async (original) => ({
  ...(await original<typeof import('ai')>()),
  generateObject: mocks.generate,
}));
import { NoObjectGeneratedError } from 'ai';
import { prepareOperation } from './actions';
const narration =
  'Queremos organizar cartera sin inventar cifras ni contactar clientes sin aprobación.';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: 'user', role: 'org_admin', organization: { id: 'org' } });
  mocks.refused.mockReturnValue(false);
});
it('recovers one malformed model response without saving and preserves its deadline', async () => {
  mocks.generate.mockRejectedValueOnce(
    new NoObjectGeneratedError({
      response: { id: 'r', timestamp: new Date(), modelId: 'test' },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    }),
  );
  mocks.generate.mockResolvedValueOnce({
    object: { name: 'Preparar cartera', questions: ['¿Cuál es la línea base?'] },
  });
  expect((await prepareOperation(narration)).ok).toBe(true);
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[0]?.[0].abortSignal).toBe(
    mocks.generate.mock.calls[1]?.[0].abortSignal,
  );
  expect(mocks.save).not.toHaveBeenCalled();
});
it('does not repeat arbitrary provider errors', async () => {
  mocks.generate.mockRejectedValue(new Error('provider unavailable'));
  expect((await prepareOperation(narration)).ok).toBe(false);
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});
it('enforces admin and quota before calling the model', async () => {
  mocks.session.mockResolvedValueOnce({ role: 'member' });
  expect((await prepareOperation(narration)).ok).toBe(false);
  mocks.refused.mockReturnValue(true);
  expect(await prepareOperation(narration)).toMatchObject({
    ok: false,
    error: expect.stringContaining('plan'),
  });
  expect(mocks.generate).not.toHaveBeenCalled();
});
