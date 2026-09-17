import { describe, expect, it } from 'vitest';
import { validatePreparedExtraction } from './prepare';

const ready = {
  status: 'ready' as const,
  name: 'Contactos',
  headers: ['Nombre', 'Ciudad'],
  rows: [['Ana', 'Bogotá']],
  evidence: [{ rowIndex: 1, quote: 'Ana vive en Bogotá' }],
  questions: [],
};

describe('prepared Feed views', () => {
  it('keeps an exact quote and source offset for every row', () => {
    expect(validatePreparedExtraction(ready, 'Inicio. Ana vive en Bogotá.')).toEqual({
      table: {
        name: 'Contactos',
        rows: [
          ['Nombre', 'Ciudad'],
          ['Ana', 'Bogotá'],
        ],
      },
      evidence: [{ rowIndex: 1, quote: 'Ana vive en Bogotá', sourceStart: 8 }],
    });
  });

  it('rejects invented cells even when the quote itself exists', () => {
    expect(() =>
      validatePreparedExtraction({ ...ready, rows: [['Ana', 'Cali']] }, 'Ana vive en Bogotá'),
    ).toThrow('no aparece literalmente');
  });

  it('rejects citations that are not literal source substrings', () => {
    expect(() => validatePreparedExtraction(ready, 'Ana vive en Medellín')).toThrow(
      'no aparece en la fuente',
    );
  });

  it('returns a review signal when recurring headers drift', () => {
    expect(
      validatePreparedExtraction(ready, 'Ana vive en Bogotá', ['Persona', 'Ciudad']),
    ).toBeNull();
  });
});
