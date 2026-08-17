import type { Message } from 'ai';
import { describe, expect, it } from 'vitest';
import { scrollIntent, turnsOf } from './MessageList';

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

/**
 * ATERRIZAR Y SEGUIR SON DOS COSAS, Y ESTO ES LO QUE IMPIDE QUE VUELVAN A SER
 * UNA.
 *
 * Estaban escritas como una sola condición —«pega al fondo si ya estás cerca
 * del fondo»— y por eso abrir un hilo guardado dejaba la vista arriba: al
 * montar, `scrollTop` es 0 y la distancia al fondo es la conversación entera.
 * Las tres respuestas se ven idénticas en una captura, así que la que falla no
 * rompe nada visible; simplemente deja a alguien leyendo el principio de una
 * conversación de hace tres semanas. Ver la cabecera de `scrollIntent`.
 */
describe('a dónde va la vista', () => {
  /** Un hilo largo recién montado: arriba del todo y con mucho por debajo. */
  const reciénAbierto = { scrollHeight: 8000, scrollTop: 0, clientHeight: 700 };

  it('aterriza al final la primera vez, aunque esté a ocho mil píxeles del fondo', () => {
    expect(scrollIntent(reciénAbierto, { landed: false })).toBe('land');
  });

  it('sin aterrizar, ya estar abajo tampoco cambia nada: sigue siendo aterrizaje', () => {
    // Un hilo de dos mensajes cabe entero en pantalla y no tiene fondo al que
    // bajar. Da igual: la primera decisión de un hilo es siempre `land`, que
    // en ese caso no mueve nada.
    expect(
      scrollIntent({ scrollHeight: 500, scrollTop: 0, clientHeight: 700 }, { landed: false }),
    ).toBe('land');
  });

  it('ya aterrizado y pegado al fondo, acompaña lo que va llegando', () => {
    expect(
      scrollIntent({ scrollHeight: 8000, scrollTop: 7300, clientHeight: 700 }, { landed: true }),
    ).toBe('follow');
  });

  it('deja quieto a quien subió a releer, por mucho token que llegue', () => {
    // Ésta es la garantía que no se puede perder arreglando la de arriba.
    expect(scrollIntent(reciénAbierto, { landed: true })).toBe('stay');
  });

  it('el margen perdona un pelo de scroll, que es lo que hace un dedo sin querer', () => {
    // 100px por debajo del fondo sigue siendo «estoy abajo»; 200px ya es haber
    // subido a propósito.
    const conHolgura = (below: number) => ({
      scrollHeight: 8000,
      scrollTop: 8000 - 700 - below,
      clientHeight: 700,
    });
    expect(scrollIntent(conHolgura(100), { landed: true })).toBe('follow');
    expect(scrollIntent(conHolgura(200), { landed: true })).toBe('stay');
  });
});
