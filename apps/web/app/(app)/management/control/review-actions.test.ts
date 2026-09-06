import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  db: vi.fn(),
  spaces: vi.fn(),
  generate: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: mocks.db }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('ai', () => ({ generateObject: mocks.generate }));
vi.mock('@cortex/agent-tools', () => ({
  NO_THINKING: {},
  chatModel: vi.fn(),
  checkMeter: vi.fn(),
  consumeToken: vi.fn(),
  isRefused: () => false,
  listVisibleSpaces: mocks.spaces,
}));
import { createFakeSupabase } from '../../../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { compareSources, resolveSourceReview } from './review-actions';
const left = '11111111-1111-4111-a111-111111111111';
const right = '22222222-2222-4222-a222-222222222222';
const id = '33333333-3333-4333-a333-333333333333';
function setup(privateRight = false) {
  const f = createFakeSupabase({
    kb_documents: [
      { id: left, collection_id: 'visible', status: 'ready' },
      { id: right, collection_id: privateRight ? 'private' : 'visible', status: 'ready' },
    ],
    kb_chunks: [
      { id: left, document_id: left, chunk_index: 0, content: 'Plazo de entrega: 3 días.' },
      { id: right, document_id: right, chunk_index: 0, content: 'Plazo de entrega: 8 días.' },
    ],
    knowledge_reviews: [],
  });
  mocks.db.mockReturnValue(f.client);
  return f;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: 'me', organization: { id: 'org' } });
  mocks.spaces.mockReset();
  mocks.spaces.mockResolvedValue([{ id: 'visible' }]);
});
it('does not send a private source to the model', async () => {
  setup(true);
  expect((await compareSources({ left, right, decision: 'Definir plazo de entrega' })).ok).toBe(
    false,
  );
  expect(mocks.generate).not.toHaveBeenCalled();
});
it('rejects invented citations instead of retaining them as evidence', async () => {
  const f = setup();
  mocks.generate.mockResolvedValue({
    object: {
      findings: [
        {
          issue: 'Plazo diferente',
          leftChunk: left,
          rightChunk: right,
          leftQuote: 'Plazo inventado de 10 días.',
          rightQuote: 'Plazo de entrega: 8 días.',
          question: 'Cuál es el plazo vigente?',
        },
      ],
    },
  });
  expect((await compareSources({ left, right, decision: 'Definir plazo de entrega' })).ok).toBe(
    true,
  );
  expect(f.tables.knowledge_reviews).toHaveLength(0);
});
it('checks access again before retaining evidence', async () => {
  const f = setup();
  mocks.spaces.mockResolvedValueOnce([{ id: 'visible' }]).mockResolvedValueOnce([]);
  mocks.generate.mockResolvedValue({
    object: {
      findings: [
        {
          issue: 'Plazo diferente',
          leftChunk: left,
          rightChunk: right,
          leftQuote: 'Plazo de entrega: 3 días.',
          rightQuote: 'Plazo de entrega: 8 días.',
          question: 'Cuál es el plazo vigente?',
        },
      ],
    },
  });
  expect((await compareSources({ left, right, decision: 'Definir plazo de entrega' })).ok).toBe(
    false,
  );
  expect(f.tables.knowledge_reviews).toHaveLength(0);
});
it('cannot resolve another person review', async () => {
  const f = setup();
  f.tables.knowledge_reviews?.push({
    id,
    user_id: 'other',
    left_document: left,
    right_document: right,
    resolution: 'pending',
  });
  expect(
    (
      await resolveSourceReview({
        id,
        resolution: 'left',
        note: 'Confirmado con la fuente vigente',
      })
    ).ok,
  ).toBe(false);
  expect(f.tables.knowledge_reviews?.[0]?.resolution).toBe('pending');
});
