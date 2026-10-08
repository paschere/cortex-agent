import type { CoreMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { stripEmptyMessages } from './strip-empty-messages';

describe('bloques vacíos del historial', () => {
  it('quita la respuesta guardada vacía y las partes de texto vacías', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'x', args: {} },
        ],
      },
      { role: 'user', content: 'adelante' },
    ];
    const out = stripEmptyMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'x', args: {} }],
    });
  });
});
