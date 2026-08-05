import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDERS,
  embedDocuments,
  embedInBatches,
  embedQuery,
  embeddingConfig,
  embeddingModelId,
} from '../embedder';

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
  // Every test starts from the shipped default. The whole point of the rewrite
  // is that these are configuration, so leaving one set would leak a provider
  // from one test into the next.
  process.env.EMBEDDING_PROVIDER = '';
  process.env.EMBEDDING_MODEL = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
  process.env.COHERE_API_KEY = '';
});

describe('what gets sent to Voyage', () => {
  it('indexes with input_type "document"', async () => {
    const result = await embedDocuments(['a passage from a rate card']);

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input_type).toBe('document');
    // The default is voyage-4-lite and that is not an incidental detail: it is
    // the only model in this position that is both the cheapest verified price
    // and inside Voyage's 200M free-token grant. voyage-3-large — what this
    // deployment used to run — is in neither, and it emptied the account.
    expect(requests[0]?.model).toBe('voyage-4-lite');
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
    expect(result).toMatchObject({ ok: true, data: [] });
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
    // The per-request token ceiling is reached by a handful of very long
    // passages long before 128 of them are.
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

/* -------------------------------------------------------------------------- */
/* The failure that emptied the account                                       */
/* -------------------------------------------------------------------------- */

describe('a spent quota is not a transient failure', () => {
  it('does not retry a 402, and says the account is out of credit', async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, async () => {
        attempts += 1;
        return new HttpResponse('payment required', { status: 402 });
      }),
    );

    const result = await embedDocuments(['a']);

    // One attempt, not four. Retrying against an empty account cannot succeed,
    // and on a provider that charges for accepted requests it is money spent to
    // be told the same thing again.
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.reason).toMatch(/credit/i);
  });

  it('reads OpenAI’s quota 429 as fatal but its plain 429 as transient', async () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    let attempts = 0;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async () => {
        attempts += 1;
        return HttpResponse.json(
          { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' } },
          { status: 429 },
        );
      }),
    );

    const quota = await embedDocuments(['a']);
    expect(attempts).toBe(1);
    expect(quota.ok).toBe(false);
    if (quota.ok) return;
    expect(quota.retryable).toBe(false);

    // The same status code, without the billing marker, is a real rate limit
    // and still gets its retries. OpenAI overloads 429 for both; treating them
    // alike is how a stalled account looks like a busy one, and vice versa.
    attempts = 0;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async () => {
        attempts += 1;
        return HttpResponse.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 });
      }),
    );
    vi.useFakeTimers();
    const pending = embedDocuments(['a']);
    await vi.advanceTimersByTimeAsync(60_000);
    const limited = await pending;
    expect(attempts).toBe(4);
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.retryable).toBe(true);
  });

  it('treats a missing key as fatal rather than something to try again', async () => {
    process.env.VOYAGE_API_KEY = '';
    const result = await embedDocuments(['a']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.configured).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Resumable, not repeatable                                                  */
/* -------------------------------------------------------------------------- */

describe('embedInBatches keeps what it has already paid for', () => {
  const texts = Array.from({ length: 300 }, (_, i) => `chunk ${i}`);

  it('hands every finished batch to the caller before sending the next', async () => {
    const order: string[] = [];
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as VoyageRequest;
        order.push(`request:${body.input.length}`);
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
        });
      }),
    );

    const run = await embedInBatches(texts, async ({ start, end }) => {
      order.push(`persist:${start}-${end}`);
    });

    expect(run.failure).toBeNull();
    expect(run.embedded).toBe(300);
    // Strictly alternating. If a request ever preceded the previous batch's
    // write, a crash in between would lose vectors that were already paid for.
    expect(order).toEqual([
      'request:128',
      'persist:0-128',
      'request:128',
      'persist:128-256',
      'request:44',
      'persist:256-300',
    ]);
  });

  it('stops at the batch that failed and reports how far it got', async () => {
    let seen = 0;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seen += 1;
        if (seen === 3) return new HttpResponse('payment required', { status: 402 });
        const body = (await request.json()) as VoyageRequest;
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
        });
      }),
    );

    const persisted: number[] = [];
    const run = await embedInBatches(texts, async ({ end }) => {
      persisted.push(end);
    });

    // THE WHOLE POINT. The third request failed, and the two before it are
    // already in the caller's hands. Nothing re-embeds them; a retry of the job
    // finds only the 44 chunks that never got a vector.
    expect(persisted).toEqual([128, 256]);
    expect(run.embedded).toBe(256);
    expect(run.failure?.retryable).toBe(false);
    expect(seen).toBe(3);
  });

  it('stops spending when the caller cannot store what it bought', async () => {
    let requestsMade = 0;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        requestsMade += 1;
        const body = (await request.json()) as VoyageRequest;
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
        });
      }),
    );

    await expect(
      embedInBatches(texts, async () => {
        throw new Error('database is down');
      }),
    ).rejects.toThrow(/database is down/);

    // One request, not three. Racing ahead while the writes fail would buy
    // vectors that nothing can keep.
    expect(requestsMade).toBe(1);
  });

  it('reports what each batch cost, using the provider’s own token count', async () => {
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as VoyageRequest;
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
          usage: { total_tokens: 1_000 },
        });
      }),
    );

    const run = await embedInBatches(texts, async () => {});
    expect(run.usage.requests).toBe(3);
    expect(run.usage.tokens).toBe(3_000);
    expect(run.usage.estimated).toBe(false);
    expect(run.usage.modelId).toBe('voyage:voyage-4-lite');
  });

  it('marks the token count as an estimate when the provider does not report one', async () => {
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as VoyageRequest;
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: vector(index), index })),
        });
      }),
    );

    const run = await embedInBatches(['one passage'], async () => {});
    expect(run.usage.estimated).toBe(true);
    expect(run.usage.tokens).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The provider is configuration                                              */
