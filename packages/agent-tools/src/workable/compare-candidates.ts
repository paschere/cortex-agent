import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import { registerTool } from '../index';
import { workableFetch } from './client';
import {
  type EvidenceCandidate,
  RANKING_MODEL,
  type Raw,
  VERDICT_LABEL,
  buildEvidence,
  buildJobContext,
  fetchCandidateDetail,
} from './evaluate';

/**
 * workable.compare_candidates — head-to-head comparison of 2-5 named
 * candidates for one job, live from Workable.
 *
 * Same architecture as workable.top_candidates but for the finalist decision:
 * tiny ATS budget (1 job + one detail fetch per candidate, sequential with
 * spacing), deterministic evidence per profile, then ONE batched LLM call
 * that judges them AGAINST EACH OTHER — winner with margin, the trade-offs
 * the recruiter is actually choosing between, and a recommendation. Degrades
 * to the evidence ranking if the LLM is unavailable.
 */

const MAX_CANDIDATES = 5;
/** Gap between sequential detail fetches — trivial load, far under 10 req/s. */
const FETCH_GAP_MS = 150;

const llmCompareSchema = z.object({
  perCandidate: z.array(
    z.object({
      candidateId: z.string(),
      score: z.number().min(0).max(100),
      verdict: z.enum(['strong_match', 'good_match', 'possible', 'weak']),
      fitSummary: z.string().describe('1-2 sentences on their fit for THIS job, citing the data'),
      strengths: z.array(z.string()).max(4),
      concerns: z
        .array(z.string())
        .max(3)
        .describe('Risks or gaps, including missing data ("no dated work history")'),
    }),
  ),
  winner: z.object({
    candidateId: z.string(),
    margin: z.enum(['clear', 'narrow', 'toss_up']),
    rationale: z.string().describe('Why they win, grounded in the compared evidence'),
  }),
  tradeoffs: z
    .array(z.string())
    .max(4)
    .describe(
      'The real choices between them, e.g. "A brings AWS depth, B brings client-facing interview progress"',
    ),
  recommendation: z
    .string()
    .describe('1-2 sentences: what the recruiter should do next with these candidates'),
});

type LlmCompare = z.infer<typeof llmCompareSchema>;

async function compareWithLlm(
  jobTitle: string,
  jobText: string,
  mustHaves: string[],
  candidates: EvidenceCandidate[],
  signal?: AbortSignal,
): Promise<LlmCompare> {
  const system = [
    'You are a senior technical recruiter at Zipdev comparing finalists for one job.',
    'STRICT GROUNDING RULES:',
    '- Use ONLY the candidate cards and job description provided. Never invent skills, employers, dates, or outcomes.',
    '- Every strength, concern and trade-off must be traceable to the provided data; missing/unclear data is itself a valid concern.',
    "- Scores are relative to THIS job's requirements.",
    '- Judge only professional signal. Ignore and never mention name origin, gender, age, or photos.',
    '- Declare margin "toss_up" when the evidence genuinely does not separate them — do not force a winner.',
    'Return every candidate exactly once in `perCandidate`.',
  ].join('\n');

  const prompt = [
    `JOB: ${jobTitle}`,
    mustHaves.length ? `MUST-HAVE SKILLS (per the recruiter): ${mustHaves.join(', ')}` : null,
    `JOB POSTING (trimmed): ${jobText.slice(0, 2_500)}`,
    '',
    `CANDIDATES TO COMPARE (${candidates.length}):`,
    ...candidates.map((c, i) => `--- Candidate ${i + 1} ---\n${c.card}`),
    '',
    'Compare them head-to-head for this job: individual verdicts, the winner (or toss_up), the trade-offs between them, and what to do next.',
  ]
    .filter((v) => v != null)
    .join('\n');

  const { object } = await generateObject({
    model: google(RANKING_MODEL()),
    schema: llmCompareSchema,
    system,
    prompt,
    abortSignal: signal,
  });
  return object;
}

