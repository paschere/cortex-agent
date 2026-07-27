import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import { listCandidates } from './list-candidates';
import { listRequisitions } from './list-requisitions';

/**
 * These exercise the DEGRADED path on purpose: the lean
 * /api/internal/recruit/* endpoints answer 401 when no service token is
 * provisioned, and the tools must still return the lean shape (and a valid
 * output payload) by projecting the fat public endpoints client-side.
 */

const ctx = {} as ToolContext;

const UNAUTHORIZED = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

function fatJob(i: number) {
  return {
    id: `job-${i}`,
    title: `Role ${i}`,
    company: 'Zipdev',
    companyId: null,
    status: 'Active',
    candidates: 3,
    shortlisted: 1,
    rejected: 1,
    statusCounts: { SOURCED: 2, HIRED: 1 },
    // The real payload averaged ~4.4 KB of description per requisition.
    description: `<p>${'lorem ipsum dolor sit amet '.repeat(200)}</p>`,
    requirements: 'x'.repeat(250),
    requiredSkills: ['React'],
    postedDate: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    workableId: `SHORT${i}`,
    lastSynced: '2026-07-25T00:00:00.000Z',
    archived: false,
  };
}

describe('recruit.list_requisitions (fallback path)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.ZIPDEV_MATCHER_URL = 'https://matcher.test';
    delete process.env.ZIPDEV_MATCHER_TOKEN;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('caps, pages and shrinks the fat job list, and reports what it hid', async () => {
    const fat = Array.from({ length: 57 }, (_, i) => fatJob(i));
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/api/internal/')) return UNAUTHORIZED.clone();
      return new Response(JSON.stringify(fat), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await listRequisitions.handler(
      { includeArchived: false, sort: 'lastActivity', limit: 15, offset: 0 },
      ctx,
    );

    expect(listRequisitions.outputSchema.safeParse(out).success).toBe(true);
    expect(out.requisitions).toHaveLength(15);
    expect(out.meta.totalAvailable).toBe(57);
    expect(out.meta.truncated).toBe(true);

    // The whole tool payload must be a small fraction of the upstream response.
    const upstreamChars = JSON.stringify(fat).length;
    const outputChars = JSON.stringify(out).length;
    expect(upstreamChars).toBeGreaterThan(300_000);
    expect(outputChars).toBeLessThan(upstreamChars / 10);

    // No requisition carries prose.
    for (const r of out.requisitions) {
      expect(r).not.toHaveProperty('description');
      expect(r).not.toHaveProperty('requirements');
    }

    // Provenance and the client-attribution caveat both reach the model.
    expect(out.meta.dataQuality.join(' ')).toContain('no company linked');
    expect(out.markdown).toContain('showing 15 of 57');
  });

  it('pages with offset', async () => {
    const fat = Array.from({ length: 57 }, (_, i) => fatJob(i));
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/internal/')) return UNAUTHORIZED.clone();
      return new Response(JSON.stringify(fat), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await listRequisitions.handler(
      { includeArchived: false, sort: 'lastActivity', limit: 10, offset: 50 },
      ctx,
    );
    expect(out.requisitions).toHaveLength(7);
    expect(out.meta.truncated).toBe(false);
  });
});

describe('recruit.list_candidates (fallback path)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.ZIPDEV_MATCHER_URL = 'https://matcher.test';
    delete process.env.ZIPDEV_MATCHER_TOKEN;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('drops resumes and raw analysis, and warns that the pool total is unknown', async () => {
    const fat = Array.from({ length: 10 }, (_, i) => ({
      id: `cand-${i}`,
      name: `Candidate ${i}`,
      email: `c${i}@example.com`,
      status: 'APPLIED',
      matchScore: 90 - i,
      resumeText: 'x'.repeat(3_500),
      extractedData: { blob: 'y'.repeat(9_500) },
      insights: { executiveSummary: 'z'.repeat(17_000), overallMatchScore: 80 },
      llmRationale: 'w'.repeat(1_600),
    }));
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/internal/')) return UNAUTHORIZED.clone();
      return new Response(JSON.stringify(fat), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await listCandidates.handler(
      { jobId: 'job-1', includeDisqualified: false, sort: 'score', limit: 15, offset: 0 },
      ctx,
    );

    expect(listCandidates.outputSchema.safeParse(out).success).toBe(true);
    expect(out.candidates).toHaveLength(10);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(fat).length / 20);
    for (const c of out.candidates) {
      expect(c).not.toHaveProperty('resumeText');
      expect(c).not.toHaveProperty('extractedData');
    }
    expect(out.meta.dataQuality.join(' ')).toContain('NOT how many candidates the job actually has');
  });
});
