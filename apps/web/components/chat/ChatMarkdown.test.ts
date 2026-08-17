import type { BrainSource } from '@/lib/brain-sources-shape';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';

/**
 * SE RENDERIZA DE VERDAD, Y ÉSA ES LA GRACIA.
 *
 * `lib/citations.test.ts` prueba el partido del texto y el paseo por el árbol
 * con objetos a mano. Lo que eso NO puede comprobar es la única parte que
 * depende de una librería: que `react-markdown` encamine el `<sup>` que fabrica
 * el plugin hasta el componente de este archivo, con su `data-cite` intacto.
 * Ahí es donde una subida de versión rompería la cita en silencio — la marca
 * volvería a salir en crudo y nadie se enteraría.
 *
 * Sin navegador y sin jsdom: `renderToStaticMarkup` basta porque lo que se
 * comprueba es el HTML, no el comportamiento.
 */

const fuentes: BrainSource[] = [
  {
    documentId: 'a',
    title: 'Contrato Transportes del Valle',
    age: 'de hace 8 días',
    relevance: 'strong',
    citations: [1, 2],
  },
  { documentId: 'b', title: 'Acta de junta', relevance: 'weak', citations: [3] },
];

function render(props: Parameters<typeof ChatMarkdown>[0]): string {
  return renderToStaticMarkup(createElement(ChatMarkdown, props));
}

describe('la cita en línea', () => {
  it('deja de salir en crudo y nombra el documento', () => {
    const html = render({ content: 'Vence el 30 de septiembre[^1].', sources: fuentes });
    expect(html).not.toContain('[^1]');
    // El nombre y la edad viajan en el `title` y en el `aria-label`, no en un
    // panel flotante que tape la prosa.
    expect(html).toContain('Contrato Transportes del Valle');
    expect(html).toContain('de hace 8 días');
    // Lo que oye quien no ve la pastilla.
    expect(html).toContain(
      'aria-label="Fuente 1: Contrato Transportes del Valle · de hace 8 días"',
    );
  });

  it('va en la línea base y sin tooltip: ni superíndice que rompa el renglón ni panel que tape', () => {
    // El dueño lo dijo exacto: «aparecen feo, y solo al hover». La pastilla se
    // alinea a la base con un token de la escala, y el hover no dibuja nada.
    const html = render({ content: 'Vence el 30 de septiembre[^1].', sources: fuentes });
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain('align-super');
    expect(html).toContain('align-baseline');
    expect(html).toContain('text-micro');
  });

  it('con un destino, la marca es un botón que lleva a la fuente', () => {
    const html = render({
      content: 'Vence el 30 de septiembre[^1].',
      sources: fuentes,
      onCiteClick: () => {},
    });
    expect(html).toContain('cursor-pointer');
    expect(html).toContain('Ver en las fuentes de la respuesta');
  });

  it('sin destino no es un botón: un botón que no hace nada es peor que un número quieto', () => {
    const html = render({ content: 'Vence el 30 de septiembre[^1].', sources: fuentes });
    expect(html).not.toContain('<button');
    expect(html).not.toContain('cursor-pointer');
  });

  it('la marca apunta al documento que le toca, no al que está en su posición', () => {
    // `[^2]` es el segundo FRAGMENTO, que es del primer documento. Emparejar por
    // posición pondría aquí «Acta de junta».
    const html = render({ content: 'Dice esto[^2] y aquello[^3].', sources: fuentes });
    const primero = html.indexOf('Contrato Transportes del Valle');
    const segundo = html.indexOf('Acta de junta');
    expect(primero).toBeGreaterThan(-1);
    expect(segundo).toBeGreaterThan(primero);
  });

  it('sin procedencia no promete nada: el número apagado y ningún panel', () => {
    // Es el caso del turno en vuelo, el de una transcripción vieja y el de un
    // número que el modelo se inventó. Los tres se dibujan igual.
    const html = render({ content: 'Algo[^1] más[^9].' });
    expect(html).not.toContain('[^1]');
    expect(html).not.toContain('role="tooltip"');
    expect(html).toContain('text-ink-faint');
  });

  it('dentro de un bloque de código sigue siendo texto', () => {
    const html = render({ content: '```\ngrep "[^1]" archivo\n```', sources: fuentes });
    expect(html).toContain('[^1]');
    expect(html).not.toContain('role="tooltip"');
  });
});

describe('el texto que todavía llega', () => {
  it('lleva la máscara mientras se escribe y no cuando terminó', () => {
    expect(render({ content: 'Hola', isStreaming: true })).toContain('answer-landing');
    expect(render({ content: 'Hola' })).not.toContain('answer-landing');
  });

  it('ya no hay cursor ▋: la máscara dice lo mismo y no cae en su propio renglón', () => {
    expect(render({ content: 'Hola', isStreaming: true })).not.toContain('▋');
  });
});
