import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateJev, jevEnabled } from './jev';

const fetchMock = vi.fn();
const questions = {
  target: { type: 'choice' as const, instructions: 'Select', criteria: { a: 'A', none: 'None' } },
};
function reply(answer: unknown) {
  return new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: { target: answer },
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  );
}
beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Jev provider boundary', () => {
  it('requires a separate feature opt-in even with a key', () => {
    vi.stubEnv('JEV_WEB_SEARCH', 'off');
    expect(jevEnabled('web_search')).toBe(false);
    vi.stubEnv('JEV_WEB_SEARCH', 'on');
    expect(jevEnabled('web_search')).toBe(true);
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(jevEnabled('web_search')).toBe(false);
  });
  it('uses the official typed contract and rejects redirects', async () => {
    fetchMock.mockResolvedValue(
      reply({
        type: 'choice',
        choice: 'a',
        confidence: 0.99,
        probabilities: { a: 0.99, none: 0.01 },
      }),
    );
    expect(await evaluateJev({ label: 'Consultar' }, questions)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({
      model: 'jev-latest',
      state: { label: 'Consultar' },
      questions,
    });
  });
  it.each([
    { type: 'choice', choice: 'invented', confidence: 1, probabilities: { invented: 1 } },
    { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, none: 1 } },
    { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1 } },
    { type: 'choice', choice: 'a', confidence: 2, probabilities: { a: 1, none: 0 } },
    { type: 'noul', noul: 0.9 },
  ])('refuses malformed or out-of-contract answers %#', async (answer) => {
    fetchMock.mockResolvedValue(reply(answer));
    expect(await evaluateJev({}, questions)).toBeNull();
  });
  it('falls back on unavailable provider without retries', async () => {
    fetchMock.mockResolvedValue(new Response('internal provider detail', { status: 503 }));
    expect(await evaluateJev({}, questions)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('does not call provider on cancellation or oversized input', async () => {
    expect(await evaluateJev({}, questions, AbortSignal.abort())).toBeNull();
    expect(await evaluateJev('x'.repeat(80001), questions)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('aborts a slow provider after two seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const result = evaluateJev({}, questions);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBeNull();
  });
});
