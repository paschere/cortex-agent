import { describe, expect, it } from 'vitest';
import { buildModelComparison, modelLabel } from './model-comparison';
import type { UsageRow } from './usage-cost';

const row = (over: Partial<UsageRow>): UsageRow => ({
  userId: 'u',
  conversationId: 'c1',
  taskId: null,
  surface: 'web',
  source: 'chat',
  model: 'claude-sonnet-5-5',
  input: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  at: '2026-10-21T10:00:00Z',
  ...over,
});

describe('buildModelComparison', () => {
  it('costo por turno y por conversación, por modelo', () => {
    const c = buildModelComparison([
      row({ conversationId: 'a' }),
      row({ conversationId: 'a' }),
      row({ conversationId: 'b' }),
      row({ model: 'claude-haiku-5-5', conversationId: 'h', input: 50_000 }),
    ]);
    const sonnet = c.byModel.find((r) => r.label === 'Sonnet 5.5');
    const haiku = c.byModel.find((r) => r.label === 'Haiku 5.5');
    expect(sonnet).toMatchObject({ turns: 3, conversations: 2 });
    expect(sonnet?.usdPerTurn).toBeCloseTo(2, 6); // 1M entrada × $2
    expect(sonnet?.usdPerConversation).toBeCloseTo(3, 6); // $6 en 2 conversaciones
    expect(haiku?.usdPerTurn).toBeCloseTo(0.005, 6); // 50K de prompt: tramo corto
  });

  it('cuenta % de turnos con error de herramienta, reintentos y refusals', () => {
    const c = buildModelComparison([
      row({ model: 'claude-haiku-5-5', toolErrors: 2, retries: 1 }),
      row({ model: 'claude-haiku-5-5', toolErrors: 0, refusals: 1 }),
      row({ model: 'claude-haiku-5-5' }),
      row({ model: 'claude-haiku-5-5', toolErrors: 1 }),
    ]);
    const h = c.byModel[0];
    expect(h).toMatchObject({
      turns: 4,
      turnsWithToolError: 2,
      toolErrors: 3,
      retries: 1,
      refusals: 1,
    });
    expect(h?.toolErrorPct).toBe(50);
  });

  it('el brazo cuenta una conversación rescatada por Sonnet como Haiku', () => {
    const c = buildModelComparison([
      row({ model: 'claude-haiku-5-5', arm: 'haiku', toolErrors: 2, conversationId: 'x' }),
      row({ model: 'claude-sonnet-5-5', arm: 'haiku', fellBack: true, conversationId: 'x' }),
      row({ model: 'claude-sonnet-5-5', arm: 'sonnet', conversationId: 'y' }),
    ]);
    expect(c.hasExperiment).toBe(true);
    const arm = c.byArm.find((r) => r.key === 'haiku');
    expect(arm).toMatchObject({ turns: 2, conversations: 1, fellBack: 1, toolErrors: 2 });
    expect(c.byArm.find((r) => r.key === 'sonnet')?.turns).toBe(1);
    // Por modelo, el rescate cuenta en Sonnet.
    expect(c.byModel.find((r) => r.label === 'Sonnet 5.5')?.turns).toBe(2);
  });

  it('el 👍/👎 se atribuye al modelo del mensaje, y si no, al de la conversación', () => {
    const c = buildModelComparison(
      [
        row({ model: 'claude-haiku-5-5', arm: 'haiku', conversationId: 'h', messageId: 'm1' }),
        row({ model: 'claude-sonnet-5-5', arm: 'sonnet', conversationId: 's', messageId: 'm2' }),
      ],
      [
        { conversationId: 'h', messageId: 'm1', rating: -1 },
        { conversationId: 's', messageId: 'm2', rating: 1 },
        { conversationId: 's', messageId: 'otro', rating: 1 },
        { conversationId: 'zz', messageId: 'q', rating: -1 },
      ],
    );
    const h = c.byModel.find((r) => r.label === 'Haiku 5.5');
    const s = c.byModel.find((r) => r.label === 'Sonnet 5.5');
    expect(h).toMatchObject({ up: 0, down: 1, downPct: 100 });
    expect(s).toMatchObject({ up: 2, down: 0, downPct: 0 });
  });

  it('ignora tareas y filas sin conversación; sin experimento no hay brazos', () => {
    const c = buildModelComparison([
      row({ source: 'task' }),
      row({ conversationId: null }),
      row({}),
    ]);
    expect(c.byModel[0]?.turns).toBe(1);
    expect(c.hasExperiment).toBe(false);
  });

  it('un modelo sin tarifa suma turnos pero no dólares', () => {
    const c = buildModelComparison([row({ model: 'gemini-2.5-pro' })]);
    expect(c.byModel[0]).toMatchObject({ turns: 1, usd: 0, usdPerTurn: null });
  });

  it('etiquetas legibles', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('xyz')).toBe('xyz');
  });
});
