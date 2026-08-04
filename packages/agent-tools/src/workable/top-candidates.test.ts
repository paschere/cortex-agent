import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateObject } from "ai";
import type { ToolContext } from "../types";
import { workableTopCandidates } from "./top-candidates";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@ai-sdk/google", () => ({ google: vi.fn(() => "mock-model") }));

const generateObjectMock = vi.mocked(generateObject);

const ctx = {} as ToolContext;

const JOB = {
  shortcode: "REACT1",
  title: "Senior React Developer",
  state: "published",
  requirements:
    "<p>We need React, Node.js, TypeScript and AWS. GraphQL is a plus.</p>",
  full_description: "<p>Build web apps with React and Node.js on AWS.</p>",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function listRow(id: string, extra: Record<string, any> = {}) {
  return {
    id,
    name: `Cand ${id}`,
    stage: "Applied",
    updated_at: "2026-07-01T00:00:00Z",
    disqualified: false,
    profile_url: `https://workable.test/c/${id}`,
    ...extra,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detail(id: string, extra: Record<string, any> = {}) {
  return {
    candidate: {
      id,
      name: `Cand ${id}`,
      headline: "Software Developer",
      skills: [],
      tags: [],
      experience_entries: [],
      answers: [],
      ...extra,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockWorkable(candidates: any[], details: Record<string, any>) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/jobs/REACT1")) {
      return new Response(JSON.stringify(JOB), { status: 200 });
    }
    if (href.includes("/candidates?")) {
      return new Response(JSON.stringify({ candidates, paging: {} }), {
        status: 200,
      });
    }
    const id = /\/candidates\/([^/?]+)$/.exec(href)?.[1];
    if (id && details[id]) {
      return new Response(JSON.stringify(details[id]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function llmAnswers(object: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateObjectMock.mockResolvedValue({ object } as any);
}

const STRONG_DETAILS = {
  strong: detail("strong", {
    headline: "Senior React Developer",
    skills: ["React", "Node.js", "AWS", "TypeScript"],
    stage: "Technical Interview",
    experience_entries: [
      {
        title: "React Developer",
        company: "Acme",
        start_date: "2018-01-01",
        end_date: "2023-01-01",
      },
      {
        title: "Senior React Developer",
        company: "Beta",
        start_date: "2023-01-01",
        current: true,
      },
    ],
    answers: [{ question: "Salary?", answer: "5000 USD" }],
  }),
  weak: detail("weak", { skills: ["Cobol"], headline: "Mainframe Engineer" }),
};

describe("workable.top_candidates", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.WORKABLE_API_TOKEN = "test-token";
    process.env.WORKABLE_SUBDOMAIN = "Cortex";
    generateObjectMock.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("merges the single batched LLM evaluation with the deterministic evidence", async () => {
    const candidates = [
      listRow("weak"),
      listRow("strong", {
        stage: "Technical Interview",
        updated_at: "2026-07-20T00:00:00Z",
      }),
      listRow("dq", { disqualified: true }),
    ];
    globalThis.fetch = mockWorkable(
      candidates,
      STRONG_DETAILS,
    ) as unknown as typeof fetch;
    llmAnswers({
      ranking: [
        {
          candidateId: "strong",
          score: 88,
          verdict: "strong_match",
          why: "Covers the full core stack and is already in technical interview.",
          strengths: [
            "React + Node.js + AWS verified on profile",
            "8+ years in role",
          ],
          concerns: ["No Kubernetes signal"],
        },
        {
          candidateId: "weak",
          score: 22,
          verdict: "weak",
          why: "Mainframe background with no overlap with the stack.",
          strengths: [],
          concerns: ["No React/Node evidence"],
        },
      ],
      poolInsight: "Thin pool: one strong frontend profile, rest off-stack.",
    });

    const out = await workableTopCandidates.handler(
      { shortcode: "REACT1", limit: 5, maxProfiles: 25 },
      ctx,
    );

    expect(workableTopCandidates.outputSchema.safeParse(out).success).toBe(
      true,
    );
    // ONE batched LLM call, never per-candidate.
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    // The prompt carries compact cards, not raw payloads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = generateObjectMock.mock.calls[0]?.[0] as any;
    expect(args.prompt).toContain("Senior React Developer");
    expect(args.prompt).toContain("deterministic evidence:");

    // Disqualified candidate never hydrated or ranked.
    expect(out.candidates.map((c) => c.id)).toEqual(["strong", "weak"]);
    const strong = out.candidates[0];
    expect(strong.score).toBe(88);
    expect(strong.scoreSource).toBe("llm");
    expect(strong.verdict).toBe("strong_match");
    expect(strong.strengths.length).toBeGreaterThan(0);
    // Deterministic evidence still travels alongside the AI insights.
    expect(strong.matchedSkills).toEqual(
      expect.arrayContaining(["React", "Node.js", "AWS", "TypeScript"]),
    );
    expect(strong.experienceYears).toBeGreaterThan(7);
    expect(strong.evidence.join(" ")).toContain("appear in the job posting");

    expect(out.poolInsight).toContain("Thin pool");
    expect(out.meta.aiRanking.used).toBe(true);
    expect(out.markdown).toContain("Why: Covers the full core stack");
    expect(out.markdown).toContain("Concerns: No Kubernetes signal");
    expect(out.markdown).toContain("Pool insight:");
  });

  it("degrades to the evidence ranking when the LLM fails, and says so", async () => {
    const candidates = [
      listRow("weak"),
      listRow("strong", {
        stage: "Technical Interview",
        updated_at: "2026-07-20T00:00:00Z",
      }),
    ];
    globalThis.fetch = mockWorkable(
      candidates,
      STRONG_DETAILS,
    ) as unknown as typeof fetch;
    generateObjectMock.mockRejectedValue(new Error("model unavailable"));

    const out = await workableTopCandidates.handler(
      { shortcode: "REACT1", limit: 5, maxProfiles: 25 },
      ctx,
    );

    expect(workableTopCandidates.outputSchema.safeParse(out).success).toBe(
      true,
    );
    // Evidence ranking still puts the strong profile first.
    expect(out.candidates[0].id).toBe("strong");
    expect(out.candidates[0].scoreSource).toBe("deterministic");
    expect(out.candidates[0].verdict).toBeNull();
    expect(out.meta.aiRanking.used).toBe(false);
    expect(out.meta.dataQuality.join(" ")).toContain("AI insights unavailable");
  });

  it("scores coverage of mustHaveSkills and names what is missing", async () => {
    const candidates = [listRow("partial")];
    const details = {
      partial: detail("partial", {
        skills: ["React"],
        summary: "Frontend developer working with React and GraphQL.",
      }),
    };
    globalThis.fetch = mockWorkable(
      candidates,
      details,
    ) as unknown as typeof fetch;
    llmAnswers({
      ranking: [
        {
          candidateId: "partial",
          score: 55,
          verdict: "possible",
          why: "Covers React and GraphQL but no Kubernetes evidence.",
          strengths: ["React verified"],
          concerns: ["Kubernetes missing"],
        },
      ],
      poolInsight: "Single-candidate pool.",
    });

    const out = await workableTopCandidates.handler(
      {
        shortcode: "REACT1",
        limit: 5,
        maxProfiles: 25,
        mustHaveSkills: ["React", "GraphQL", "Kubernetes"],
      },
      ctx,
    );

    const c = out.candidates[0];
    expect(c.matchedSkills).toEqual(["React", "GraphQL"]);
    expect(c.missingMustHaves).toEqual(["Kubernetes"]);
    expect(c.breakdown.skills).toBe(67);
    expect(c.evidence.join(" ")).toContain("missing: Kubernetes");
    // The must-have list reaches the LLM too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = generateObjectMock.mock.calls[0]?.[0] as any;
    expect(args.prompt).toContain("MUST-HAVE SKILLS");
    expect(args.prompt).toContain("Kubernetes");
  });

  it("caps hydration, prioritizes advanced stages, and discloses who was skipped", async () => {
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) => listRow(`applied-${i}`)),
      listRow("interview", {
        stage: "Client Interview",
        updated_at: "2026-07-25T00:00:00Z",
      }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details: Record<string, any> = {
      interview: detail("interview", { skills: ["React"] }),
    };
    for (let i = 0; i < 8; i++)
      details[`applied-${i}`] = detail(`applied-${i}`);
    const fetchMock = mockWorkable(candidates, details);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    llmAnswers({
      ranking: [
        {
          candidateId: "interview",
          score: 70,
          verdict: "good_match",
          why: "React on profile and already in client interview.",
          strengths: ["React"],
          concerns: [],
        },
      ],
      poolInsight: "Mostly unscreened applicants.",
    });

    const out = await workableTopCandidates.handler(
      { shortcode: "REACT1", limit: 5, maxProfiles: 5 },
      ctx,
    );

    // Advanced-stage candidate always makes the hydration cut and ranks first.
    expect(out.candidates[0].id).toBe("interview");
    expect(out.meta.profilesLoaded).toBe(5);
    expect(out.meta.activeCandidates).toBe(9);
    expect(out.meta.dataQuality.join(" ")).toContain(
      "did not get a deep profile look",
    );
    // 1 job + 1 list page + 5 details = 7 ATS calls, never more.
    expect(fetchMock.mock.calls.length).toBe(7);
  });
});
