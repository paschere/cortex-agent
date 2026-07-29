import { generateObject } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import { workableCompareCandidates } from './compare-candidates';

vi.mock('ai', () => ({ generateObject: vi.fn() }));
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mock-model') }));

const generateObjectMock = vi.mocked(generateObject);

const ctx = {} as ToolContext;

const JOB = {
  shortcode: 'REACT1',
  title: 'Senior React Developer',
  state: 'published',
  requirements: '<p>We need React, Node.js, TypeScript and AWS.</p>',
  full_description: '<p>Build web apps with React and Node.js on AWS.</p>',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function candidateDetail(id: string, extra: Record<string, any> = {}) {
  return {
    candidate: {
      id,
      name: `Cand ${id}`,
      email: `${id}@test.com`,
      headline: 'Software Developer',
      stage: 'Applied',
      skills: [],
      tags: [],
      experience_entries: [],
      answers: [],
      ...extra,
    },
  };
}

const TG_RESULTS = {
  results: {
    'maria@test.com': {
      tests: 2,
      completed: 2,
      avgScore: 81.5,
      results: [
        { testName: 'React', score: 88, completed: true },
        { testName: 'Node.js', score: 75, completed: true },
      ],
      lastUpdatedAt: '2026-07-10T00:00:00Z',
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockWorkable(details: Record<string, any>) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('/api/internal/recruit/testgorilla')) {
      return new Response(JSON.stringify(TG_RESULTS), { status: 200 });
    }
    if (href.includes('/jobs/REACT1')) {
      return new Response(JSON.stringify(JOB), { status: 200 });
    }
    const id = /\/candidates\/([^/?]+)$/.exec(href)?.[1];
    if (id && details[id]) {
      return new Response(JSON.stringify(details[id]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

const DETAILS = {
  maria: candidateDetail('maria', {
    headline: 'Senior React Developer',
    skills: ['React', 'Node.js', 'AWS'],
    stage: 'Technical Interview',
    experience_entries: [
      { title: 'React Developer', company: 'Acme', start_date: '2017-01-01', current: true },
    ],
  }),
  juan: candidateDetail('juan', {
    headline: 'Backend Developer',
    skills: ['Node.js', 'PostgreSQL'],
    experience_entries: [
      { title: 'Backend Developer', company: 'Beta', start_date: '2012-01-01', current: true },
    ],
  }),
};

describe('workable.compare_candidates', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.WORKABLE_API_TOKEN = 'test-token';
    process.env.WORKABLE_SUBDOMAIN = 'zipdev';
    generateObjectMock.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('compares head-to-head with one LLM call: winner, trade-offs, recommendation', async () => {
    const fetchMock = mockWorkable(DETAILS);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    generateObjectMock.mockResolvedValue({
      object: {
        perCandidate: [
          {
            candidateId: 'maria',
            score: 86,
            verdict: 'strong_match',
            fitSummary: 'Full core-stack coverage and already in technical interview.',
            strengths: ['React + AWS verified'],
            concerns: ['Single employer'],
          },
          {
            candidateId: 'juan',
            score: 58,
            verdict: 'possible',
            fitSummary: 'Solid backend, no React evidence.',
            strengths: ['Deep Node.js'],
            concerns: ['No React on profile'],
          },
        ],
        winner: {
          candidateId: 'maria',
          margin: 'clear',
          rationale: 'Covers the frontend half of the stack that Juan lacks.',
        },
        tradeoffs: ['Maria brings React+AWS; Juan brings longer backend tenure'],
        recommendation: 'Advance Maria; keep Juan for backend-heavy roles.',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const out = await workableCompareCandidates.handler(
      { shortcode: 'REACT1', candidateIds: ['maria', 'juan'] },
      ctx,
    );

    expect(workableCompareCandidates.outputSchema.safeParse(out).success).toBe(true);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    // 1 job + 2 candidate details (ATS) + 1 TestGorilla batch (matcher) = 4 fetches.
    expect(fetchMock.mock.calls.length).toBe(4);

    expect(out.winner?.candidateId).toBe('maria');
    expect(out.winner?.name).toBe('Cand maria');
    expect(out.winner?.margin).toBe('clear');
    expect(out.candidates[0].id).toBe('maria');
    expect(out.candidates[0].verdict).toBe('strong_match');
    // Deterministic evidence still travels with the AI judgment.
    expect(out.candidates[0].matchedSkills).toEqual(
      expect.arrayContaining(['React', 'Node.js', 'AWS']),
    );
    expect(out.tradeoffs.join(' ')).toContain('longer backend tenure');
    expect(out.markdown).toContain('**Winner:** Cand maria (clear margin)');
    expect(out.markdown).toContain('Recommendation:');
    expect(out.markdown).toContain('| Cand maria |');

    // TestGorilla (matcher DB, keyed by email) reaches evidence, LLM card and table.
    expect(out.candidates[0].testGorilla?.avgScore).toBe(81.5);
    expect(out.candidates[0].evidence.join(' ')).toContain(
      'TestGorilla: avg 81.5 across 2 test(s)',
    );
    expect(out.candidates[1].testGorilla).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llmArgs = generateObjectMock.mock.calls[0]?.[0] as any;
    expect(llmArgs.prompt).toContain('testgorilla (verified assessment): React: 88');
    expect(llmArgs.system).toContain('TestGorilla lines are verified assessment results');
    expect(out.markdown).toContain('| 81.5 (2) |');
  });

  it('degrades to evidence comparison when the LLM fails, deriving the margin from the gap', async () => {
    globalThis.fetch = mockWorkable(DETAILS) as unknown as typeof fetch;
    generateObjectMock.mockRejectedValue(new Error('model unavailable'));

    const out = await workableCompareCandidates.handler(
      { shortcode: 'REACT1', candidateIds: ['maria', 'juan'] },
      ctx,
    );

    expect(workableCompareCandidates.outputSchema.safeParse(out).success).toBe(true);
    // Maria wins on evidence (3 posting skills + interview stage vs 1 + applied).
    expect(out.winner?.candidateId).toBe('maria');
    expect(out.candidates[0].scoreSource).toBe('deterministic');
    expect(out.recommendation).toBeNull();
    expect(out.meta.aiRanking.used).toBe(false);
    expect(out.meta.dataQuality.join(' ')).toContain('AI comparison unavailable');
  });

  it('fails loudly when it cannot load at least two profiles', async () => {
    globalThis.fetch = mockWorkable({ maria: DETAILS.maria }) as unknown as typeof fetch;

    await expect(
      workableCompareCandidates.handler(
        { shortcode: 'REACT1', candidateIds: ['maria', 'ghost'] },
        ctx,
      ),
    ).rejects.toThrow(/Could not load enough profiles/);
  });
});
