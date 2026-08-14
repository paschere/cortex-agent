import { describe, expect, it } from 'vitest';
import { buildTurnMessages, dropTrailingNonUser } from './turn-messages';

/**
 * Lo que se defiende aquí es UNA SOLA FRASE: el hilo que sale hacia el modelo
 * termina en una pregunta. Cuando no terminaba, el turno moría con
 *
 *     «This model does not support assistant message prefill.
 *      The conversation must end with a user message.»
 *
 * que es un error que no le dice nada a la persona que estaba escribiendo.
 */

const user = (content: string) => ({ role: 'user', content });
const bot = (content: string) => ({ role: 'assistant', content });

/** El historial sale de la consulta de la más nueva a la más vieja. */
const newestFirst = (...rows: { role: string; content: string }[]) => [...rows].reverse();

describe('el hilo que se le manda al modelo', () => {
  it('EL FALLO DE PRODUCCIÓN: un aviso de pantalla que no está en la base', () => {
    // La vigilancia mete un mensaje de Cortex que a propósito no se guarda.
    // Después la persona escribe, y esa pregunta SÍ se guarda antes de armar
    // el hilo — así que antes se filtraba del grupo «sólo del cliente» y el
    // aviso se quedaba de último.
    const out = buildTurnMessages(
      [
        user('¿cuánto nos deben?'),
        bot('Veo un error en la pantalla que compartes.'),
        user('¿y eso qué es?'),
      ],
      newestFirst(
        user('¿cuánto nos deben?'),
        bot('Les deben 12 millones.'),
        user('¿y eso qué es?'),
      ),
    );

    expect(out[out.length - 1]?.role).toBe('user');
    expect(out[out.length - 1]?.content).toBe('¿y eso qué es?');
    // Y el aviso no se pierde: sigue estando, en su sitio.
    expect(out.some((m) => String(m.content).includes('pantalla que compartes'))).toBe(true);
  });

  it('el historial viejo va delante, y lo del navegador manda el orden', () => {
    const out = buildTurnMessages(
      [user('tercera'), bot('respuesta'), user('cuarta')],
      newestFirst(user('primera'), bot('r1'), user('tercera'), bot('respuesta'), user('cuarta')),
    );
    expect(out.map((m) => m.content)).toEqual(['primera', 'r1', 'tercera', 'respuesta', 'cuarta']);
  });

  it('una respuesta guardada con una letra distinta ya no se cuela al final', () => {
    // La comparación es por texto exacto. Antes, un carácter de diferencia entre
    // lo que se transmitió y lo que se guardó mandaba la respuesta del asistente
    // al final del hilo — el mismo error de la API, por otro camino.
    const out = buildTurnMessages(
      [user('hola'), bot('Hola.'), user('otra')],
      newestFirst(user('hola'), bot('Hola. '), user('otra')),
    );
    expect(out[out.length - 1]?.role).toBe('user');
  });

  it('sin historial en la base, el navegador es el hilo', () => {
    const out = buildTurnMessages([user('primera')], null);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  it('la misma pregunta dos veces no desaparece del hilo', () => {
    // Dedupear por `rol::contenido` contra el HISTORIAL es seguro; hacerlo al
    // revés —quitar del cliente lo que la base ya tenía— borraba la pregunta
    // repetida y dejaba el hilo terminado en la respuesta anterior.
    const out = buildTurnMessages(
      [user('hola'), bot('¿En qué te ayudo?'), user('hola')],
      newestFirst(user('hola'), bot('¿En qué te ayudo?'), user('hola')),
    );
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'hola' });
  });

  it('nunca termina en algo que no sea una pregunta', () => {
    const out = buildTurnMessages([user('pregunta'), bot('cuelga')], null);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });
});

describe('recortar lo que cuelga después de la última pregunta', () => {
  it('deja intacto lo que ya termina bien', () => {
    const msgs = [user('a'), bot('b'), user('c')] as never;
    expect(dropTrailingNonUser(msgs)).toHaveLength(3);
  });

  it('quita varios seguidos, no sólo el último', () => {
    const msgs = [user('a'), bot('b'), bot('c')] as never;
    expect(dropTrailingNonUser(msgs)).toHaveLength(1);
  });

  it('sin ninguna pregunta devuelve todo, no una lista vacía', () => {
    // Vaciarla cambiaría un error legible de la API por una petición sin
    // contenido, y de las dos maneras de fallar la que dice algo es mejor.
    const msgs = [bot('a'), bot('b')] as never;
    expect(dropTrailingNonUser(msgs)).toHaveLength(2);
  });
});
