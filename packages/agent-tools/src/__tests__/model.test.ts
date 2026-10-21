import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_MODEL,
  FAST_MODEL,
  HEAVY_MODEL,
  type ModelEvent,
  forcedToolToAuto,
  makeFetch,
  modelFamily,
  reasoningSignatureGuard,
  resolveModelId,
  rewriteBody,
} from '../model';

const base = (model: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model,
  max_tokens: 4096,
  temperature: 0,
  top_p: 1,
  top_k: 5,
  system: 'Eres Cortex.',
  messages: [{ role: 'user', content: 'hola' }],
  ...extra,
});

describe('modelFamily / resolveModelId', () => {
  it('reconoce las tres 5.5 y no las confunde con las anteriores', () => {
    expect(modelFamily('claude-sonnet-5-5')).toBe('sonnet-5-5');
    expect(modelFamily('anthropic/claude-opus-5-5')).toBe('opus-5-5');
    expect(modelFamily('claude-haiku-5-5')).toBe('haiku-5-5');
    expect(modelFamily('claude-sonnet-5')).toBe('legacy-5');
    expect(modelFamily('claude-opus-5')).toBe('legacy-5');
    expect(modelFamily('claude-haiku-4-5')).toBe('older');
    expect(modelFamily(undefined)).toBe('older');
  });

  it('mapea los ids históricos de las filas de agentes al modelo vigente', () => {
    expect(resolveModelId('claude-sonnet-5')).toBe('claude-sonnet-5-5');
    expect(resolveModelId('claude-opus-5')).toBe('claude-opus-5-5');
    expect(resolveModelId('claude-haiku-4-5')).toBe('claude-haiku-5-5');
    expect(resolveModelId('gemini-2.5-pro')).toBe(CHAT_MODEL);
    expect(resolveModelId(null)).toBe(CHAT_MODEL);
    expect(resolveModelId('claude-opus-5-5')).toBe(HEAVY_MODEL);
  });
});

