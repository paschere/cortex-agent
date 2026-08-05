import { describe, expect, it } from 'vitest';
import { type DocumentChunk, quoteSupportsDate, verifyCandidates } from '../extract';

/**
 * The filter that stands between a model and an alarm clock.
 *
 * Everything here is about ONE failure: a date that reads as though it came out
 * of a contract when it actually came out of the model. The cases below are the
 * shapes that failure really takes — a paraphrased quote, a computed date
 * attached to a real sentence, a year with no day — not invented edge cases.
 */

const CHUNKS: DocumentChunk[] = [
  {
    id: 'chunk-1',
    chunk_index: 0,
    content:
      'CLÁUSULA CUARTA. VIGENCIA. El presente contrato de transporte estará vigente hasta el 31 de diciembre de 2026, prorrogable por acuerdo escrito entre las partes.',
  },
  {
    id: 'chunk-2',
    chunk_index: 1,
    content:
      'CLÁUSULA QUINTA. PAGOS. El CONTRATANTE pagará dentro de los primeros cinco días de cada mes. La primera factura vence el 15/03/2026 por valor de $12.500.000.',
  },
  {
    id: 'chunk-3',
    chunk_index: 2,
    content:
      'CLÁUSULA SEXTA. La póliza de cumplimiento tendrá una vigencia de doce (12) meses contados a partir del 1 de enero de 2026.',
  },
];

const TODAY = '2026-08-04';

describe('a quote has to actually contain the date', () => {
  it('accepts the date written out in Spanish', () => {
    expect(quoteSupportsDate('estará vigente hasta el 31 de diciembre de 2026', '2026-12-31')).toBe(
      true,
    );
  });

  it('accepts the numeric forms', () => {
    expect(quoteSupportsDate('La primera factura vence el 15/03/2026', '2026-03-15')).toBe(true);
    expect(quoteSupportsDate('vence 2026-03-15 sin prórroga', '2026-03-15')).toBe(true);
  });

  it('accepts "setiembre", which Colombian legal prose writes both ways', () => {
    expect(quoteSupportsDate('hasta el 30 de setiembre de 2026', '2026-09-30')).toBe(true);
  });

  it('rejects a date that is merely near the words', () => {
    // The year is there and the month name is there, but the day is not.
    expect(quoteSupportsDate('durante diciembre de 2026', '2026-12-31')).toBe(false);
    // Right day and month, wrong year — the classic off-by-one-renewal.
    expect(quoteSupportsDate('el 31 de diciembre de 2026', '2027-12-31')).toBe(false);
  });

  it('does not let a contract number vouch for a day', () => {
    // "31" appears only inside the reference number, not as a day.
    expect(quoteSupportsDate('Contrato 3145 de diciembre de 2026', '2026-12-31')).toBe(false);
  });
});

describe('verifying what the model proposed', () => {
  it('keeps a proposal whose sentence is in the document and whose date is in the sentence', () => {
    const { accepted, rejected } = verifyCandidates(
      [
        {
          title: 'Vigencia contrato de transporte',
          kind: 'contract',
          dueOn: '2026-12-31',
          quote: 'estará vigente hasta el 31 de diciembre de 2026',
        },
      ],
      CHUNKS,
      TODAY,
    );
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.chunkId).toBe('chunk-1');
  });

  it('discards a paraphrase, however close it is', () => {
    const { accepted, rejected } = verifyCandidates(
      [
        {
          title: 'Vigencia contrato',
          kind: 'contract',
          dueOn: '2026-12-31',
          // Real date, real meaning, words that are not in the document.
          quote: 'el contrato vence el 31 de diciembre de 2026',
        },
      ],
      CHUNKS,
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/no aparece textualmente/);
  });

  it('discards a CALCULATED date, which is the dangerous one', () => {
    // The sentence is real and the arithmetic is probably right: twelve months
    // from 1 January 2026 is 1 January 2027. It is still not what the document
    // says, and a date nobody wrote down must not start ringing alarms.
    const { accepted, rejected } = verifyCandidates(
      [
        {
          title: 'Póliza de cumplimiento',
          kind: 'policy',
          dueOn: '2027-01-01',
          quote: 'una vigencia de doce (12) meses contados a partir del 1 de enero de 2026',
        },
      ],
      CHUNKS,
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/calculada, no leída/);
  });

  it('survives the line breaks a PDF puts in the middle of a sentence', () => {
    const wrapped: DocumentChunk[] = [
      {
        id: 'chunk-9',
        chunk_index: 0,
        content: 'estará vigente\n   hasta el 31 de\ndiciembre de 2026, prorrogable',
      },
    ];
    const { accepted } = verifyCandidates(
      [
        {
          title: 'Vigencia',
          kind: 'contract',
          dueOn: '2026-12-31',
          quote: 'estará vigente hasta el 31 de diciembre de 2026',
        },
      ],
      wrapped,
      TODAY,
    );
    expect(accepted).toHaveLength(1);
  });

  it('discards a stub quote and an unusable date', () => {
    const { accepted, rejected } = verifyCandidates(
      [
        { title: 'Algo', kind: 'other', dueOn: '2026-12-31', quote: 'n/a' },
        { title: 'Algo', kind: 'other', dueOn: 'diciembre', quote: 'estará vigente hasta el 31' },
        {
          title: 'Página',
          kind: 'other',
          dueOn: '1998-03-15',
          quote: 'La primera factura vence el 15/03/2026',
        },
      ],
      CHUNKS,
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(3);
  });

  it('counts the same proposal twice as one', () => {
    const one = {
      title: 'Vigencia',
      kind: 'contract',
      dueOn: '2026-12-31',
      quote: 'estará vigente hasta el 31 de diciembre de 2026',
    };
    const { accepted } = verifyCandidates([one, { ...one }], CHUNKS, TODAY);
    expect(accepted).toHaveLength(1);
  });
});
