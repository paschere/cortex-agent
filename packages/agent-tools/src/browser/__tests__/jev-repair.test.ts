import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repairWithJev } from '../jev-repair';
import type { RepairRequest } from '../repair';
import { emptySnapshot, step } from './fixtures';
const fetchMock = vi.fn();
const request: RepairRequest = {
  step: step({ label: 'Consultar', value: { kind: 'literal', text: 'private-value' } }),
  stepIndex: 0,
  context: { before: [], after: [] },
  snapshot: emptySnapshot({
    url: 'https://portal.test?token=private',
    text: 'private body',
    elements: [
      {
        ref: 'e1',
        name: 'Consultar ahora',
        role: 'button',
        tag: 'button',
        type: null,
        disabled: false,
        value: 'private field',
        targets: [{ kind: 'role', value: 'button', name: 'Consultar ahora' }],
      },
      {
        ref: 'e2',
        name: 'Eliminar',
        role: 'button',
        tag: 'button',
        type: null,
        disabled: true,
        value: null,
        targets: [{ kind: 'text', value: 'Eliminar' }],
      },
    ],
  }),
};
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.stubEnv('TYPESAFE_API_KEY', 'test');
  vi.stubEnv('JEV_BROWSER_REPAIR', 'on');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function answer(choice: string, confidence: number) {
  return new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: {
        target: {
          type: 'choice',
          choice,
          confidence,
          probabilities: {
            candidate_0: choice === 'none' ? 0 : 0.99,
            none: choice === 'none' ? 1 : 0.01,
          },
        },
      },
      usage: { input_tokens: 100, output_tokens: 5 },
    }),
  );
}
describe('Jev grounded browser repair', () => {
  it('refuses indistinguishable controls without asking the provider to guess', async () => {
    const first = request.snapshot.elements[0];
    if (!first) throw new Error('Missing fixture');
    expect(
      await repairWithJev({
        ...request,
        snapshot: { ...request.snapshot, elements: [first, { ...first, ref: 'e99' }] },
      }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('returns only locators from the actual page without sending values or the page body', async () => {
    fetchMock.mockResolvedValue(answer('candidate_0', 0.99));
    const original = structuredClone(request);
    const out = await repairWithJev(request);
    expect(out?.targets).toBe(request.snapshot.elements[0]?.targets);
    const body = fetchMock.mock.calls[0]?.[1].body;
    expect(body).not.toContain('private');
    expect(body).not.toContain('Eliminar');
    expect(request).toEqual(original);
    expect(out?.spend.costUsd).toBeCloseTo(0.0000042);
  });
  it.each([
    ['none', 1],
    ['candidate_0', 0.5],
  ] as const)('refuses %s at confidence %s', async (choice, confidence) => {
    fetchMock.mockResolvedValue(answer(choice, confidence));
    expect(await repairWithJev(request)).toBeNull();
  });
  it('keeps the old provider path when unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await repairWithJev(request)).toBeUndefined();
  });
  it('cannot choose a button for a fill step or send a secret step', async () => {
    expect(
      await repairWithJev({ ...request, step: { ...request.step, action: 'fill' } }),
    ).toBeUndefined();
    expect(
      await repairWithJev({
        ...request,
        step: { ...request.step, value: { kind: 'secret', field: 'password' } },
      }),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
