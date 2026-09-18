import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rerankWebWithJev } from './jev-rerank';
const fetchMock = vi.fn();
const results = [
  {
    title: 'General',
    url: 'https://example.com?a=private',
    content: 'General information',
    score: 0.9,
  },
  { title: 'Specific', url: 'https://official.test', content: 'The answer', score: 0.8 },
];
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.stubEnv('TYPESAFE_API_KEY', 'test');
  vi.stubEnv('JEV_WEB_SEARCH', 'on');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function response(first: number, second: number) {
  return new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: { r0: { type: 'noul', noul: first }, r1: { type: 'noul', noul: second } },
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  );
}
describe('Jev web ranking', () => {
  it('only permutes original results and preserves provider scores and URLs', async () => {
    fetchMock.mockResolvedValue(response(0.1, 0.9));
    const out = await rerankWebWithJev('question', results);
    expect(out).toEqual([results[1], results[0]]);
    expect(out[0]).toBe(results[1]);
    expect(fetchMock.mock.calls[0]?.[1].body).not.toContain('a=private');
  });
  it('retains original order for weak differentiation', async () => {
    fetchMock.mockResolvedValue(response(0.51, 0.55));
    expect(await rerankWebWithJev('question', results)).toBe(results);
  });
  it('retains results for a partial response', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: { r0: { type: 'noul', noul: 1 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ),
    );
    expect(await rerankWebWithJev('question', results)).toBe(results);
  });
  it('makes no request when disabled', async () => {
    vi.stubEnv('JEV_WEB_SEARCH', 'off');
    expect(await rerankWebWithJev('question', results)).toBe(results);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
