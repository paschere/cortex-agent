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

  it('se lee por encima de la respuesta, con un token de la escala', () => {
    expect(pregunta()).toContain('text-lg');
  });

  it('baja un paso cuando deja de ser un titular', () => {
    // Un titular de cuatro renglones no titula nada. Ver HEADLINE_MAX_CHARS.
    const larga = pregunta({ content: 'a'.repeat(400) });
    expect(larga).toContain('text-base');
    expect(larga).not.toContain('text-lg');
  });

  it('lleva la hora a la que se dijo, que es media parte de poder citarla', () => {
    const html = pregunta({ createdAt: new Date('2026-08-13T14:32:00Z') });
    expect(html).toContain('<time');
    expect(html).toContain('2026-08-13T14:32:00.000Z');
  });

  it('lleva la hora ENCIMA y no al lado, que es lo que le devuelve el ancho', () => {
    // Al lado se comía ochenta píxeles de cada pregunta en un teléfono —medido
    // a 390px— y en el escritorio se quedaba sola contra el borde derecho.
    // Encima es un antetítulo, que además es como empieza la entrada de un
    // registro. Ver la cabecera de la pregunta en MessageBubble.
    const html = pregunta({ createdAt: new Date('2026-08-13T14:32:00Z') });
    expect(html.indexOf('<time')).toBeLessThan(html.indexOf('<h2'));
  });

  it('no se pasa de largo de la respuesta que titula', () => {
    // El cuerpo de la respuesta mide 64ch sangrado al carril, así que el
    // titular tiene que terminar en la misma vertical. Sin tope, una pregunta
    // larga sobresalía de su propio texto y se leía como otra columna.
    expect(pregunta()).toContain('max-w-[37rem]');
  });

  it('no se inventa una hora cuando el mensaje no trae ninguna', () => {
    // Una transcripción que promete ser citable no puede fechar con `Date.now()`
    // una frase de hace tres semanas.
    expect(pregunta()).not.toContain('<time');
  });
});
