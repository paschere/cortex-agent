import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../../index';
import type { RetrievalObservation, ToolContext, ToolDef } from '../../types';
import type { kbSearch as KbSearchType } from '../search';

/**
 * The hinge of the whole "what did it receive" surface.
 *
 * `kb.search` drops every hit below the relevance floor before it returns —
 * correctly, because a model handed a list of near-misses reads it as evidence.
 * But those near-misses are the single most useful thing on a context page: the
 * passage that WAS there, that the chunker cut in half, whose half scored two
 * thousandths under the bar. Once the tool has returned they are gone, and a
 * second search would answer a different question with today's thresholds.
 *
 * So the tool hands the whole result set to `ctx.onRetrieval` at the last
 * moment it exists. These tests hold that contract:
 *
 *   - the observer sees rows the caller does not;
 *   - it sees the verdict and the cuts that were applied, not a re-judgement;
 *   - it cannot affect the search, however badly it behaves.
 */

const ANA = 'aaaaaaaa-0000-0000-0000-000000000001';
const SPACE = '11111111-0000-0000-0000-000000000001';

/** Three hits straddling voyage-4-lite's cuts: strong 0.46, floor 0.34. */
const ROWS = [
  { title: 'Tarifas 2026', idx: 0, vec: 0.55, text: 'La tarifa es de 8.500 al mes.' },
  { title: 'Acta de comité', idx: 3, vec: 0.4, text: 'Se habló de tarifas en general.' },
  // Below the floor. The caller must never see this; the observer must.
  { title: 'Manual de convivencia', idx: 7, vec: 0.2, text: 'No se puede fumar adentro.' },
];

function resolvingTo<T>(rows: T[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  return Object.assign(settled, {
    order: () => resolvingTo(rows),
    limit: () => resolvingTo(rows),
  });
}

function makeCtx(onRetrieval?: (o: RetrievalObservation) => void): ToolContext {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'kb_conflict_candidates') return { data: [], error: null };
    if (fn === 'kb_note_retrieval') return { data: null, error: null };
    if (fn !== 'kb_search_scoped') return { data: null, error: null };
    return {
      data: ROWS.map((r, i) => ({
        document_id: `99999999-0000-0000-0000-00000000000${i}`,
        document_title: r.title,
        space_id: SPACE,
        space_name: 'General',
        space_scope: 'global',
        chunk_index: r.idx,
        content: r.text,
        score: r.vec * 0.7,
        chunk_id: `cccccccc-0000-0000-0000-00000000000${i}`,
        vec_score: r.vec,
        fts_score: 0,
        dated_at: '2026-02-01T00:00:00Z',
        valid_until: null,
        superseded_by: null,
        superseded_by_title: null,
      })),
      error: null,
    };
  });

  const db = {
    from: vi.fn((table: string) => {
      if (table === 'kb_collections') {
        const builder = {
          select: () => builder,
          eq: () => builder,
          or: () => resolvingTo([]),
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return builder;
      }
      if (table === 'rate_limit_buckets') {
        const eq2 = { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
        const eq1 = { eq: vi.fn().mockReturnValue(eq2) };
        return {
          select: () => ({ eq: vi.fn().mockReturnValue(eq1) }),
          upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    }),
    rpc,
  };

  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };

  return {
    organizationId: 'org-test',
    userId: ANA,
    agentId: 'agent-1',
    db: db as unknown as ToolContext['db'],
    integrations: {
      getAccessToken: vi.fn(),
      hasScopes: vi.fn().mockResolvedValue(true),
    } as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    onRetrieval,
  } satisfies ToolContext;
}

type SearchTool = ToolDef<
  { query: string; limit?: number },
  { coverage: string; hits: Array<{ documentTitle: string }> }
>;

describe('kb.search hands the whole result set to the observer', () => {
  let kbSearch: typeof KbSearchType;

  beforeEach(async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_MODEL = 'voyage-4-lite';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }),
        text: async () => '',
      }),
    );
    kbSearch = (await import('../search')).kbSearch;
  });

  it('shows the observer the fragment the model was never given', async () => {
    let seen: RetrievalObservation | null = null;
    const out = await runTool(
      kbSearch as unknown as SearchTool,
      { query: '¿cuál es la tarifa de un desarrollador senior?' },
      makeCtx((o) => {
        seen = o;
      }),
    );

    const returned = out.hits.map((h) => h.documentTitle);
    expect(returned).toContain('Tarifas 2026');
    // The floor did its job: the model is not handed the irrelevant one.
    expect(returned).not.toContain('Manual de convivencia');

    const observation = seen as RetrievalObservation | null;
    expect(observation).not.toBeNull();
    const observed = observation?.hits.map((h) => h.documentTitle) ?? [];
    // …and yet it is on the record, with its score, which is the entire reason
    // this hook exists. Reconstructing it later is impossible: the tool has
    // already discarded it, and a second search would use today's thresholds.
    expect(observed).toContain('Manual de convivencia');
    expect(observation?.hits).toHaveLength(3);
  });

  it('reports the verdict and the cuts that were really applied', async () => {
    let seen: RetrievalObservation | null = null;
    await runTool(
      kbSearch as unknown as SearchTool,
      { query: '¿cuál es la tarifa de un desarrollador senior?' },
      makeCtx((o) => {
        seen = o;
      }),
    );

    const observation = seen as RetrievalObservation | null;
    const byTitle = new Map(observation?.hits.map((h) => [h.documentTitle, h]) ?? []);

    expect(byTitle.get('Tarifas 2026')?.verdict).toBe('strong');
    expect(byTitle.get('Acta de comité')?.verdict).toBe('weak');
    expect(byTitle.get('Manual de convivencia')?.verdict).toBe('dropped');

    // The scale travels with the scores. A cosine means nothing without the
    // model that produced it, and these cuts are what makes an old turn
    // readable after a recalibration.
    expect(observation?.cuts.modelId).toBe('voyage:voyage-4-lite');
    expect(observation?.cuts.strongMatch).toBe(0.46);
    expect(observation?.cuts.weakFloor).toBe(0.34);
    expect(observation?.cuts.measured).toBe(true);
    // The exact sentence the model is handed about its own results.
    expect(observation?.summary).toBeTruthy();
  });

  it('never lets a broken observer damage the search', async () => {
    const out = await runTool(
      kbSearch as unknown as SearchTool,
      { query: '¿cuál es la tarifa de un desarrollador senior?' },
      makeCtx(() => {
        throw new Error('el observador explotó');
      }),
    );

    // Diagnostics are never worth an answer. The person asked a question.
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.coverage).toBe('answered');
  });

  it('is entirely optional — a turn with no observer behaves identically', async () => {
    const withObserver = await runTool(
      kbSearch as unknown as SearchTool,
      { query: '¿cuál es la tarifa de un desarrollador senior?' },
      makeCtx(() => {}),
    );
    const without = await runTool(
      kbSearch as unknown as SearchTool,
      { query: '¿cuál es la tarifa de un desarrollador senior?' },
      makeCtx(),
    );

    expect(without.hits.map((h) => h.documentTitle)).toEqual(
      withObserver.hits.map((h) => h.documentTitle),
    );
  });
});
