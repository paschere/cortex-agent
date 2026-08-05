import type { SupabaseClient } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../embedder';
import { searchSpaces } from '../spaces';

/**
 * Retrieval must never rank one model's vectors against another's.
 *
 * WHY THIS IS ITS OWN FILE AND ITS OWN RISK. Every other failure in this system
 * announces itself: a missing key returns a sentence, a rate limit returns a
 * status, a parse error throws. This one returns RESULTS. A query embedded with
 * voyage-4-lite and a chunk embedded with voyage-3-large are coordinates in
 * unrelated spaces, and `1 - (a <=> b)` over them is a perfectly well-formed
 * number between 0 and 1. Nothing errors. The search box keeps working, the
 * citations look real, and the answers are drawn from whichever passages happen
 * to sit near a meaningless direction. Confident nonsense is strictly worse than
 * an empty result, because an empty result is something a person can act on.
 *
 * The enforcement lives in the database (migration 0074 filters the semantic arm
 * on `kb_chunks.embedding_model`). What is asserted here is the half the
 * database cannot enforce on its own: that the application always TELLS it which
 * model produced the query vector, and never sends one without the other.
 */

const VOYAGE = 'https://api.voyageai.com/v1/embeddings';

function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed % 1024 ? 1 : 0));
}

const server = setupServer(
  http.post(VOYAGE, async ({ request }) => {
    const body = (await request.json()) as { input: string[] };
    return HttpResponse.json({
      data: body.input.map((_, index) => ({ embedding: vector(index), index })),
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface SearchArgs {
  p_query_embedding: number[] | null;
  p_embedding_model: string | null;
}

function db(): { client: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async () => ({ data: [], error: null }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const USER = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-voyage-key';
  process.env.EMBEDDING_PROVIDER = '';
  process.env.EMBEDDING_MODEL = '';
});

describe('a query vector never travels without its model', () => {
  it('names the model that produced the vector it is sending', async () => {
    const { client, rpc } = db();

    await searchSpaces(client, { userId: USER, query: 'cuál es la tarifa de React' });

    const args = rpc.mock.calls[0]?.[1] as SearchArgs;
    expect(args.p_query_embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    // Sent together, always. The database uses this to exclude every chunk
    // written by anything else.
    expect(args.p_embedding_model).toBe('voyage:voyage-4-lite');
  });

  it('follows the configured provider rather than a hardcoded name', async () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async () =>
        HttpResponse.json({ data: [{ embedding: vector(0), index: 0 }] }),
      ),
    );
    const { client, rpc } = db();

    await searchSpaces(client, { userId: USER, query: 'anything' });

    const args = rpc.mock.calls[0]?.[1] as SearchArgs;
    // If this said voyage while OpenAI produced the vector, the filter would
    // select precisely the chunks the query CANNOT be compared against.
    expect(args.p_embedding_model).toBe('openai:text-embedding-3-small');
  });

  it('sends neither the vector nor a model when the query cannot be embedded', async () => {
    process.env.VOYAGE_API_KEY = '';
    const { client, rpc } = db();
    let degraded: string | null = null;

    await searchSpaces(client, {
      userId: USER,
      query: 'la tarifa',
      onDegraded: (reason) => {
        degraded = reason;
      },
    });

    const args = rpc.mock.calls[0]?.[1] as SearchArgs;
    expect(args.p_query_embedding).toBeNull();
    // A null model is what turns the semantic arm off. Sending a model with no
    // vector, or a vector with no model, is the one combination that could make
    // the database rank across spaces — so neither half is ever sent alone.
    expect(args.p_embedding_model).toBeNull();
    // And the caller is told, because a degraded search must not look complete.
    expect(degraded).toBeTruthy();
  });

  it('still runs the keyword arm, so a model change never means silence', async () => {
    process.env.VOYAGE_API_KEY = '';
    const { client, rpc } = db();

    await searchSpaces(client, { userId: USER, query: 'la tarifa de React' });

    // The query text goes down regardless. While a corpus is being re-embedded
    // into a new model's space, every chunk is excluded from the semantic arm —
    // keyword matching is what stops that from being an outage.
    const args = rpc.mock.calls[0]?.[1] as { p_query_text: string };
    expect(args.p_query_text).toBe('la tarifa de React');
  });
});
