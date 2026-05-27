import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '@zipdev/core';
import { runTool } from '../index';
import type { ToolContext, ToolDef } from '../types';
import type { kbSearch as KbSearchType } from './search';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmbedding(): number[] {
  return Array.from({ length: 768 }, () => 0.1);
}

type CollectionStub = { id: string; scope_id?: string };
type RpcRow = {
  document_id: string;
  document_title: string;
  chunk_index: number;
  content: string;
  score: number;
};

/** Build a minimal ToolContext whose db is table-aware. */
function makeCtx(overrides: {
  teamMembers?: Array<{ team_id: string }>;
  collections?: Record<string, CollectionStub[]>;
  rpcRows?: RpcRow[];
} = {}): ToolContext {
  const { teamMembers = [], collections = {}, rpcRows = [] } = overrides;

  // Audit insert stub
  const auditInsert = vi.fn().mockResolvedValue({ data: null, error: null });

  // Rate-limit: select chain → maybeSingle returns null (no existing bucket → full tokens)
  const rateLimitMaybySingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const rateLimitEq2 = { maybeSingle: rateLimitMaybySingle };
  const rateLimitEq1 = { eq: vi.fn().mockReturnValue(rateLimitEq2) };
  const rateLimitSelect = { eq: vi.fn().mockReturnValue(rateLimitEq1) };
  const rateLimitUpsert = vi.fn().mockResolvedValue({ data: null, error: null });

  /**
   * Builds a chainable promise-like builder for kb_collections queries.
   * Supports: .select(fields).eq(col, val).eq(col, val) | .in(col, vals)
   * and resolves to { data, error }.
   */
  interface CollectionsBuilder {
    eq(col: string, val: string): CollectionsBuilder;
    in(col: string, vals: string[]): CollectionsBuilder;
    then(resolve: (v: { data: unknown[]; error: null }) => void): void;
  }

  function makeCollectionsBuilder(): { select: (fields: string) => CollectionsBuilder } {
    return {
      select: (fields: string) => {
        const isFullDetail = fields.includes('kb_documents');
        let _scope: string | undefined;
        let _scopeId: string | undefined;
        let _inScopeIds: string[] | undefined;
        let _inIds: string[] | undefined;

        const builder: CollectionsBuilder = {
          eq(col: string, val: string): CollectionsBuilder {
            if (col === 'scope') _scope = val;
            else if (col === 'scope_id') _scopeId = val;
            return builder;
          },
          in(col: string, vals: string[]): CollectionsBuilder {
            if (col === 'scope_id') _inScopeIds = vals;
            else if (col === 'id') _inIds = vals;
            return builder;
          },
          then(resolve: (v: { data: unknown[]; error: null }) => void): void {
            let rows: unknown[];
            if (isFullDetail) {
              const allCols = [
                { id: 'col-1', scope: 'global', name: 'Global KB', scope_id: null, kb_documents: [{ count: 3 }] },
                { id: 'col-2', scope: 'user', name: 'My KB', scope_id: 'user-1', kb_documents: [{ count: 1 }] },
              ];
              rows = _inIds ? allCols.filter((c) => _inIds!.includes(c.id)) : allCols;
            } else {
              const scopeRows: CollectionStub[] = collections[_scope ?? ''] ?? [];
              rows = scopeRows
                .filter((c) => {
                  if (_scopeId !== undefined && c.scope_id !== _scopeId) return false;
                  if (_inScopeIds !== undefined) {
                    if (c.scope_id === undefined || !_inScopeIds.includes(c.scope_id)) return false;
                  }
                  return true;
                })
                .map((c) => ({ id: c.id }));
            }
            resolve({ data: rows, error: null });
          },
        };
        return builder;
      },
    };
  }

  function makeTeamMembersBuilder(): { select: (fields: string) => unknown } {
    return {
      select: (_fields: string) => {
        const builder = {
          eq: (_col: string, _val: string) => builder,
          then: (resolve: (v: { data: Array<{ team_id: string }>; error: null }) => void) => {
            resolve({ data: teamMembers, error: null });
          },
        };
        return builder;
      },
    };
  }

  const rpcMock = vi.fn().mockResolvedValue({ data: rpcRows, error: null });

  const db = {
    from: vi.fn((table: string) => {
      if (table === 'kb_collections') return makeCollectionsBuilder();
      if (table === 'team_members') return makeTeamMembersBuilder();
      if (table === 'audit_events') return { insert: auditInsert };
      if (table === 'rate_limit_buckets') return { select: () => rateLimitSelect, upsert: rateLimitUpsert };
      // Fallback
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
    rpc: rpcMock,
  };

  const integrations = {
    getAccessToken: vi.fn(),
    hasScopes: vi.fn().mockResolvedValue(true),
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
    userId: 'user-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kb.search', () => {
  // Use the type from the named export so TypeScript knows the shape
  let kbSearch: typeof KbSearchType;

  beforeEach(async () => {
    const mod = await import('./search');
    kbSearch = mod.kbSearch;
  });

  it('happy path: returns hits sorted by score from RPC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [{ values: makeEmbedding() }] }),
        text: async () => '',
      }),
    );

    const rpcRows: RpcRow[] = [
      {
        document_id: '00000000-0000-0000-0000-000000000011',
        document_title: 'Sales Playbook',
        chunk_index: 0,
        content: 'Our sales process starts with discovery.',
        score: 0.92,
      },
      {
        document_id: '00000000-0000-0000-0000-000000000022',
        document_title: 'Pricing Guide',
        chunk_index: 1,
        content: 'Enterprise pricing tiers are negotiable.',
        score: 0.75,
      },
    ];

    const ctx = makeCtx({
      collections: {
        global: [{ id: 'col-1' }],
        team: [],
        user: [{ id: 'col-2', scope_id: 'user-1' }],
        conversation: [],
      },
      rpcRows,
    });

    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'test-key';

    // runTool is generic — cast the tool so TypeScript infers the output type
    type SearchTool = ToolDef<
      { query: string; scopes?: ('global' | 'team' | 'user' | 'conversation')[]; teamId?: string; conversationId?: string; limit?: number },
      { hits: Array<{ documentId: string; documentTitle: string; chunkIndex: number; content: string; score: number }> }
    >;
    const result = await runTool(kbSearch as unknown as SearchTool, { query: 'sales process' }, ctx);

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
    expect(result.hits[0]!.documentTitle).toBe('Sales Playbook');
    expect(result.hits[1]!.documentTitle).toBe('Pricing Guide');

    vi.unstubAllGlobals();
    delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  });

  it('empty query → ValidationError', async () => {
    const ctx = makeCtx();
    await expect(runTool(kbSearch, { query: '' }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it('no collections visible → empty hits (no RPC call)', async () => {
    const ctx = makeCtx({
      teamMembers: [],
      collections: {
        global: [],
        team: [],
        user: [],
        conversation: [],
      },
      rpcRows: [],
    });

    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'test-key';

    type SearchTool = ToolDef<
      { query: string; scopes?: ('global' | 'team' | 'user' | 'conversation')[]; teamId?: string; conversationId?: string; limit?: number },
      { hits: Array<{ documentId: string; documentTitle: string; chunkIndex: number; content: string; score: number }> }
    >;
    const result = await runTool(kbSearch as unknown as SearchTool, { query: 'anything' }, ctx);
    expect(result.hits).toEqual([]);

    // RPC should not have been called since no collections were found
    const dbMock = ctx.db as unknown as { rpc: ReturnType<typeof vi.fn> };
    expect(dbMock.rpc).not.toHaveBeenCalled();

    delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  });
});