describe('rewriteBody por modelo', () => {
  it('quita siempre temperature, top_p y top_k', () => {
    for (const m of [CHAT_MODEL, HEAVY_MODEL, FAST_MODEL, 'claude-haiku-4-5']) {
      const body = base(m);
      rewriteBody(body, { mode: 'off' });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
    }
  });

  it('Sonnet 5.5 sin pensar es between_tools a esfuerzo explícito, nunca disabled', () => {
    const body = base(CHAT_MODEL);
    rewriteBody(body, { mode: 'off', effort: 'medium' });
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect((body.output_config as { effort: string }).effort).toBe('medium');
  });

  it('Sonnet 5.5: between_tools no admite xhigh/max, se baja a high', () => {
    const body = base(CHAT_MODEL);
    rewriteBody(body, { mode: 'off', effort: 'max' });
    expect((body.output_config as { effort: string }).effort).toBe('high');
    expect(body.thinking).toEqual({ type: 'between_tools' });
  });

  it('Sonnet 5.5 con razonamiento visible: adaptive + summarized y espacio para pensar', () => {
    const body = base(CHAT_MODEL);
    rewriteBody(body, { mode: 'summarized', effort: 'medium' });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect((body.output_config as { effort: string }).effort).toBe('medium');
    expect(body.max_tokens).toBeGreaterThanOrEqual(16_000);
  });

  it('Opus 5.5 nunca recibe disabled: siempre adaptive, con effort explícito', () => {
    for (const mode of ['off', 'summarized'] as const) {
      const body = base(HEAVY_MODEL);
      rewriteBody(body, { mode, effort: 'low' });
      expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect((body.output_config as { effort: string }).effort).toBe('low');
      expect(body.max_tokens).toBeGreaterThanOrEqual(16_000);
    }
  });

  it('Haiku 5.5 apagado es disabled a esfuerzo ≤ high; nunca budget_tokens', () => {
    const body = base(FAST_MODEL);
    rewriteBody(body, { mode: 'off', effort: 'xhigh' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect((body.output_config as { effort: string }).effort).toBe('high');
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
  });

  it('Haiku 5.5 acepta la herramienta forzada: no se toca tool_choice ni el system', () => {
    const body = base(FAST_MODEL, { tool_choice: { type: 'tool', name: 'json' } });
    const { forcedRewritten } = rewriteBody(body, { mode: 'off', effort: 'low', cache: false });
    expect(forcedRewritten).toBe(false);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'json' });
    expect(body.system).toBe('Eres Cortex.');
  });

  it('Sonnet 5.5 y Opus 5.5 desfuerzan la herramienta: auto + instrucción en el system', () => {
    for (const m of [CHAT_MODEL, HEAVY_MODEL]) {
      const body = base(m, { tool_choice: { type: 'tool', name: 'json' } });
      const { forcedRewritten } = rewriteBody(body, { mode: 'off' });
      expect(forcedRewritten).toBe(true);
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(JSON.stringify(body.system)).toContain('«json»');
    }
  });

  it('desforzar `any` y system en bloques o ausente', () => {
    const blocks = base(CHAT_MODEL, {
      tool_choice: { type: 'any' },
      system: [{ type: 'text', text: 'a' }],
    });
    expect(forcedToolToAuto(blocks)).toBe(true);
    expect((blocks.system as unknown[]).length).toBe(2);
    const none: Record<string, unknown> = { tool_choice: { type: 'any' } };
    expect(forcedToolToAuto(none)).toBe(true);
    expect(typeof none.system).toBe('string');
    expect(forcedToolToAuto({ tool_choice: { type: 'auto' } })).toBe(false);
  });

  it('marca el caché en los modelos 5.5 y no cuando se pide cache:false', () => {
    const cached = base(CHAT_MODEL);
    rewriteBody(cached, { mode: 'off' });
    expect(JSON.stringify(cached.system)).toContain('cache_control');
    const once = base(FAST_MODEL);
    rewriteBody(once, { mode: 'off', cache: false });
    expect(once.system).toBe('Eres Cortex.');
  });

  it('Haiku 4.5 y desconocidos: sin thinking ni effort, conserva output_config.format', () => {
    const body = base('claude-haiku-4-5', {
      thinking: { type: 'enabled', budget_tokens: 1 },
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    rewriteBody(body, { mode: 'off' });
    expect(body).not.toHaveProperty('thinking');
    expect(body.output_config).toEqual({ format: { type: 'json_schema' } });
  });

  it('ids históricos 5 conservan su forma anterior', () => {
    const body = base('claude-sonnet-5');
    rewriteBody(body, { mode: 'off' });
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
});

describe('makeFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (obj: unknown) =>
    new Response(JSON.stringify(obj), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const init = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

  it('reintenta una vez si la herramienta desforzada no se llamó', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const responses = [
      json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'no sé' }] }),
      json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'json', input: {} }] }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, i: { body: string }) => {
        sent.push(JSON.parse(i.body));
        return responses.shift() as Response;
      }),
    );
    const events: ModelEvent[] = [];
    const f = makeFetch({ mode: 'off', observe: (e) => events.push(e) });
    const res = await f(
      'https://x',
      init(base(CHAT_MODEL, { tool_choice: { type: 'tool', name: 'json' } })),
    );
    expect(sent).toHaveLength(2);
    expect(sent.every((b) => (b.tool_choice as { type: string }).type === 'auto')).toBe(true);
    expect(events).toEqual([{ type: 'retry', reason: 'forced-tool', model: CHAT_MODEL }]);
    expect(((await res.json()) as { stop_reason: string }).stop_reason).toBe('tool_use');
  });

  it('no reintenta si la herramienta no estaba forzada', async () => {
    const spy = vi.fn(async () =>
      json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hola' }] }),
    );
    vi.stubGlobal('fetch', spy);
    await makeFetch({ mode: 'off' })('https://x', init(base(CHAT_MODEL)));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('un refusal de Haiku se reintenta en Sonnet 5.5 con su propia forma de «sin pensar»', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const responses = [
      json({ stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [] }),
      json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'json', input: {} }] }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, i: { body: string }) => {
        sent.push(JSON.parse(i.body));
        return responses.shift() as Response;
      }),
    );
    const events: ModelEvent[] = [];
    const f = makeFetch({
      mode: 'off',
      effort: 'low',
      cache: false,
      refusalFallback: CHAT_MODEL,
      observe: (e) => events.push(e),
    });
    await f('https://x', init(base(FAST_MODEL, { tool_choice: { type: 'tool', name: 'json' } })));
    expect(sent[0]?.model).toBe(FAST_MODEL);
    expect(sent[0]?.thinking).toEqual({ type: 'disabled' });
    expect(sent[0]?.tool_choice).toEqual({ type: 'tool', name: 'json' });
    expect(sent[1]?.model).toBe(CHAT_MODEL);
    expect(sent[1]?.thinking).toEqual({ type: 'between_tools' });
    expect(sent[1]?.tool_choice).toEqual({ type: 'auto' });
    expect(events.map((e) => e.type)).toEqual(['refusal', 'retry']);
    expect(events[0]).toMatchObject({ category: 'general_harms' });
  });

  it('avisa del refusal en un stream sin tocarlo', async () => {
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber"}}}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sse, { status: 200 })),
    );
    const events: ModelEvent[] = [];
    const f = makeFetch({ mode: 'off', observe: (e) => events.push(e) });
    const res = await f('https://x', init(base(FAST_MODEL, { stream: true })));
    expect(await res.text()).toBe(sse);
    expect(events).toEqual([{ type: 'refusal', model: FAST_MODEL, category: 'cyber' }]);
  });
});

describe('reasoningSignatureGuard', () => {
  it('inserta un delta vacío cuando la firma llega sin pensamiento', async () => {
    const chunks = [
      { type: 'reasoning-signature', signature: 'sig-1' },
      { type: 'reasoning', textDelta: 'pienso' },
      { type: 'reasoning-signature', signature: 'sig-2' },
      { type: 'text-delta', textDelta: 'hola' },
    ];
    const source = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });
    const wrapStream = reasoningSignatureGuard.wrapStream as NonNullable<
      typeof reasoningSignatureGuard.wrapStream
    >;
    const out = await wrapStream({
      doStream: async () => ({ stream: source, rawCall: { rawPrompt: null, rawSettings: {} } }),
      doGenerate: async () => {
        throw new Error('unused');
      },
      params: {} as never,
      model: {} as never,
    });
    const seen: unknown[] = [];
    const reader = out.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(value);
    }
    expect(seen).toEqual([
      { type: 'reasoning', textDelta: '' },
      { type: 'reasoning-signature', signature: 'sig-1' },
      { type: 'reasoning', textDelta: 'pienso' },
      { type: 'reasoning-signature', signature: 'sig-2' },
      { type: 'text-delta', textDelta: 'hola' },
    ]);
  });
});
