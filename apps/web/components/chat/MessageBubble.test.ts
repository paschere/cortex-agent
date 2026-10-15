import type { Message } from 'ai';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from './MessageBubble';

/**
 * LA PREGUNTA ES EL TITULAR DE SU RESPUESTA, Y ESTO LO DEFIENDE.
 *
 * La burbuja azul es la convención más reconocible que hay en una pantalla de
 * chat, así que es también la que más fácil vuelve: basta con que alguien
 * «arregle» esto sin leer por qué dejó de estar. Lo que se sostiene aquí no es
 * un color, son las tres cosas que hacen que la transcripción se lea como un
 * registro y no como una mensajería — ver la cabecera de MessageBubble.
 */

function pregunta(props: Partial<Message> = {}): string {
  const message = {
    id: 'm1',
    role: 'user',
    content: '¿Cuánto nos deben?',
    ...props,
  } as Message;
  return renderToStaticMarkup(createElement(MessageBubble, { message }));
}

describe('la pregunta en la transcripción', () => {
  it('es un encabezado y no una burbuja', () => {
    const html = pregunta();
    // `h2` es lo que deja saltar de pregunta en pregunta a quien navega
    // escuchando, que es exactamente como se recorre un registro.
    expect(html).toContain('<h2');
    expect(html).toContain('¿Cuánto nos deben?');
  });

  it('no se lleva el único relleno saturado ni la única sombra del hilo', () => {
    // Lo más corto y lo menos consultable de la pantalla tenía todo el peso, y
    // la respuesta —a lo que se vino— no tenía ninguno.
    const html = pregunta();
    expect(html).not.toContain('bg-primary');
    expect(html).not.toContain('shadow-card');
  });

  it('es la burbuja del lienzo: a la derecha, con un token de la escala', () => {
    // Rediseño V3: la pregunta vuelve a ser una burbuja suave (fondo `bubble`,
    // radio 18/18/6/18) a la derecha, a un 78% como máximo. Sigue siendo un `h2`.
    const html = pregunta();
    expect(html).toContain('ml-auto');
    expect(html).toContain('max-w-[78%]');
    expect(html).toContain('text-sm');
    expect(html).not.toContain('text-lg');
  });

  it('una pregunta larga se recoge en cuatro renglones', () => {
    const larga = pregunta({ content: 'a'.repeat(400) });
    expect(larga).toContain('line-clamp-4');
    expect(larga).toContain('Ver pedido completo');
  });

  it('lleva la hora a la que se dijo, que es media parte de poder citarla', () => {
    const html = pregunta({ createdAt: new Date('2026-08-13T14:32:00Z') });
    expect(html).toContain('<time');
    expect(html).toContain('2026-08-13T14:32:00.000Z');
  });

  it('lleva la hora DEBAJO de la burbuja, discreta', () => {
    const html = pregunta({ createdAt: new Date('2026-08-13T14:32:00Z') });
    expect(html.indexOf('<time')).toBeGreaterThan(html.indexOf('<h2'));
  });

  it('no se inventa una hora cuando el mensaje no trae ninguna', () => {
    // Una transcripción que promete ser citable no puede fechar con `Date.now()`
    // una frase de hace tres semanas.
    expect(pregunta()).not.toContain('<time');
  });
});

/**
 * LA CRONOLOGÍA SOBREVIVE A LA RECARGA — el motivo de la columna `parts`
 * (migración 0110). Con parts guardadas, `segmentsOf` dibuja cada llamada en
 * su punto del timeline, exactamente como el turno en vivo; sin ellas (filas
 * de antes de la migración) cae al fallback de siempre: los pasos ANTES del
 * texto, que es el orden menos falso.
 */
describe('la respuesta reconstruida desde parts', () => {
  const respuesta = (props: Partial<Message>): string =>
    renderToStaticMarkup(
      createElement(MessageBubble, {
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'Déjame revisar la cartera.\n\nEfectivamente, te deben 42 millones.',
          ...props,
        } as Message,
      }),
    );

  it('con parts, la llamada se dibuja donde se invocó: entre los dos trozos de texto', () => {
    const html = respuesta({
      parts: [
        { type: 'text', text: 'Déjame revisar la cartera.' },
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: 'c1',
            toolName: 'foo_lookup',
            args: {},
            result: { ok: true },
          },
        },
        { type: 'text', text: 'Efectivamente, te deben 42 millones.' },
      ],
    } as Partial<Message>);
    const antes = html.indexOf('Déjame revisar la cartera.');
    const paso = html.indexOf('Foo');
    const despues = html.indexOf('Efectivamente, te deben 42 millones.');
    expect(antes).toBeGreaterThan(-1);
    expect(paso).toBeGreaterThan(antes);
    expect(despues).toBeGreaterThan(paso);
  });

  it('sin parts —una fila de antes de la migración— los pasos van antes del texto', () => {
    const html = respuesta({
      toolInvocations: [
        {
          state: 'result',
          toolCallId: 'c1',
          toolName: 'foo_lookup',
          args: {},
          result: { ok: true },
        },
      ],
    } as Partial<Message>);
    const paso = html.indexOf('Foo');
    const texto = html.indexOf('Déjame revisar la cartera.');
    expect(paso).toBeGreaterThan(-1);
    expect(texto).toBeGreaterThan(paso);
  });

  it('el razonamiento guardado en parts vuelve a su ReasoningTrail', () => {
    // El trail nace plegado, así que lo comprobable en HTML estático es que
    // EXISTE — antes de la columna `parts`, un hilo recargado no tenía
    // razonamiento en ninguna parte y esta cabecera no se dibujaba.
    const conRazonamiento = respuesta({
      parts: [
        {
          type: 'reasoning',
          reasoning: 'Primero miro la cartera del cliente.',
          details: [{ type: 'text', text: 'Primero miro la cartera del cliente.' }],
        },
        { type: 'text', text: 'Déjame revisar la cartera.' },
        {
          type: 'tool-invocation',
          toolInvocation: { state: 'call', toolCallId: 'c1', toolName: 'foo_lookup', args: {} },
        },
      ],
    } as Partial<Message>);
    expect(conRazonamiento).toContain('Razonamiento');
    expect(respuesta({})).not.toContain('Razonamiento');
  });
});
