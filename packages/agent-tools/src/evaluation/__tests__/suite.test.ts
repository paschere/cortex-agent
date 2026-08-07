/**
 * The suite's own invariants. Not a measurement — a check that the thing doing
 * the measuring is still shaped like a measurement.
 *
 * These exist because a suite decays quietly. Somebody adds four questions the
 * corpus answers and none that it does not, and six months later `restraint` is
 * computed over two cases and means nothing. Somebody points a case at a
 * document that got renamed, and it fails forever for a reason nobody reads.
 * Somebody writes every question in polished Spanish and the suite goes on
 * passing while production, which receives fragments, does not.
 */

import { describe, expect, it } from 'vitest';
import { BASE_FAMILIES } from '../../tool-selection';
import { CORPUS, CORPUS_BY_ID, corpusChunks } from '../corpus';
import { ANSWER_CASES, CASES, RETRIEVAL_CASES, SELECTION_CASES, suiteDigest } from '../suite';

describe('the suite', () => {
  it('gives every case a unique id', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the three groups big enough to mean something', () => {
    const count = (g: string) => RETRIEVAL_CASES.filter((c) => c.group === g).length;
    // `restraint` is a ratio over the second and third groups together. Fewer
    // than eight and one case is worth more than twelve percentage points,
    // which is a number that moves for reasons that are not improvements.
    expect(count('answered')).toBeGreaterThanOrEqual(10);
    expect(count('absent') + count('unrelated')).toBeGreaterThanOrEqual(8);
  });

  it('points every gold reference at a document that exists', () => {
    for (const c of CASES) {
      for (const id of c.gold) {
        expect(CORPUS_BY_ID[id], `${c.id} apunta a «${id}», que no está en el corpus`).toBeTruthy();
      }
    }
  });

  it('leaves the unanswerable questions with no gold document', () => {
    // The assertion IS the emptiness. A case in the `absent` group that had
    // acquired a gold document would be silently graded as a hit and would
    // stop testing restraint at all.
    for (const c of CASES.filter((x) => x.group !== 'answered')) {
      expect(c.gold, `${c.id} no debería tener documento correcto`).toEqual([]);
    }
    for (const c of CASES.filter((x) => x.group === 'answered')) {
      expect(c.gold.length, `${c.id} necesita al menos un documento correcto`).toBeGreaterThan(0);
    }
  });

  it('asks most questions the way people really type them', () => {
    // Measured on the live API: the same passage scores 0.489 for the fragment
    // somebody types and 0.652 for the well-formed question. A suite of tidy
    // questions measures a system nobody uses.
    const terse = RETRIEVAL_CASES.filter(
      (c) => !c.query.includes('¿') && !/[A-ZÁÉÍÓÚ]/.test(c.query.charAt(0)),
    );
    expect(terse.length / RETRIEVAL_CASES.length).toBeGreaterThan(0.6);
  });

  it('makes the selection cases assert on families that have to win their way in', () => {
    // A family in BASE_FAMILIES is sent on every turn by construction, so
    // asserting on it would be asserting that a constant is itself.
    for (const c of SELECTION_CASES) {
      expect(BASE_FAMILIES, `${c.id} evalúa «${c.needsFamily}», que se manda siempre`).not.toContain(
        c.needsFamily,
      );
    }
    expect(SELECTION_CASES.length).toBeGreaterThanOrEqual(4);
  });

  it('gives every gradeable answer at least one verifiable criterion', () => {
    for (const c of ANSWER_CASES) {
      const criteria = c.answer;
      const total =
        (criteria?.contains?.length ?? 0) +
        (criteria?.absent?.length ?? 0) +
        (criteria?.rubric?.length ?? 0);
      expect(total, `${c.id} no tiene con qué calificarse`).toBeGreaterThan(0);
    }
  });

  it('never asks the judge whether an answer is good', () => {
    // The rubric is the one place a model's opinion enters this package, and
    // the guard is that it is only ever asked things with a right answer.
    const vague = /\b(buena|bien escrita|útil|clara|calidad|adecuada|apropiada)\b/i;
    for (const c of CASES) {
      for (const check of c.answer?.rubric ?? []) {
        expect(check.question, `${c.id}/${check.id} le pide una opinión al juez`).not.toMatch(vague);
      }
    }
  });

  it('explains why every case is in the suite', () => {
    for (const c of CASES) expect(c.why.length, c.id).toBeGreaterThan(40);
  });

  it('chunks into enough fragments that retrieval has to choose', () => {
    // With eight fragments and a depth of eight, every search returns
    // everything and `recall` is one by construction. The suite has to be
    // bigger than the window it is measured through.
    const chunks = corpusChunks();
    expect(chunks.length).toBeGreaterThan(15);
    expect(new Set(chunks.map((c) => c.documentId)).size).toBe(CORPUS.length);
  });

  it('produces a stable digest', () => {
    expect(suiteDigest()).toMatch(/^[0-9a-f]{16}$/);
    expect(suiteDigest()).toBe(suiteDigest());
  });
});
