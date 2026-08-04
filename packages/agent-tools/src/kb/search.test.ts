import { ValidationError } from '@cortex/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../index';
import type { ToolContext, ToolDef } from '../types';
import type { kbSearch as KbSearchType } from './search';

/**
 * These tests exist for one claim: a personal space belongs to one person and
 * nobody else's retrieval can reach it.
 *
 * That claim is enforced in two places — `kb_search_scoped` in Postgres, and
 * the helpers in spaces.ts — so the fake database below is not a stub that
 * returns canned rows. It IMPLEMENTS the visibility rule the migration
 * implements, over a fixture with two people's spaces in it, and the RPC mock
 * intersects `p_space_ids` with what `p_user_id` may see exactly as the SQL
 * does. If either side of the boundary is bypassed, these fail.
 */

// ---------------------------------------------------------------------------
// Fixture: one company space, one personal space each for Ana and Ben
// ---------------------------------------------------------------------------

const ANA = 'aaaaaaaa-0000-0000-0000-000000000001';
const BEN = 'bbbbbbbb-0000-0000-0000-000000000002';

const SPACE_GENERAL = '11111111-0000-0000-0000-000000000001';
const SPACE_ANA = '22222222-0000-0000-0000-000000000002';
const SPACE_BEN = '33333333-0000-0000-0000-000000000003';

interface SpaceRow {
  id: string;
  name: string;
  scope: 'global' | 'user';
  scope_id: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
}

const SPACES: SpaceRow[] = [
  {
    id: SPACE_GENERAL,
    name: 'General',
    scope: 'global',
    scope_id: null,
    description: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: SPACE_ANA,
    name: 'Ana notes',
    scope: 'user',
    scope_id: ANA,
    description: null,
    created_by: ANA,
    created_at: '2026-01-02T00:00:00Z',
  },
  {
    id: SPACE_BEN,
    name: 'Ben notes',
    scope: 'user',
    scope_id: BEN,
    description: null,
    created_by: BEN,
    created_at: '2026-01-03T00:00:00Z',
  },
];

interface ChunkRow {
  space: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}

const CHUNKS: ChunkRow[] = [
  {
    space: SPACE_GENERAL,
    documentId: '99999999-0000-0000-0000-00000000000a',
    documentTitle: 'Rate card',
    chunkIndex: 0,
    content: 'Senior React developers are quoted at 8,500 USD per month.',
    score: 0.9,
  },
  {
    space: SPACE_ANA,
    documentId: '99999999-0000-0000-0000-00000000000b',
    documentTitle: "Ana's private salary notes",
    chunkIndex: 0,
    content: 'Ana thinks we could push the React rate to 9,200 for this client.',
    score: 0.95,
  },
  {
    space: SPACE_BEN,
    documentId: '99999999-0000-0000-0000-00000000000c',
    documentTitle: "Ben's private client notes",
    chunkIndex: 0,
    content: 'Ben promised this client a React discount he has not told anyone about.',
    score: 0.99,
  },
];

/** The rule, once: every global space plus the caller's own personal ones. */
function visibleSpaceIds(userId: string | null): string[] {
  if (!userId) return [];
  return SPACES.filter((s) => s.scope === 'global' || s.scope_id === userId).map((s) => s.id);
}

// ---------------------------------------------------------------------------
// A db double that enforces the rule the way Postgres does
// ---------------------------------------------------------------------------

interface ScopedSearchArgs {
  p_user_id: string | null;
  p_query_text: string;
  p_limit: number;
  p_space_ids: string[] | null;
}

/**
 * A chainable stand-in for a PostgREST query that is a real Promise, so the
 * `.order(...).order(...)` chain resolves the same way supabase-js does.
 */