export const workableCompareCandidates = registerTool({
  id: 'workable.compare_candidates',
  description:
    'Head-to-head comparison of 2-5 specific Workable candidates for one job, LIVE from the ATS — use when the user asks "who is better between X and Y (for this role)?", "compare the finalists", or must pick who advances. Fetches the job posting and each full profile fresh (a handful of ATS calls), builds deterministic evidence per person (skills in the posting, role fit, experience years, stage), then a SINGLE batched LLM evaluation judges them against each other: per-candidate score/verdict/strengths/concerns, a winner with margin (clear/narrow/toss_up — a toss-up is a legitimate answer), the concrete trade-offs between them, and a next-step recommendation. ' +
    'Candidate ids come from workable.top_candidates, workable.list_candidates or workable.search_candidates. Pass mustHaveSkills when the user names what matters. ' +
    'If the LLM is unavailable it degrades to the deterministic evidence comparison and meta.dataQuality says so. Note: recruit.compare_candidates compares matcher-DB records instead (interviews, TestGorilla, stored AI scores) — prefer THIS tool for live ATS truth, that one when the deep enriched history matters. ' +
    "HOW TO PHRASE IT: plain human terms, no tool names or ids. Lead with the verdict and the trade-off ('Entre los dos, María: cubre AWS que Juan no muestra; Juan solo gana en años totales — y va empatado en etapa').",
  inputSchema: z.object({
    shortcode: z.string().min(1).describe('Workable job shortcode the comparison is against'),
    candidateIds: z
      .array(z.string().min(1))
      .min(2)
      .max(MAX_CANDIDATES)
      .describe('2-5 Workable candidate ids to compare'),
    mustHaveSkills: z
      .array(z.string().min(2))
      .max(15)
      .optional()
      .describe('Skills the role truly requires; when set, evidence scores coverage of this list'),
  }),
  outputSchema: z.object({
    job: z.object({
      shortcode: z.string(),
      title: z.string().nullable(),
      state: z.string().nullable(),
    }),
    candidates: z.array(z.any()),
    winner: z
      .object({
        candidateId: z.string(),
        name: z.string().nullable(),
        margin: z.enum(['clear', 'narrow', 'toss_up']),
        rationale: z.string().nullable(),
      })
      .nullable(),
    tradeoffs: z.array(z.string()),
    recommendation: z.string().nullable(),
    meta: z
      .object({
        fetchedAt: z.string(),
        requested: z.number(),
        loaded: z.number(),
        loadErrors: z.array(z.string()),
        apiCalls: z.number(),
        aiRanking: z.object({ used: z.boolean(), model: z.string().nullable() }),
        source: z.any(),
        dataQuality: z.array(z.string()),
      })
      .passthrough(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const ids = [...new Set(input.candidateIds)];
    const mustHaves = (input.mustHaveSkills ?? []).map((s) => s.trim()).filter(Boolean);
    let apiCalls = 0;

    // 1. The job posting the comparison is anchored to.
    apiCalls++;
    const job: Raw = await workableFetch(
      `/jobs/${encodeURIComponent(input.shortcode)}?include_fields=description,full_description,requirements`,
      { signal: ctx.signal },
    );
    const jobCtx = buildJobContext(job, input.shortcode);

    // 2. Each profile, fresh — sequential with spacing (≤5 calls, trivial load).
    const loaded: EvidenceCandidate[] = [];
    const loadErrors: string[] = [];
    for (const id of ids) {
      if (ctx.signal?.aborted) break;
      try {
        apiCalls++;
        const detail = await fetchCandidateDetail(id, ctx.signal);
        loaded.push(buildEvidence(detail, detail, jobCtx, mustHaves));
      } catch (err) {
        loadErrors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
    }

    if (loaded.length < 2) {
      throw new Error(
        `Could not load enough profiles to compare (loaded ${loaded.length} of ${ids.length}). ${loadErrors.join('; ')}`,
      );
    }

    // 3. One batched LLM comparison; evidence-only fallback if it fails.
    let llm: LlmCompare | null = null;
    let llmError: string | null = null;
    try {
      llm = await compareWithLlm(jobCtx.title, jobCtx.text, mustHaves, loaded, ctx.signal);
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
    }

    const byId = new Map(loaded.map((c) => [c.id, c]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let candidates: any[];
    let winner: {
      candidateId: string;
      name: string | null;
      margin: 'clear' | 'narrow' | 'toss_up';
      rationale: string | null;
    } | null = null;
    let tradeoffs: string[] = [];
    let recommendation: string | null = null;

    if (llm) {
      const seen = new Set<string>();
      candidates = llm.perCandidate
        .filter(
          (r) => byId.has(r.candidateId) && !seen.has(r.candidateId) && seen.add(r.candidateId),
        )
        .map((r) => {
          const c = byId.get(r.candidateId) as EvidenceCandidate;
          const { card: _card, preScore, ...rest } = c;
          return {
            ...rest,
            score: Math.round(r.score),
            scoreSource: 'llm',
            verdict: r.verdict,
            fitSummary: r.fitSummary,
            strengths: r.strengths,
            concerns: r.concerns,
            preScore,
          };
        })
        .sort((a, b) => b.score - a.score);
      const w = byId.get(llm.winner.candidateId);
      winner = {
        candidateId: llm.winner.candidateId,
        name: w?.name ?? null,
        margin: llm.winner.margin,
        rationale: llm.winner.rationale,
      };
      tradeoffs = llm.tradeoffs;
      recommendation = llm.recommendation;
    } else {
      // Evidence-only: rank by pre-score and derive the margin from the gap.
      const ranked = [...loaded].sort((a, b) => b.preScore - a.preScore);
      candidates = ranked.map((c) => {
        const { card: _card, preScore, ...rest } = c;
        return {
          ...rest,
          score: preScore,
          scoreSource: 'deterministic',
          verdict: null,
          fitSummary: null,
          strengths: [],
          concerns: [],
          preScore,
        };
      });
      const gap = (ranked[0]?.preScore ?? 0) - (ranked[1]?.preScore ?? 0);
      const first = ranked[0];
      if (first) {
        winner = {
          candidateId: first.id,
          name: first.name,
          margin: gap > 12 ? 'clear' : gap > 4 ? 'narrow' : 'toss_up',
          rationale: null,
        };
      }
    }

    const dataQuality: string[] = [];
    if (loadErrors.length) {
      dataQuality.push(
        `${loadErrors.length} candidate(s) could not be loaded and are missing from the comparison: ${loadErrors.join('; ')}`,
      );
    }
    if (llmError) {
      dataQuality.push(
        'AI comparison unavailable for this call (the evaluation model failed) — ranking and margin come from the deterministic evidence only; verdicts, trade-offs and the recommendation are missing, not zero.',
      );
    }
    dataQuality.push(
      llm
        ? 'Scores, verdicts, trade-offs and the recommendation are Zipdev AI output computed just now over live Workable data — not ATS fields and not client feedback. `evidence` lines are deterministic and verifiable in the profile.'
        : 'This comparison is deterministic keyword/date evidence computed live from Workable — not ATS fields and not client feedback.',
    );

    const meta = {
      fetchedAt: new Date().toISOString(),
      requested: ids.length,
      loaded: loaded.length,
      loadErrors,
      apiCalls,
      aiRanking: { used: !!llm, model: llm ? RANKING_MODEL() : null },
      source: {
        system: 'Workable ATS (live, SPI v3)',
        endpoint: '/jobs/:shortcode + /candidates/:id',
      },
      dataQuality,
    };

    const marginLabel: Record<string, string> = {
      clear: 'clear margin',
      narrow: 'narrow margin',
      toss_up: 'toss-up',
    };
    const lines: string[] = [];
    lines.push(
      `**Comparison for "${jobCtx.title}"** — ${loaded.length} candidates, live from Workable${llm ? ', AI-evaluated in one pass' : ''}`,
    );
    lines.push('');
    lines.push('| Candidate | Score | Verdict | Exp | Skills matched | Stage |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of candidates) {
      lines.push(
        `| ${c.name} | ${Math.round(c.score)}/100 | ${c.verdict ? (VERDICT_LABEL[c.verdict] ?? c.verdict) : '—'} | ${c.experienceYears != null ? `≈${c.experienceYears}y` : '—'} | ${c.matchedSkills.length} | ${c.stage ?? '—'} |`,
      );
    }
    lines.push('');
    if (winner) {
      lines.push(
        `**Winner:** ${winner.name ?? winner.candidateId} (${marginLabel[winner.margin]})${winner.rationale ? ` — ${winner.rationale}` : ''}`,
      );
    }
    if (tradeoffs.length) {
      lines.push('');
      lines.push('**Trade-offs:**');
      for (const t of tradeoffs) lines.push(`- ${t}`);
    }
    if (recommendation) {
      lines.push('');
      lines.push(`**Recommendation:** ${recommendation}`);
    }
    lines.push('');
    for (const c of candidates) {
      lines.push(`**${c.name}** — ${Math.round(c.score)}/100`);
      if (c.fitSummary) lines.push(`- Fit: ${c.fitSummary}`);
      if (c.strengths?.length) lines.push(`- Strengths: ${c.strengths.join('; ')}`);
      if (c.concerns?.length) lines.push(`- Concerns: ${c.concerns.join('; ')}`);
      for (const e of c.evidence) lines.push(`- Evidence: ${e}`);
      lines.push('');
    }
    lines.push(
      `_source: Workable ATS live · read ${meta.fetchedAt}${llm ? ` · AI evaluation: one batched pass (${RANKING_MODEL()})` : ' · deterministic evidence comparison'}_`,
    );
    for (const note of dataQuality) lines.push(`> ⚠️ ${note}`);

    return {
      job: {
        shortcode: input.shortcode,
        title: job?.title ?? null,
        state: job?.state ?? null,
      },
      candidates,
      winner,
      tradeoffs,
      recommendation,
      meta,
      markdown: lines.join('\n'),
    };
  },
});
