import type { CoreMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { sanitizeHistory, stripEmptyMessages } from './strip-empty-messages';

const call = (id: string) => ({
  type: 'tool-call' as const,
  toolCallId: id,
  toolName: 'x',
  args: {},
});
const result = (id: string) => ({
  type: 'tool-result' as const,
  toolCallId: id,
  toolName: 'x',
  result: 'ok',
});

describe('historial dañado: cada caso que la API rechaza', () => {
  it('EL FALLO DE PRODUCCIÓN: una respuesta guardada vacía', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'adelante' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'user', content: 'adelante' },
    ]);
  });

  it('partes de texto vacías o de puros espacios, y el mensaje que queda sin nada', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'listo' },
        ],
      },
      { role: 'user', content: 'gracias' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'listo' }] });
  });

  it('una llamada a herramienta sin su resultado se quita (el texto se queda)', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'lee la hoja' },
      { role: 'assistant', content: [{ type: 'text', text: 'La leo.' }, call('t1')] },
      { role: 'user', content: 'sigue' },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'La leo.' }] });
  });

  it('un resultado huérfano se quita, y un par completo se respeta', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [call('t1')] },
      { role: 'tool', content: [result('t1'), result('fantasma')] },
      { role: 'tool', content: [result('t9')] },
      { role: 'user', content: 'b' },
    ];
    const out = sanitizeHistory(msgs);
    expect(out).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [call('t1')] },
      { role: 'tool', content: [result('t1')] },
      { role: 'user', content: 'b' },
    ]);
  });

  it('el hilo empieza en la persona y termina en la persona', () => {
    const out = sanitizeHistory([
      { role: 'assistant', content: 'respuesta vieja sin su pregunta' },
      { role: 'user', content: 'pregunta' },
      { role: 'assistant', content: 'cuelga' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'pregunta' }]);
  });

  it('no toca un hilo sano, y el nombre anterior sigue funcionando', () => {
    const sano: CoreMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    expect(sanitizeHistory(sano)).toEqual(sano);
    expect(stripEmptyMessages(sano)).toEqual(sano);
  });
});
