import { describe, expect, it } from 'vitest';
import { markToolLoopTail } from './model';

describe('el punto de caché del bucle de herramientas', () => {
  it('marca el último bloque cuando el último mensaje trae tool_result', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: '1', content: 'a' },
            { type: 'tool_result', tool_use_id: '2', content: 'b' },
          ],
        },
      ],
    };
    markToolLoopTail(body);
    const blocks = (body.messages as { content: Record<string, unknown>[] }[])[2]?.content ?? [];
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });
  it('no marca el primer paso del turno (sin resultados) ni mensajes de texto', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hola' }] };
    markToolLoopTail(body);
    expect(JSON.stringify(body)).not.toContain('cache_control');
    const blocks: Record<string, unknown> = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
    };
    markToolLoopTail(blocks);
    expect(JSON.stringify(blocks)).not.toContain('cache_control');
  });
});
