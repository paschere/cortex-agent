/**
 * The judge's guards, tested without spending anything.
 *
 * These are the mechanisms that make a model's verdict worth reading at all,
 * and every one of them fails silently: an unquoted `sí` looks exactly like a
 * quoted one in a summary, a skipped check looks like a passed one, and a judge
 * that has quietly started rubber-stamping produces the greenest report anybody
 * has ever seen. So the model is stubbed and the guards are asserted directly.
 *
 * The judge's REAL calibration — whether today's model, on today's prompt, waves
 * a deliberately wrong answer through — cannot be faked here and is not tried.
 * That runs against the live API in `live.test.ts`, inside the same run whose
 * numbers depend on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateText = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({ generateText }));

import { matchesLiteral } from '../answer';
import { JUDGE_PROBES, calibrateJudge, judgeAnswer } from '../judge';

const reply = (body: unknown) => generateText.mockResolvedValue({ text: JSON.stringify(body) });

const checks = [{ id: 'cites', question: '¿Cita el otrosí?', expect: true }];

// Braces, not a concise body: `mockReset()` returns the mock, and a `beforeEach`
// that returns a function has handed vitest a teardown — which it then calls,
// with no arguments, inside the stub that expects a prompt.
beforeEach(() => {
  generateText.mockReset();
});

describe('the evidence guard', () => {
  it('accepts a yes whose quote is really in the answer', async () => {
    reply({ checks: [{ id: 'cites', verdict: 'si', evidence: 'según el Otrosí No. 1' }] });
    const [verdict] = await judgeAnswer({
      query: 'q',
      material: 'm',
      answer: 'El valor subió, según el Otrosí No. 1 del 15 de abril.',
      checks,
    });
    expect(verdict?.verdict).toBe(true);
    expect(verdict?.fabricatedEvidence).toBe(false);
  });

  it('turns a yes with an invented quote into a no', async () => {
    // The failure being caught: a judge that agrees with a claim the answer
    // never made. Without this, the judge can flatter an answer into having
    // said something, and the score is a summary of the judge's mood.
    reply({ checks: [{ id: 'cites', verdict: 'si', evidence: 'según el Otrosí No. 1' }] });
    const [verdict] = await judgeAnswer({
      query: 'q',
      material: 'm',
      answer: 'El valor mensual es 44.900.000.',
      checks,
    });
    expect(verdict?.verdict).toBe(false);
    expect(verdict?.fabricatedEvidence).toBe(true);
  });

  it('turns a yes with no quote at all into a no', async () => {
    reply({ checks: [{ id: 'cites', verdict: 'si', evidence: null }] });
    const [verdict] = await judgeAnswer({
      query: 'q',
      material: 'm',
      answer: 'cualquier cosa',
      checks,
    });
    expect(verdict?.verdict).toBe(false);
    expect(verdict?.fabricatedEvidence).toBe(true);
  });

  it('forgives a quote that differs only in whitespace or case', async () => {
    reply({ checks: [{ id: 'cites', verdict: 'si', evidence: 'Según el otrosí No. 1' }] });
    const [verdict] = await judgeAnswer({
      query: 'q',
      material: 'm',
      answer: 'El valor subió,\n  según el Otrosí   No. 1 del 15 de abril.',
      checks,
    });
    expect(verdict?.verdict).toBe(true);
  });
});

describe('a judgement that did not arrive', () => {
  it('reads a skipped check as no, never as a pass', async () => {
    reply({ checks: [] });
    const [verdict] = await judgeAnswer({ query: 'q', material: 'm', answer: 'a', checks });
    expect(verdict?.verdict).toBe(false);
  });

  it('reads unparseable output as no', async () => {
    generateText.mockResolvedValue({ text: 'Claro, con gusto. La respuesta parece correcta.' });
    const [verdict] = await judgeAnswer({ query: 'q', material: 'm', answer: 'a', checks });
    expect(verdict?.verdict).toBe(false);
  });

  it('does not call the model when there is nothing to judge', async () => {
    expect(await judgeAnswer({ query: 'q', material: 'm', answer: 'a', checks: [] })).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('calibrating the judge', () => {
  it('has probes that fail as well as probes that pass', () => {
    // A calibration made only of correct answers measures nothing: a judge that
    // says "sí" to everything scores perfectly on it.
    const bad = JUDGE_PROBES.filter((p) => !p.expectPass);
    const good = JUDGE_PROBES.filter((p) => p.expectPass);
    expect(bad.length).toBeGreaterThanOrEqual(4);
    expect(good.length).toBeGreaterThanOrEqual(3);
  });

  it('catches a judge that waves everything through', async () => {
    // The whole point, simulated: a rubber stamp scores `trusted: false`, and
    // its leniency is exactly the fraction of bad answers it approved.
    generateText.mockImplementation(({ prompt }: { prompt: string }) => {
      const answer = prompt.split('RESPUESTA:\n')[1]?.split('\n\nCOMPROBACIONES')[0] ?? '';
      const ids = [...prompt.matchAll(/id "([^"]+)"/g)].map((m) => m[1]);
      return Promise.resolve({
        text: JSON.stringify({
          checks: ids.map((id) => ({ id, verdict: 'si', evidence: answer.slice(0, 30) })),
        }),
      });
    });
    const calibration = await calibrateJudge();
    expect(calibration.trusted).toBe(false);
    // Every probe whose rubric expects `true` gets waved through; the ones
    // expecting `false` are the only bad probes a yes-machine still fails.
    expect(calibration.leniency).toBeGreaterThan(0.5);
    expect(calibration.failures.length).toBeGreaterThan(0);
  });

  it('catches a judge that refuses everything', async () => {
    generateText.mockImplementation(({ prompt }: { prompt: string }) => {
      const ids = [...prompt.matchAll(/id "([^"]+)"/g)].map((m) => m[1]);
      return Promise.resolve({
        text: JSON.stringify({ checks: ids.map((id) => ({ id, verdict: 'no', evidence: null })) }),
      });
    });
    const calibration = await calibrateJudge();
    expect(calibration.trusted).toBe(false);
    expect(calibration.severity).toBeGreaterThan(0);
  });
});

describe('the checks code makes, which the judge never sees', () => {
  it('reads a Colombian figure however it is punctuated', () => {
    for (const written of ['COP 44.900.000', '44900000', "44'900.000", '44 900 000']) {
      expect(matchesLiteral(`El valor es ${written} más IVA.`, '44.900.000')).toBe(true);
    }
  });

  it('does not accept a rounded figure as the figure', () => {
    // "casi 45 millones" is a different claim, and a contract answer that
    // rounds is wrong. The normaliser touches separators, never digits.
    expect(matchesLiteral('El valor es de casi 45 millones.', '44.900.000')).toBe(false);
  });

  it('ignores accents, which are not a difference worth failing on', () => {
    expect(matchesLiteral('Está en el otrosi numero 1', 'Otrosí')).toBe(true);
  });
});
