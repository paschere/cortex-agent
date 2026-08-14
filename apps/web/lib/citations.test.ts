import { describe, expect, it } from 'vitest';
import { type BrainSource, collectBrainSources, parseBrainSources } from './brain-sources-shape';
import { CITATION_RULE, citationSource, rehypeCitations, splitCitations } from './citations';

describe('partir el texto en marcas', () => {
  it('saca la marca y deja el resto intacto, con el punto donde estaba', () => {
    expect(splitCitations('Vence el 30 de septiembre[^2]. Y ya.')).toEqual([
      'Vence el 30 de septiembre',
      { cite: 2 },
      '. Y ya.',
    ]);
  });

  it('varias marcas seguidas en la misma frase', () => {
    expect(splitCitations('Las dos cosas[^1][^3] coinciden.')).toEqual([
      'Las dos cosas',
      { cite: 1 },
      { cite: 3 },
      ' coinciden.',
    ]);
  });

  it('un texto sin marcas vuelve entero y de una pieza', () => {
    expect(splitCitations('Nada que citar aquí.')).toEqual(['Nada que citar aquí.']);
  });

  it('no se come lo que no es una cita', () => {
    // Tres dígitos no es una marca: los fragmentos que se pegan son tres por
    // defecto y ocho como mucho, así que un número de tres cifras es otra cosa.
    expect(splitCitations('la regex [^0-9]+ y [^123]')).toEqual(['la regex [^0-9]+ y [^123]']);
  });

  it('la expresión global no arrastra su posición entre llamadas', () => {
    // El fallo clásico de un `RegExp` con `g` reutilizado: la segunda llamada
    // empieza a mitad del texto y devuelve algo distinto para la misma entrada.
    const uno = splitCitations('a[^1]b');
    const dos = splitCitations('a[^1]b');
    expect(dos).toEqual(uno);
  });
});

/** Un árbol hast mínimo, escrito a mano, para no montar el pipeline entero. */
function tree(children: unknown[]) {
  return { type: 'root', children } as never;
}

describe('el plugin sobre el árbol', () => {
  it('convierte la marca en un sup con su número', () => {
    const root = tree([
      { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'Sube[^1] algo.' }] },
    ]);
    rehypeCitations()(root);
    const p = (root as unknown as { children: { children: unknown[] }[] }).children[0];
    expect(p?.children).toEqual([
      { type: 'text', value: 'Sube' },
      {
        type: 'element',
        tagName: 'sup',
        properties: { dataCite: '1' },
        children: [{ type: 'text', value: '1' }],
      },
      { type: 'text', value: ' algo.' },
    ]);
  });

  it('deja en paz lo que está dentro de código', () => {
    const root = tree([
      {
        type: 'element',
        tagName: 'pre',
        children: [
          {
            type: 'element',
            tagName: 'code',
            children: [{ type: 'text', value: 'grep "[^1]" archivo' }],
          },
        ],
      },
    ]);
    rehypeCitations()(root);
    const code = (root as unknown as { children: { children: { children: unknown[] }[] }[] })
      .children[0]?.children[0];
    expect(code?.children).toEqual([{ type: 'text', value: 'grep "[^1]" archivo' }]);
  });
});

// ---------------------------------------------------------------------------
// LA CORRESPONDENCIA, QUE ES DE LO QUE DEPENDE TODO ESTO
// ---------------------------------------------------------------------------

const hits = [
  { documentId: 'a', documentTitle: 'Contrato Valle', age: 'de hace 8 días', relevance: 'strong' },
  { documentId: 'a', documentTitle: 'Contrato Valle', age: 'de hace 8 días', relevance: 'weak' },
  { documentId: 'b', documentTitle: 'Acta de junta', age: 'de marzo', relevance: 'strong' },
];

describe('a qué documento apunta cada marca', () => {
  it('el número es la posición del FRAGMENTO, no la de la fuente', () => {
    // Es el caso que rompe la suposición fácil: `[^2]` es el segundo fragmento,
    // que es del MISMO documento que el primero, mientras que la segunda fuente
    // de la lista es otro documento. Emparejar por posición pondría «Acta de
    // junta» donde el modelo citó el contrato.
    const sources = collectBrainSources(hits);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.citations).toEqual([1, 2]);
    expect(sources[1]?.citations).toEqual([3]);

    expect(citationSource(sources, 1)?.title).toBe('Contrato Valle');
    expect(citationSource(sources, 2)?.title).toBe('Contrato Valle');
    expect(citationSource(sources, 3)?.title).toBe('Acta de junta');
  });

  it('un fragmento que no llegó a ser fuente se lleva su número y no se lo cede a nadie', () => {
    // El fragmento 2 no tiene título, así que no es una fuente. Su número no se
    // reasigna: renumerar haría que `[^3]` apuntara al documento equivocado.
    const sources = collectBrainSources([
      { documentId: 'a', documentTitle: 'Contrato Valle', relevance: 'strong' },
      { documentId: 'x', documentTitle: '', relevance: 'strong' },
      { documentId: 'b', documentTitle: 'Acta de junta', relevance: 'strong' },
    ]);
    expect(citationSource(sources, 1)?.title).toBe('Contrato Valle');
    expect(citationSource(sources, 2)).toBeNull();
    expect(citationSource(sources, 3)?.title).toBe('Acta de junta');
  });

  it('un número que el modelo se inventó no resuelve a nada', () => {
    expect(citationSource(collectBrainSources(hits), 9)).toBeNull();
    expect(citationSource(undefined, 1)).toBeNull();
  });

  it('sobrevive al viaje por la base de datos', () => {
    const written = JSON.parse(JSON.stringify(collectBrainSources(hits))) as unknown;
    const read = parseBrainSources(written);
    expect(citationSource(read, 2)?.title).toBe('Contrato Valle');
    expect(citationSource(read, 3)?.title).toBe('Acta de junta');
  });

  it('una fila vieja, sin números guardados, no se los inventa por posición', () => {
    // Escrita antes de que `citations` existiera. Deducirlos aquí daría 1 y 2 —
    // y las marcas reales podrían haber sido 1 y 4. Una cita que apunta al
    // documento equivocado es peor que ninguna cita, así que no hay ninguna.
    const antiguas: unknown = [
      { documentId: 'a', title: 'Contrato Valle', relevance: 'strong' },
      { documentId: 'b', title: 'Acta de junta', relevance: 'strong' },
    ];
    const read = parseBrainSources(antiguas);
    expect(read).toHaveLength(2);
    expect(read.every((s: BrainSource) => s.citations === undefined)).toBe(true);
    expect(citationSource(read, 1)).toBeNull();
  });
});

describe('la regla que se le manda al modelo', () => {
  it('nombra el formato exacto que la interfaz sabe dibujar', () => {
    // Si alguien reescribe la regla y cambia la notación, esto falla aquí en vez
    // de en silencio, que es como estaba antes: numerando para nadie.
    expect(CITATION_RULE).toContain('[^2]');
    expect(splitCitations('vence el 30 de septiembre[^2].')).toHaveLength(3);
  });
});
