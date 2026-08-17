import type { BrainSource } from '@/lib/brain-sources-shape';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrainSources } from './BrainSources';

/**
 * Lo que se defiende: que la fila diga QUÉ es y CUÁNTAS son sin depender del
 * hover, y que el despliegue viva en el flujo — el panel flotante que tapaba
 * el mensaje es exactamente lo que el dueño no entendía.
 */

const fuentes: BrainSource[] = [
  {
    documentId: 'a',
    title: 'Contrato marco de prestación de servicios logísticos 2026 con anexos',
    age: 'de hace 8 días',
    relevance: 'strong',
    citations: [1, 2],
  },
  { documentId: 'b', title: 'Acta de junta', relevance: 'weak' },
];

function render(sources: readonly BrainSource[]): string {
  return renderToStaticMarkup(createElement(BrainSources, { sources }));
}

describe('la sección de fuentes', () => {
  it('colapsada cuenta las fuentes, sin depender de ningún hover', () => {
    const html = render(fuentes);
    expect(html).toContain('Del cerebro · 2 fuentes');
    expect(html).toContain('aria-expanded="false"');
  });

  it('sin fuentes no dibuja nada: la regla de procedencia del sistema de diseño', () => {
    expect(render([])).toBe('');
  });

  it('nada flota: cerrada no hay panel absoluto esperando a taparle el texto a nadie', () => {
    const html = render(fuentes);
    expect(html).not.toContain('absolute');
    expect(html).not.toContain('shadow-pop');
  });

  it('es una sección nombrada, que es lo que un lector de pantalla anuncia', () => {
    expect(render(fuentes)).toContain('aria-label="Fuentes de esta respuesta"');
  });
});
