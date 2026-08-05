import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerTool } from '../index';
import { z } from 'zod';
import type { ToolContext } from '../types.js';

// --- Shared ctx factory (mirrors runtool.test.ts pattern) ---
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const insertResult = { data: null, error: null };
  const upsertResult = { data: null, error: null };
  const noRow = { data: null, error: null };

  const fromBuilder = {
    insert: vi.fn().mockResolvedValue(insertResult),
    upsert: vi.fn().mockResolvedValue(upsertResult),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(noRow),
        }),
        maybeSingle: vi.fn().mockResolvedValue(noRow),
        single: vi.fn().mockResolvedValue(noRow),
      }),
    }),
  };

  const db = { from: vi.fn().mockReturnValue(fromBuilder) };
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
    organizationId: 'org-test',
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

// --- Fake tool builders (register in beforeEach, overwrite real tools) ---
type ToolRegistry = Map<string, ReturnType<typeof registerTool>>;

// Capture last call args per fake tool for assertions
let lastKbSearchInput: unknown = null;
let lastHubspotGetCompanyInput: unknown = null;
let hubspotSearchCalled = false;

function registerFakeTools() {
  lastKbSearchInput = null;
  lastHubspotGetCompanyInput = null;
  hubspotSearchCalled = false;

  // KB search fake
  registerTool({
    id: 'kb.search',
    description: 'fake',
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    outputSchema: z.object({
      hits: z.array(
        z.object({
          documentId: z.string(),
          documentTitle: z.string(),
          chunkIndex: z.number(),
          content: z.string(),
          score: z.number(),
        }),
      ),
    }),
    handler: async (input: unknown) => {
      lastKbSearchInput = input;
      return {
        hits: [
          {
            documentId: '00000000-0000-0000-0000-000000000010',
            documentTitle: 'Acme Proposal 2025',
            chunkIndex: 0,
            content: 'We placed 3 senior engineers at Acme Corp.',
            score: 0.9,
          },
        ],
      };
    },
  });

  // hubspot.search_companies fake
  registerTool({
    id: 'hubspot.search_companies',
    description: 'fake',
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          name: z.string().nullable(),
          domain: z.string().nullable(),
          industry: z.string().nullable(),
          numEmployees: z.number().nullable(),
          country: z.string().nullable(),
        }),
      ),
    }),
    handler: async () => {
      hubspotSearchCalled = true;
      return {
        results: [
          {
            id: 'hs-001',
            name: 'Acme Corp',
            domain: 'acme.com',
            industry: 'Technology',
            numEmployees: 200,
            country: 'US',
          },
        ],
      };
    },
  });

  // hubspot.get_company fake
  registerTool({
    id: 'hubspot.get_company',
    description: 'fake',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({
      id: z.string(),
      name: z.string().nullable(),
      domain: z.string().nullable(),
      industry: z.string().nullable(),
      numEmployees: z.number().nullable(),
      country: z.string().nullable(),
      ownerId: z.string().nullable(),
      recentDeals: z.array(z.any()),
    }),
    handler: async (input: { id: string }) => {
      lastHubspotGetCompanyInput = input;
      return {
        id: input.id,
        name: 'Acme Corp',
        domain: 'acme.com',
        industry: 'Technology',
        numEmployees: 200,
        country: 'US',
        ownerId: null,
        recentDeals: [],
      };
    },
  });

  // hubspot.list_recent_activities fake
  registerTool({
    id: 'hubspot.list_recent_activities',
    description: 'fake',
    inputSchema: z.object({
      companyId: z.string(),
      days: z.number().optional(),
      limit: z.number().optional(),
    }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          subject: z.string().nullable(),
          body: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    handler: async () => ({
      results: [
        {
          id: 'act-1',
          type: 'email',
          subject: 'Follow-up',
          body: null,
          createdAt: '2026-05-01T00:00:00Z',
        },
      ],
    }),
  });
}

// Import the composite tool (side-effect registration happens at module load)
// We need it registered after our fakes, but the composite is registered by agent-tools index
// So we import it explicitly here:
import '../index';

describe('sales.draft_proposal composite tool', () => {
  beforeEach(() => {
    registerFakeTools();
  });


  it('calls kb.search with a derived query', async () => {
    const { getTool } = await import('../index');
    const tool = getTool('sales.draft_proposal');
    expect(tool).toBeDefined();

    const ctx = makeCtx();
    await tool!.handler(
      {
        companyId: 'hs-001',
        roles: [{ role: 'frontend', seniority: 'mid', qty: 2, techStack: [] }],
      },
      ctx,
    );

    const kbInput = lastKbSearchInput as { query: string; limit: number };
    expect(kbInput.query).toContain('frontend');
    expect(kbInput.limit).toBeGreaterThanOrEqual(1);
  });

  it('does not call hubspot.get_company when companyId is missing', async () => {
    const { getTool } = await import('../index');
    const tool = getTool('sales.draft_proposal');
    expect(tool).toBeDefined();

    const ctx = makeCtx();
    await tool!.handler(
      {
        companyName: 'Acme Corp',
        roles: [{ role: 'fullstack', seniority: 'junior', qty: 1, techStack: [] }],
      },
      ctx,
    );

    // When companyName is given without companyId, search_companies is used instead
    expect(lastHubspotGetCompanyInput).toBeNull();
    expect(hubspotSearchCalled).toBe(true);
  });

  it('output markdown leaves pricing blank and carries the citations', async () => {
    const { getTool } = await import('../index');
    const tool = getTool('sales.draft_proposal');
    expect(tool).toBeDefined();

    const ctx = makeCtx();
    const result = (await tool!.handler(
      {
        companyId: 'hs-001',
        roles: [{ role: 'backend', seniority: 'senior', qty: 1, techStack: [] }],
        notes: 'Client wants fast onboarding.',
      },
      ctx,
    )) as {
      markdown: string;
      similarCases: Array<{ title: string }>;
      roles: Array<{ role: string }>;
    };

    // The rate estimator is gone: the table says so rather than inventing a
    // number, and the caveat under it tells the reader where to get one.
    expect(result.markdown).toContain('to be priced');
    expect(result.markdown).toContain('Pricing is not filled in automatically');
    // Should include citation from KB fake
    expect(result.similarCases).toHaveLength(1);
    expect(result.similarCases[0]!.title).toBe('Acme Proposal 2025');
    expect(result.markdown).toContain('Acme Proposal 2025');
  });

});
