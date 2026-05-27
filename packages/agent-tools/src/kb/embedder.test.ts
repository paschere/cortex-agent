import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const FAKE_KEY = 'test-api-key-12345';
const VECTOR_DIM = 768;

function makeEmbedding(): number[] {
  return Array.from({ length: VECTOR_DIM }, () => Math.random());
}

function makeFetchMock(embeddings: number[][]): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      embeddings: embeddings.map((values) => ({ values })),
    }),
    text: async () => '',
  } as unknown as Response);
}

describe('embed', () => {
  beforeEach(() => {
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = FAKE_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  });

  it('returns empty array for empty input', async () => {
    const { embed } = await import('./embedder');
    const result = await embed([]);
    expect(result).toEqual([]);
  });

  it('returns 768-dim vectors for each input text', async () => {
    const texts = ['hello world', 'foo bar'];
    const fakeEmbeddings = texts.map(() => makeEmbedding());

    vi.stubGlobal('fetch', makeFetchMock(fakeEmbeddings));

    const { embed } = await import('./embedder');
    const result = await embed(texts);

    expect(result).toHaveLength(2);
    for (const vec of result) {
      expect(vec).toHaveLength(VECTOR_DIM);
    }
  });

  it('calls fetch once for inputs within batch size', async () => {
    const texts = ['a', 'b', 'c'];
    const fakeEmbeddings = texts.map(() => makeEmbedding());
    const mockFetch = makeFetchMock(fakeEmbeddings);

    vi.stubGlobal('fetch', mockFetch);

    const { embed } = await import('./embedder');
    await embed(texts);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('batches into multiple requests when over 100 texts', async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);

    // First batch: 100, second batch: 50
    const firstBatch = Array.from({ length: 100 }, () => makeEmbedding());
    const secondBatch = Array.from({ length: 50 }, () => makeEmbedding());

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: firstBatch.map((values) => ({ values })) }),
        text: async () => '',
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: secondBatch.map((values) => ({ values })) }),
        text: async () => '',
      } as unknown as Response);

    vi.stubGlobal('fetch', mockFetch);

    const { embed } = await import('./embedder');
    const result = await embed(texts);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(150);
  });

  it('throws when API key is missing', async () => {
    delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];

    const { embed } = await import('./embedder');
    await expect(embed(['hello'])).rejects.toThrow('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('throws when fetch returns non-ok status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as unknown as Response);

    vi.stubGlobal('fetch', mockFetch);

    const { embed } = await import('./embedder');
    await expect(embed(['hello'])).rejects.toThrow('429');
  });
});
