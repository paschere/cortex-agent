import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalFetch } from './client';
import {
  buildMeta,
  candidateFromLegacy,
  provenanceFooter,
  requisitionFromLegacyJob,
  shortSummary,
} from './shape';

describe('shortSummary', () => {
  it('strips HTML and collapses whitespace', () => {
    const r = shortSummary('<p>Hello&nbsp;<strong>world</strong></p><ul><li>one</li></ul>');
    expect(r.text).toBe('Hello world one');
    expect(r.truncated).toBe(false);
  });

  it('truncates on a word boundary and reports the original size', () => {
    const raw = `<p>${'alpha bravo '.repeat(60)}</p>`;
    const r = shortSummary(raw, 40);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(41); // 40 + ellipsis
    expect(r.text.endsWith('…')).toBe(true);
    expect(r.originalChars).toBe(raw.length);
  });

  it('returns empty for missing text rather than throwing', () => {
    expect(shortSummary(null).text).toBe('');
    expect(shortSummary(undefined).originalChars).toBe(0);
  });
});

describe('requisitionFromLegacyJob', () => {
  const legacy = {
    id: 'job-1',
    title: 'Senior Full-Stack Engineer',
    // /api/jobs substitutes the operating company's own name whenever the job
    // has no client linked.
    company: 'Placeholder Co',
    companyId: null,
    // /api/jobs hardcodes "Active" on every single job.
    status: 'Active',
    candidates: 12,
    shortlisted: 3,
    rejected: 2,
    statusCounts: { SOURCED: 7, HIRED: 1 },
    description: `<p>${'x'.repeat(5000)}</p>`,
    requiredSkills: ['React', 'Node'],
    postedDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    updatedAt: '2026-07-20T00:00:00.000Z',
    workableId: '7FE1AB41FC',
    lastSynced: '2026-07-25T00:00:00.000Z',
  };

  it('refuses the placeholder company when no client is linked', () => {
    const r = requisitionFromLegacyJob(legacy);
    expect(r.client).toBeNull();
    expect(r.clientAttribution).toBe('unlinked');
  });

  it('keeps the client when the job really is linked', () => {
    const r = requisitionFromLegacyJob({
      ...legacy,
      companyId: 'c1',
      company: "Linda's Chocolate",
    });
    expect(r.client).toBe("Linda's Chocolate");
    expect(r.clientAttribution).toBe('linked');
  });

  it('does not pass the hardcoded "Active" off as a pipeline status', () => {
    const r = requisitionFromLegacyJob(legacy);
    expect(r.status).toBeNull();
    expect(r.atsStatus).toBe('Active');
  });

  it('drops the full description in favour of a short summary', () => {
    const r = requisitionFromLegacyJob(legacy);
    expect(r).not.toHaveProperty('description');
    expect(String(r.summary).length).toBeLessThan(300);
    expect(r.descriptionChars).toBeGreaterThan(4000);
  });

  it('carries provenance and verifiable links', () => {
    const r = requisitionFromLegacyJob(legacy) as unknown as {
      source: Record<string, unknown>;
      links: Record<string, unknown>;
    };
    expect(r.source.origin).toBe('Workable ATS');
    expect(r.source.syncedAt).toBe('2026-07-25T00:00:00.000Z');
    // The Workable subdomain is per-customer, so the link only exists once it
    // is configured — asserting a hard-coded tenant is what tied this to one company.
    expect(r.links.workable).toBe(
      process.env.WORKABLE_SUBDOMAIN
        ? `https://${process.env.WORKABLE_SUBDOMAIN}.workable.com/backend/jobs/7FE1AB41FC`
        : null,
    );
    expect(String(r.links.matcher)).toContain('/jobs/job-1');
  });

  it('computes days open from the posted date', () => {
    expect(requisitionFromLegacyJob(legacy).daysOpen).toBe(10);
  });
});

describe('candidateFromLegacy', () => {
  it('drops resume text and raw analysis, keeping the decision fields', () => {
    const c = candidateFromLegacy(
      {
        id: 'cand-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        status: 'PRE_OFFER',
        matchScore: 99.9,
        resumeText: 'x'.repeat(30_000),
        extractedData: { huge: 'y'.repeat(30_000) },
        insights: { executiveSummary: 'Strong match.', overallMatchScore: 91 },
        testGorillaResults: [{}, {}],
      },
      'job-1',
    ) as unknown as {
      scores: Record<string, unknown>;
      signals: { testGorilla: { tests: number } };
    };

    expect(JSON.stringify(c).length).toBeLessThan(2000);
    expect(c).not.toHaveProperty('resumeText');
    expect(c).not.toHaveProperty('extractedData');
    expect(c.scores.combined).toBe(99.9);
    expect(c.scores.source).toBe('Cortex AI scoring');
    expect(c.signals.testGorilla.tests).toBe(2);
  });
});

describe('provenanceFooter', () => {
  it('states the source, the freshness, the page window and the caveats', () => {
    const meta = buildMeta({
      endpoint: '/api/jobs',
      degraded: true,
      degradedReason: 'token missing',
      totalAvailable: 57,
      returned: 15,
      offset: 0,
      truncated: true,
      dataQuality: ['Client attribution is incomplete.'],
    });
    const footer = provenanceFooter(meta);
    expect(footer).toContain('/api/jobs');
    expect(footer).toContain('showing 15 of 57');
    expect(footer).toContain('offset=15');
    expect(footer).toContain('Client attribution is incomplete.');
    // The degraded warning is prepended to dataQuality so the model sees it.
    expect(footer).toContain('legacy public endpoint');
  });
});

describe('internalFetch', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MATCHER_URL = 'https://matcher.test';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('reports unavailable on 401 so the caller can fall back', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
      }),
    ) as unknown as typeof fetch;
    const r = await internalFetch('/api/internal/recruit/requisitions');
    expect(r.available).toBe(false);
  });

  it('reports unavailable when the route is not deployed (HTML 404)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('<!DOCTYPE html><html></html>', { status: 404 }),
      ) as unknown as typeof fetch;
    const r = await internalFetch('/api/internal/recruit/requisitions');
    expect(r.available).toBe(false);
  });

  it('throws on a JSON 404 — "not found" is a real answer, not a reason to fall back', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Requisition not found' }), {
        status: 404,
      }),
    ) as unknown as typeof fetch;
    await expect(internalFetch('/api/internal/recruit/requisitions/nope')).rejects.toThrow(
      /Requisition not found/,
    );
  });

  it('returns the payload on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ requisitions: [], meta: { fetchedAt: 'now' } }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const r = await internalFetch<{ requisitions: unknown[] }>(
      '/api/internal/recruit/requisitions',
    );
    expect(r.available).toBe(true);
    if (r.available) expect(r.data.requisitions).toEqual([]);
  });
});
