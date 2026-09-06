import { expect, it } from 'vitest';
import { type Finding, hasExactEvidence } from './knowledge-review-shape';
it('requires literal evidence in the correct source and chunk', () => {
  const f = {
    leftChunk: 'a',
    rightChunk: 'b',
    leftQuote: 'Plazo de entrega: 3 días.',
    rightQuote: 'Plazo de entrega: 8 días.',
  } as Finding;
  const left = [{ id: 'a', content: f.leftQuote }];
  const right = [{ id: 'b', content: f.rightQuote }];
  expect(hasExactEvidence(f, left, right)).toBe(true);
  expect(hasExactEvidence({ ...f, leftQuote: 'Plazo de entrega: 2 días.' }, left, right)).toBe(
    false,
  );
  expect(hasExactEvidence(f, right, left)).toBe(false);
  expect(hasExactEvidence({ ...f, leftChunk: 'inventado' }, left, right)).toBe(false);
});