function resolvingTo<T>(rows: T[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  return Object.assign(settled, {
    order: () => resolvingTo(rows),
    limit: () => resolvingTo(rows),
  });
}

function makeCtx(userId: string) {
  const rpc = vi.fn(async (fn: string, args: ScopedSearchArgs) => {
    if (fn !== 'kb_search_scoped') return { data: null, error: null };

    // Mirrors kb_search_scoped: the visible set is derived from p_user_id, and
    // p_space_ids can only narrow it.
    const visible = visibleSpaceIds(args.p_user_id);
    const requested = args.p_space_ids;
    const targets = requested ? visible.filter((id) => requested.includes(id)) : visible;

    const rows = CHUNKS.filter((c) => targets.includes(c.space))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.p_limit ?? 8)
      .flatMap((c) => {
        const space = SPACES.find((s) => s.id === c.space);
        if (!space) return [];
        return [
          {
            document_id: c.documentId,
            document_title: c.documentTitle,
            space_id: space.id,
            space_name: space.name,
            space_scope: space.scope,
            chunk_index: c.chunkIndex,
            content: c.content,
            score: c.score,
          },
        ];
      });
    return { data: rows, error: null };
  });

  const spacesQuery = (orFilter?: string) => {
    // listVisibleSpaces builds `scope.eq.global,and(scope.eq.user,scope_id.eq.X)`
    const owner = orFilter?.match(/scope_id\.eq\.([0-9a-f-]+)/i)?.[1] ?? null;
    return SPACES.filter((s) => s.scope === 'global' || s.scope_id === owner);
  };

  const db = {
    from: vi.fn((table: string) => {
      if (table === 'kb_collections') {
        let byId: string | undefined;
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => {
            if (col === 'id') byId = val;
            return builder;
          },
          or: (f: string) => resolvingTo(spacesQuery(f)),
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({
            data: SPACES.find((s) => s.id === byId) ?? null,
            error: null,
          }),
        };
        return builder;
      }
      if (table === 'audit_events') {
        return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }
      if (table === 'rate_limit_buckets') {
        const eq2 = { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
        const eq1 = { eq: vi.fn().mockReturnValue(eq2) };
        return {
          select: () => ({ eq: vi.fn().mockReturnValue(eq1) }),
          upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return {
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      };
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
    userId,
    agentId: 'agent-1',
    db: db as unknown as ToolContext['db'],
    integrations: {
      getAccessToken: vi.fn(),
      hasScopes: vi.fn().mockResolvedValue(true),
    } as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
  } satisfies ToolContext;
}

type SearchTool = ToolDef<
  { query: string; space?: string; limit?: number },
  {
    hits: Array<{
      documentId: string;
      documentTitle: string;
      space: string;
      spaceKind: 'global' | 'personal';
      chunkIndex: number;
      content: string;
      score: number;
    }>;
  }
>;

/** A Voyage response shaped like the real one; the values themselves never matter here. */
function stubEmbedding() {
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
}

// ---------------------------------------------------------------------------

describe('kb.search space scoping', () => {
  let kbSearch: typeof KbSearchType;

  beforeEach(async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    stubEmbedding();
    kbSearch = (await import('./search')).kbSearch;
  });

  it("never returns another person's personal space", async () => {
    const ana = await runTool(
      kbSearch as unknown as SearchTool,
      { query: 'React rate' },
      makeCtx(ANA),
    );

    const titles = ana.hits.map((h) => h.documentTitle);
    expect(titles).toContain('Rate card');
    expect(titles).toContain("Ana's private salary notes");
    // The whole point.
    expect(titles).not.toContain("Ben's private client notes");
    expect(ana.hits.every((h) => h.space !== 'Ben notes')).toBe(true);

    const ben = await runTool(
      kbSearch as unknown as SearchTool,
      { query: 'React rate' },
      makeCtx(BEN),
    );
    const benTitles = ben.hits.map((h) => h.documentTitle);
    expect(benTitles).toContain("Ben's private client notes");
    expect(benTitles).not.toContain("Ana's private salary notes");
  });

  it("cannot be aimed at another person's space by name", async () => {
    // Ben's space exists, but it is not among the names Ana can resolve, so the
    // narrowing filter can never be pointed at it.
    await expect(
      runTool(
        kbSearch as unknown as SearchTool,
        { query: 'discount', space: 'Ben notes' },
        makeCtx(ANA),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('hands the database the user, never a caller-chosen list of spaces', async () => {
    const ctx = makeCtx(ANA);
    await runTool(kbSearch as unknown as SearchTool, { query: 'rates' }, ctx);

    const rpc = (ctx.db as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;
    const call = rpc.mock.calls.find((c) => c[0] === 'kb_search_scoped');
    expect(call).toBeDefined();
    expect((call?.[1] as ScopedSearchArgs | undefined)?.p_user_id).toBe(ANA);
    // Unscoped search no longer exists — nothing may reach for it.
    expect(rpc.mock.calls.some((c) => c[0] === 'kb_hybrid_search')).toBe(false);
  });

  it('narrows to one space when asked, and only within what is visible', async () => {
    const res = await runTool(
      kbSearch as unknown as SearchTool,
      { query: 'rate', space: 'General' },
      makeCtx(ANA),
    );
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.space).toBe('General');
    expect(res.hits[0]?.spaceKind).toBe('global');
  });

  it('empty query → ValidationError', async () => {
    await expect(runTool(kbSearch, { query: '' }, makeCtx(ANA))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('searchSpaces boundary', () => {
  it('returns nothing when the caller has no user id, rather than everything', async () => {
    const { searchSpaces } = await import('./spaces');
    const ctx = makeCtx(ANA);
    const hits = await searchSpaces(ctx.db, { userId: '', query: 'rate' });
    expect(hits).toEqual([]);
    // It must fail closed before it ever reaches the database.
    const rpc = (ctx.db as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpc).not.toHaveBeenCalled();
  });

  it('drops space ids the caller cannot see instead of honouring them', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    stubEmbedding();
    const { searchSpaces } = await import('./spaces');

    // Ana asks, explicitly, for Ben's space id — the shape of the old
    // `collection_ids` bypass. The intersection makes it yield nothing.
    const hits = await searchSpaces(makeCtx(ANA).db, {
      userId: ANA,
      query: 'discount',
      spaceIds: [SPACE_BEN],
    });
    expect(hits).toEqual([]);
  });

  it('an explicitly empty space list means nothing, not everything', async () => {
    const { searchSpaces } = await import('./spaces');
    const hits = await searchSpaces(makeCtx(ANA).db, {
      userId: ANA,
      query: 'rate',
      spaceIds: [],
    });
    expect(hits).toEqual([]);
  });
});

describe('getVisibleSpace / getVisibleDocument', () => {
  it("reports another person's space as missing, not as forbidden", async () => {
    const { getVisibleSpace } = await import('./spaces');
    // Indistinguishable from a bad id on purpose: a "forbidden" would confirm
    // that Ben has a space with that id.
    await expect(getVisibleSpace(makeCtx(ANA).db, ANA, SPACE_BEN)).rejects.toThrow(
      /no longer exists/i,
    );
    await expect(getVisibleSpace(makeCtx(ANA).db, ANA, SPACE_GENERAL)).resolves.toMatchObject({
      name: 'General',
      kind: 'global',
    });
  });
});
