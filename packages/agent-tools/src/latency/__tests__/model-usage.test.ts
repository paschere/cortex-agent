import { describe, expect, it, vi } from 'vitest';
import { anthropicStepCache, recordModelUsage, sumCacheSteps } from '../usage';

describe('consumo del modelo (0228)', () => {
  it('suma los pasos de caché de un turno en entrada, lectura y escritura', () => {
    expect(
      sumCacheSteps([
        { promptTokens: 1200, read: 0, written: 8000 },
        { promptTokens: 300, read: 8000, written: 0 },
        { promptTokens: 250, read: 8000 },
      ]),
    ).toEqual({ input: 1750, cacheRead: 16000, cacheWrite: 8000 });
  });

  it('lee el caché de los metadatos de Anthropic sin asumir nada', () => {
    expect(
      anthropicStepCache({ anthropic: { cacheReadInputTokens: 10, cacheCreationInputTokens: 5 } }),
    ).toEqual({ read: 10, written: 5 });
    expect(anthropicStepCache(undefined)).toEqual({ read: 0, written: 0 });
    expect(anthropicStepCache({ anthropic: { cacheReadInputTokens: 'x' } })).toEqual({
      read: 0,
      written: 0,
    });
  });

  it('escribe una fila con el modelo y los cuatro números', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordModelUsage(db as never, {
      userId: 'u1',
      taskId: 't1',
      conversationId: 'c1',
      source: 'task',
      surface: 'task',
      model: 'claude-sonnet-5',
      steps: 3,
      inputTokens: 1500.4,
      cacheReadTokens: 20000,
      cacheWriteTokens: 8000,
      outputTokens: 900,
    });
    expect(db.from).toHaveBeenCalledWith('model_usage');
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 't1',
        model: 'claude-sonnet-5',
        steps: 3,
        input_tokens: 1500,
        cache_read_tokens: 20000,
        cache_write_tokens: 8000,
        output_tokens: 900,
        source: 'task',
      }),
    );
  });

  it('no escribe filas vacías y nunca lanza (tabla ausente, red caída)', async () => {
    const insert = vi.fn();
    const db = { from: vi.fn(() => ({ insert })) };
    await recordModelUsage(db as never, {
      userId: null,
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(insert).not.toHaveBeenCalled();
    const boom = { from: () => ({ insert: () => Promise.reject(new Error('sin tabla')) }) };
    const warn = vi.fn();
    await expect(
      recordModelUsage(
        boom as never,
        { userId: null, model: 'm', inputTokens: 5, outputTokens: 5 },
        { warn },
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
