import { describe, expect, it, vi } from 'vitest';
import { widenExcerpts } from '../widen';

type Row = { document_id: string; chunk_index: number; content: string };

function db(rows: Row[], onQuery?: (docIds: string[], idxs: number[]) => void) {
  return {
    from: () => {
      let docIds: string[] = [];
      let idxs: number[] = [];
      const builder = {
        select: () => builder,
        in: (col: string, values: (string | number)[]) => {
          if (col === 'document_id') docIds = values as string[];
          if (col === 'chunk_index') idxs = values as number[];
          return builder;
        },
        // Un constructor de PostgREST se espera con `await`, así que el doble
        // también tiene que ser esperable.
        // biome-ignore lint/suspicious/noThenProperty: ver arriba
        then: (resolve: (v: unknown) => void) => {
          onQuery?.(docIds, idxs);
          const filtered = rows.filter(
            (r) => docIds.includes(r.document_id) && idxs.includes(r.chunk_index),
          );
          return Promise.resolve({ data: filtered, error: null }).then(resolve);
        },
      };
      return builder;
    },
    // biome-ignore lint/suspicious/noExplicitAny: doble de base de datos
  } as any;
}

const DOC = 'doc-1';

describe('widenExcerpts', () => {
  it('pega el final del anterior y el principio del siguiente', async () => {
    const rows: Row[] = [
      {
        document_id: DOC,
        chunk_index: 0,
        content: 'Cláusula quinta. Sobre el objeto del contrato.',
      },
      {
        document_id: DOC,
        chunk_index: 2,
        content: 'treinta días calendario contados desde la radicación.',
      },
    ];
    const out = await widenExcerpts(db(rows), [
      {
        documentId: DOC,
        chunkIndex: 1,
        content: 'Cláusula sexta. El plazo de pago será de',
        metadata: {},
      },
    ]);

    const widened = out.get(`${DOC}#1`);
    expect(widened).toBeDefined();
    // El número estaba en el trozo siguiente. Ése es todo el punto.
    expect(widened).toContain('treinta días');
    expect(widened).toContain('Cláusula sexta');
    // Y se ve que está recortado, para que el modelo no lo lea como el
    // principio del documento.
    expect(widened).toContain('…');
  });

  it('no toca una grabación: una cita mal atribuida es peor que una corta', async () => {
    const rows: Row[] = [
      { document_id: DOC, chunk_index: 0, content: 'Ana: buenos días a todos.' },
      { document_id: DOC, chunk_index: 2, content: 'Beto: yo lo veo distinto.' },
    ];
    const query = vi.fn();
    const out = await widenExcerpts(db(rows, query), [
      {
        documentId: DOC,
        chunkIndex: 1,
        content: 'Beto: la tarifa es de 12.000.',
        metadata: { speaker: 'Beto', startMs: 1000 },
      },
    ]);

    expect(out.size).toBe(0);
    // Ni siquiera se pregunta: si todo lo que hay es hablado, no hay consulta.
    expect(query).not.toHaveBeenCalled();
  });

  it('no repite lo que el solapamiento del troceador ya había puesto dentro', async () => {
    // El troceador solapa 50 tokens, así que el final del trozo anterior es
    // literalmente el principio de éste. Pegarlo otra vez haría que el pasaje
    // dijera la misma frase dos veces.
    const shared = 'El plazo de pago será de treinta días calendario contados desde la fecha.';
    const rows: Row[] = [
      { document_id: DOC, chunk_index: 0, content: `Cláusula quinta. ${shared}` },
    ];
    const out = await widenExcerpts(db(rows), [
      {
        documentId: DOC,
        chunkIndex: 1,
        content: `${shared} La mora se liquidará al 2% mensual.`,
        metadata: {},
      },
    ]);

    const widened = out.get(`${DOC}#1`) ?? '';
    // Lo nuevo del vecino sí entra…
    expect(widened).toContain('Cláusula quinta');
    // …y la frase compartida aparece una sola vez.
    expect(widened.split(shared)).toHaveLength(2);
  });

  it('un fallo de la consulta deja los fragmentos como estaban', async () => {
    const broken = {
      from: () => {
        const builder = {
          select: () => builder,
          in: () => builder,
          // biome-ignore lint/suspicious/noThenProperty: ver arriba.
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve({ data: null, error: { message: 'se cayó' } }).then(resolve),
        };
        return builder;
      },
      // biome-ignore lint/suspicious/noExplicitAny: doble de base de datos
    } as any;

    const out = await widenExcerpts(broken, [
      { documentId: DOC, chunkIndex: 1, content: 'algo', metadata: {} },
    ]);
    expect(out.size).toBe(0);
  });
});
