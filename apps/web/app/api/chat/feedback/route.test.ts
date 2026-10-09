import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  from: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  propose: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => ({ from: mocks.from }) }));
vi.mock('@cortex/agent-tools', () => ({
  FEEDBACK_REASONS: ['wrong_data', 'not_requested', 'slow', 'other'],
  saveFeedback: mocks.save,
  clearFeedback: mocks.clear,
  proposeCorrectionFromFeedback: mocks.propose,
  listConversationFeedback: vi.fn().mockResolvedValue([]),
}));
import { POST } from './route';

const CONV = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';

let ownedConversation = true;
const messages: Array<{ id: string; role: string; content: string; created_at: string }> = [
  {
    id: 'u1',
    role: 'user',
    content: '¿cuánto cobramos por kilo?',
    created_at: '2026-10-01T10:00:00Z',
  },
  {
    id: MSG,
    role: 'assistant',
    content: 'Cobramos 0,70 por kilo.',
    created_at: '2026-10-01T10:00:05Z',
  },
];

function request(body: unknown) {
  return new Request('http://x/api/chat/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  ownedConversation = true;
  mocks.session.mockResolvedValue({ id: 'user-1', organization: { id: 'company' } });
  mocks.save.mockResolvedValue({ reason: 'wrong_data', comment: 'el precio es 0,80 por kilo' });
  mocks.propose.mockResolvedValue('p1');
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    let lte: string | undefined;
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters[k] = v;
        return q;
      },
      lte: (_k: string, v: string) => {
        lte = v;
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (table === 'conversations')
          return { data: ownedConversation && filters.user_id === 'user-1' ? { id: CONV } : null };
        const rows = messages
          .filter((m) => m.role === filters.role)
          .filter((m) => (filters.id ? m.id === filters.id : true))
          .filter((m) => (lte ? m.created_at <= lte : true));
        return { data: rows[rows.length - 1] ?? null };
      },
    };
    return q;
  });
});

describe('POST /api/chat/feedback', () => {
  it('rechaza una conversación que no es de quien vota', async () => {
    ownedConversation = false;
    const res = await POST(request({ conversationId: CONV, messageId: MSG, rating: -1 }));
    expect(res.status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rechaza un cuerpo inválido', async () => {
    const res = await POST(request({ conversationId: 'no-uuid', messageId: MSG, rating: 1 }));
    expect(res.status).toBe(422);
  });

  it('guarda la pregunta y la respuesta leídas de la base, no del cuerpo', async () => {
    const res = await POST(
      request({
        conversationId: CONV,
        messageId: MSG,
        rating: -1,
        reason: 'wrong_data',
        comment: 'el precio es 0,80 por kilo',
        answer: 'texto inventado',
      }),
    );
    expect(res.status).toBe(200);
    const saved = mocks.save.mock.calls[0]?.[1];
    expect(saved).toMatchObject({
      userId: 'user-1',
      organizationId: 'company',
      messageId: MSG,
      rating: -1,
      question: '¿cuánto cobramos por kilo?',
      answer: 'Cobramos 0,70 por kilo.',
    });
    expect(await res.json()).toMatchObject({ ok: true, proposed: true });
  });

  it('resuelve un id del navegador a la última respuesta real', async () => {
    const res = await POST(request({ conversationId: CONV, messageId: 'client-abc', rating: 1 }));
    expect(res.status).toBe(200);
    expect(mocks.save.mock.calls[0]?.[1]).toMatchObject({
      messageId: MSG,
      rating: 1,
      answer: null,
    });
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it('permite quitar el voto', async () => {
    const res = await POST(request({ conversationId: CONV, messageId: MSG, action: 'clear' }));
    expect(res.status).toBe(200);
    expect(mocks.clear).toHaveBeenCalledWith(expect.anything(), 'user-1', MSG);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
