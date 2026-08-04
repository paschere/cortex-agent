import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedDocuments, embedQuery } from '../embedder';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

interface VoyageRequest {
  input: string[];
  model: string;
  input_type: string;
  output_dimension: number;
  truncation?: boolean;
}

/** Every request the module actually put on the wire, in order. */
let requests: VoyageRequest[] = [];

function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed % 1024 ? 1 : 0));
}

/** The happy path: one embedding per input, echoing its position back. */
function okHandler() {
  return http.post(ENDPOINT, async ({ request }) => {
    const body = (await request.json()) as VoyageRequest;
    requests.push(body);
    return HttpResponse.json({
      object: 'list',
      data: body.input.map((_, index) => ({
        object: 'embedding',
        embedding: vector(index),
        index,
      })),
      model: body.model,
      usage: { total_tokens: 1 },
    });
  });
}

const server = setupServer(okHandler());

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers(okHandler());
  requests = [];
  vi.useRealTimers();
});
afterAll(() => server.close());

beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-voyage-key';
});

describe('what gets sent to Voyage', () => {
  it('indexes with input_type "document"', async () => {
    const result = await embedDocuments(['a passage from a rate card']);

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input_type).toBe('document');
    expect(requests[0]?.model).toBe(EMBEDDING_MODEL);
    expect(requests[0]?.output_dimension).toBe(1024);
  });

  it('retrieves with input_type "query"', async () => {
    const result = await embedQuery('what do we charge for React?');

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    // The whole reason the two sides are separate functions: Voyage places
    // queries and documents asymmetrically, and sending "document" here would
    // quietly cost recall rather than fail.
    expect(requests[0]?.input_type).toBe('query');
  });

  it('sends the API key as a bearer token', async () => {
    let auth: string | null = null;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({
          data: [{ embedding: vector(0), index: 0 }],
        });
      }),
    );

    await embedQuery('anything');
    expect(auth).toBe('Bearer test-voyage-key');
  });

  it('returns one unit vector of the column dimension per input, in order', async () => {
    const result = await embedDocuments(['one', 'two', 'three']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    for (const v of result.data) expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    // vector(n) puts its 1 at position n, so order survived the round trip.
    expect(result.data[0]?.[0]).toBe(1);
    expect(result.data[1]?.[1]).toBe(1);
    expect(result.data[2]?.[2]).toBe(1);
  });

  it('pairs vectors by the index Voyage reports, not by arrival order', async () => {
    server.use(
      http.post(ENDPOINT, async () =>
        HttpResponse.json({
          data: [
            { embedding: vector(1), index: 1 },
            { embedding: vector(0), index: 0 },
          ],
        }),
      ),
    );

    const result = await embedDocuments(['first', 'second']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.[0]).toBe(1);
    expect(result.data[1]?.[1]).toBe(1);
  });
});

describe('batching', () => {
  it('never asks Voyage for an empty embedding', async () => {
    const result = await embedDocuments([]);
    expect(result).toEqual({ ok: true, data: [] });
    expect(requests).toHaveLength(0);
  });

  it('sends a single request when the batch fits', async () => {
    await embedDocuments(Array.from({ length: 100 }, (_, i) => `chunk ${i}`));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toHaveLength(100);
  });

  it('splits on the per-request text ceiling and keeps every input', async () => {
    const texts = Array.from({ length: 300 }, (_, i) => `chunk ${i}`);
    const result = await embedDocuments(texts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(300);
    expect(requests).toHaveLength(3);
    for (const req of requests) expect(req.input.length).toBeLessThanOrEqual(128);
    // Nothing dropped and nothing duplicated across the split.
    expect(requests.flatMap((r) => r.input)).toEqual(texts);
  });

  it('splits on the token ceiling before the count ceiling', async () => {
    // Voyage caps voyage-3-large at 120K tokens per request, which a handful of
    // very long passages reaches long before 128 of them.
    const long = 'word '.repeat(50_000); // ~70K estimated tokens each
    await embedDocuments([long, long, long]);

    expect(requests.length).toBeGreaterThan(1);
    for (const req of requests) expect(req.input.length).toBeLessThan(3);
  });
});

describe('when there is no key', () => {
  it('degrades with a sentence naming the variable, without calling out', async () => {
    process.env.VOYAGE_API_KEY = '';

    const result = await embedDocuments(['anything']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.configured).toBe(false);
    expect(result.reason).toMatch(/VOYAGE_API_KEY/);
    expect(requests).toHaveLength(0);
  });

  it('degrades on the query side too, rather than throwing', async () => {
    process.env.VOYAGE_API_KEY = '';

    // The search path calls this on every turn; a raw throw here would end the
    // turn instead of falling back to keyword search.
    await expect(embedQuery('a question')).resolves.toMatchObject({
      ok: false,
      configured: false,
    });
  });
});

describe('rate limiting', () => {
  it('backs off and retries a 429, then succeeds', async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        attempts += 1;
        if (attempts < 3) return new HttpResponse('slow down', { status: 429 });
        const body = (await request.json()) as VoyageRequest;
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
        });
      }),
    );

    vi.useFakeTimers();
    const pending = embedDocuments(['a']);
    // Long enough to cover 500ms + 1000ms of exponential backoff.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(attempts).toBe(3);
    expect(result.ok).toBe(true);
  });

  it('waits, but does not retry forever', async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, async () => {
        attempts += 1;
        return new HttpResponse('slow down', { status: 429 });
      }),
    );

    vi.useFakeTimers();
    const pending = embedDocuments(['a']);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(attempts).toBe(4);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.configured).toBe(true);
    expect(result.reason).toMatch(/rate-limit/i);
  });

  it('honours Retry-After instead of guessing', async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        attempts += 1;
        if (attempts === 1) {
          return new HttpResponse('slow down', { status: 429, headers: { 'Retry-After': '5' } });
        }
        const body = (await request.json()) as VoyageRequest;
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
        });
      }),
    );

    vi.useFakeTimers();
    const pending = embedDocuments(['a']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1); // still waiting out the 5 seconds it was given

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });
});

describe('other failures', () => {
  it('does not retry a rejected key, and says what to do about it', async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, async () => {
        attempts += 1;
        return new HttpResponse('unauthorized', { status: 401 });
      }),
    );

    const result = await embedDocuments(['a']);

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Configured, but wrong — a different problem for ops than a missing key.
    expect(result.configured).toBe(true);
    expect(result.reason).toMatch(/VOYAGE_API_KEY/);
  });

  it('refuses a response it cannot line up with its input', async () => {
    server.use(
      http.post(ENDPOINT, async () =>
        HttpResponse.json({ data: [{ embedding: vector(0), index: 0 }] }),
      ),
    );

    // Two passages in, one vector back: pairing them would attach the wrong
    // text to the wrong vector for the life of the index.
    const result = await embedDocuments(['one', 'two']);
    expect(result.ok).toBe(false);
  });

  it('retries a 5xx before giving up', async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        attempts += 1;
        if (attempts === 1) return new HttpResponse('boom', { status: 503 });
        const body = (await request.json()) as VoyageRequest;
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
        });
      }),
    );

    vi.useFakeTimers();
    const pending = embedDocuments(['a']);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });
});
