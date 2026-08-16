import type { Message } from 'ai';
import { describe, expect, it } from 'vitest';
import { turnsOf } from './MessageList';

/**
 * EL TURNO ES LA UNIDAD, Y ESTO ES LO QUE IMPIDE QUE VUELVA A NO SERLO.
 *
 * La maquetación de una conversación tiene que decir qué va con qué antes que
 * ninguna otra cosa. Aquí había un `space-y-6` plano entre todos los mensajes,
 * o sea: una pregunta a la misma distancia de SU respuesta que de un turno de
 * hace una hora. La agrupación es la que reparte los 14px de dentro y los 44px
 * de fuera, así que si esta función se equivoca no se rompe nada visiblemente
 * — simplemente se deshace el ritmo, en silencio, que es exactamente como se
 * perdió la primera vez.
 */

function msg(id: string, role: Message['role']): Pick<Message, 'id' | 'role'> {
  return { id, role };
}

describe('agrupar la conversación en turnos', () => {
  it('junta la pregunta con la respuesta que provocó', () => {
    const turns = turnsOf([msg('p1', 'user'), msg('r1', 'assistant')]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.at).toEqual([0, 1]);
  });

  it('abre un turno en cada pregunta', () => {
    const turns = turnsOf([
      msg('p1', 'user'),
      msg('r1', 'assistant'),
      msg('p2', 'user'),
      msg('r2', 'assistant'),
    ]);
    expect(turns.map((t) => t.at)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('deja sola a la pregunta que todavía no tiene respuesta', () => {
    // Es el turno en vuelo: `MessageList` le cuelga el indicador debajo, a los
    // mismos 14px a los que va a aparecer la respuesta.
    const turns = turnsOf([msg('p1', 'user'), msg('r1', 'assistant'), msg('p2', 'user')]);
    expect(turns[1]?.at).toEqual([2]);
  });

  it('da turno propio al saludo con el que arranca un hilo', () => {
    const turns = turnsOf([msg('hola', 'assistant'), msg('p1', 'user'), msg('r1', 'assistant')]);
    expect(turns.map((t) => t.at)).toEqual([[0], [1, 2]]);
  });

  it('da turno propio a un aviso que entra sin que nadie pregunte', () => {
    // Vigilancia de la pestaña compartida: Cortex mete un mensaje suyo detrás
    // de una respuesta ya terminada. Pegado al turno anterior se leería como
    // parte de la respuesta a OTRA pregunta, que es justo lo que no es.
    const turns = turnsOf([msg('p1', 'user'), msg('r1', 'assistant'), msg('aviso', 'assistant')]);
    expect(turns.map((t) => t.at)).toEqual([[0, 1], [2]]);
  });

  it('no pierde ni duplica ningún mensaje', () => {
    const messages = [
      msg('hola', 'assistant'),
      msg('p1', 'user'),
      msg('r1', 'assistant'),
      msg('aviso', 'assistant'),
      msg('p2', 'user'),
    ];
    const flat = turnsOf(messages).flatMap((t) => t.at);
    expect(flat).toEqual([0, 1, 2, 3, 4]);
  });

  it('no dibuja nada con la conversación vacía', () => {
    expect(turnsOf([])).toEqual([]);
  });
});