/* -------------------------------------------------------------------------- */

describe('choosing a provider', () => {
  it('defaults to Voyage on voyage-4-lite when nothing is set', () => {
    const cfg = embeddingConfig();
    expect('error' in cfg).toBe(false);
    if ('error' in cfg) return;
    expect(cfg.provider.id).toBe('voyage');
    expect(cfg.model).toBe('voyage-4-lite');
    expect(embeddingModelId()).toBe('voyage:voyage-4-lite');
    // The reason it is the default, asserted so a future edit has to argue with
    // a test rather than with a comment.
    expect(cfg.facts?.freeTierTokens).toBe(200_000_000);
    expect(cfg.facts?.pricePerMillionTokensUsd).toBe(0.02);
    expect(cfg.facts?.nativeAt1024).toBe(true);
  });

  it('sends OpenAI its dimensions parameter, because 1536 would not fit the column', async () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    let body: Record<string, unknown> = {};
    let auth: string | null = null;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async ({ request }) => {
        auth = request.headers.get('authorization');
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          data: [{ embedding: vector(0), index: 0 }],
          usage: { prompt_tokens: 7 },
        });
      }),
    );

    const result = await embedDocuments(['a passage']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(auth).toBe('Bearer test-openai-key');
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(result.usage.modelId).toBe('openai:text-embedding-3-small');
    expect(result.usage.tokens).toBe(7);
  });

  it('speaks Gemini’s batch endpoint, its header auth and its taskType', async () => {
    process.env.EMBEDDING_PROVIDER = 'google';
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-google-key';

    let body: { requests?: Array<Record<string, unknown>> } = {};
    let key: string | null = null;
    server.use(
      http.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
        async ({ request }) => {
          key = request.headers.get('x-goog-api-key');
          body = (await request.json()) as typeof body;
          return HttpResponse.json({ embeddings: [{ values: vector(0) }] });
        },
      ),
    );

    const result = await embedQuery('una pregunta');
    expect(result.ok).toBe(true);
    expect(key).toBe('test-google-key');
    expect(body.requests?.[0]?.taskType).toBe('RETRIEVAL_QUERY');
    expect(body.requests?.[0]?.outputDimensionality).toBe(EMBEDDING_DIMENSIONS);
  });

  it('normalises Gemini’s reduced vectors, which Google says it will not', async () => {
    process.env.EMBEDDING_PROVIDER = 'google';
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-google-key';

    // A vector of 3s: length 3*sqrt(1024) = 96, nowhere near unit.
    const unnormalised = new Array(EMBEDDING_DIMENSIONS).fill(3);
    server.use(
      http.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
        async () => HttpResponse.json({ embeddings: [{ values: unnormalised }] }),
      ),
    );

    const result = await embedQuery('cualquier cosa');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const norm = Math.sqrt(result.data.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('reads Cohere’s v2 nesting and leaves output_dimension off the v3 models', async () => {
    process.env.EMBEDDING_PROVIDER = 'cohere';
    process.env.COHERE_API_KEY = 'test-cohere-key';

    let body: Record<string, unknown> = {};
    server.use(
      http.post('https://api.cohere.com/v2/embed', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          embeddings: { float: [vector(0)] },
          meta: { billed_units: { input_tokens: 11 } },
        });
      }),
    );

    const result = await embedDocuments(['un pasaje']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(body.input_type).toBe('search_document');
    expect(body.embedding_types).toEqual(['float']);
    // embed-multilingual-v3.0 is 1024 natively and rejects the v4-only field.
    expect(body.output_dimension).toBeUndefined();
    expect(result.usage.tokens).toBe(11);
  });

  it('honours an explicit model override', async () => {
    process.env.EMBEDDING_MODEL = 'voyage-4';
    const result = await embedDocuments(['a']);
    expect(result.ok).toBe(true);
    expect(requests[0]?.model).toBe('voyage-4');
    expect(embeddingModelId()).toBe('voyage:voyage-4');
  });

  it('refuses to embed at all when the provider name is not one we know', async () => {
    process.env.EMBEDDING_PROVIDER = 'definitely-not-a-provider';

    const result = await embedDocuments(['a']);

    // Not a silent fallback to the default. Writing vectors from a model nobody
    // chose is how a column ends up holding two incomparable spaces.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.configured).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.reason).toMatch(/EMBEDDING_PROVIDER/);
    expect(requests).toHaveLength(0);
  });

  it('knows a price and a free-token answer for every model it offers', () => {
    // The incident in one assertion: a model reached this deployment without
    // anybody being able to say what it cost or whether any of it was free.
    for (const provider of Object.values(EMBEDDING_PROVIDERS)) {
      const facts = provider.catalog[provider.defaultModel];
      expect(facts, `${provider.id} has no facts for its own default model`).toBeDefined();
      for (const [model, entry] of Object.entries(provider.catalog)) {
        expect(typeof entry.freeTierTokens, `${provider.id}:${model}`).toBe('number');
        expect(entry.note.length, `${provider.id}:${model}`).toBeGreaterThan(20);
      }
    }
  });
});
