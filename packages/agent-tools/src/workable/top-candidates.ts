import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import { registerTool } from '../index';
import { workableFetch } from './client';
import { fetchCandidatePages } from './tools-extra';

/**
 * workable.top_candidates — "top N for this job, and why", straight from
 * Workable, live, with LLM-grade insights.
 *
 * Why Workable-direct: the matcher DB only knows what its sync has imported,
 * and the sync is throttled far below Workable's 10 req/s global limit — so
 * DB-based rankings silently miss whoever hasn't been synced yet. This tool
 * treats Workable as the single source of truth: given a job shortcode it
 * fetches the job, pages through its real pipeline, and hydrates a bounded
 * set of full profiles under a self-imposed throttle.
 *
 * Why it is still fast despite using an LLM: the old matching run fired one
 * LLM scoring call PER candidate (up to 50, minutes of wall clock). Here the
 * deterministic evidence pass (skills-in-posting, role fit, experience dates,
 * stage progress) pre-ranks the pool for free, and then ONE batched LLM call
 * evaluates the shortlist together — richer comparative insights, a single
 * round trip. If the LLM is unavailable the tool degrades to the evidence
 * ranking and says so, rather than failing.
 *
 * Call budget (worst case ~35 ATS requests + 1 LLM call):
 *   1        job detail
 *   1–3      candidate list pages (100/page)
 *   ≤ maxProfiles  full profiles, fetched 3-at-a-time with spacing so the
 *                  burst stays around ~7 req/s of the 10 req/s global cap.
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_PROFILES = 25;
const MAX_PROFILES = 50;
/** Detail-fetch pool: 3 workers with a small gap ≈ 7 req/s peak. */
const HYDRATE_CONCURRENCY = 3;
const HYDRATE_GAP_MS = 120;
/** How many pre-ranked candidates the single LLM call compares. */
const MAX_LLM_CANDIDATES = 20;
/** Fast model by default; override for deeper reads via env. */
const RANKING_MODEL = () => process.env.ZIPDEV_RANKING_MODEL ?? 'gemini-3.1-flash-lite';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

function stripHtml(s: string | null | undefined, cap = 12_000): string {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boundary-aware containment: "go" must not match "google", but "c++" and
 * "node.js" must still match. Letters/digits/+/# glue a token together; a dot
 * is a boundary ("GraphQL." at sentence end must match "graphql") yet still
 * matches inside a term because it is escaped there ("node.js").
 */
function termInText(term: string, loweredText: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return false;
  const re = new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(t)}($|[^a-z0-9+#])`, 'i');
  return re.test(loweredText);
}

/** Merge experience_entries date ranges into total non-overlapping years. */
function experienceYears(entries: Raw[]): number | null {
  const now = Date.now();
  const ranges: [number, number][] = [];
  for (const e of entries ?? []) {
    const start = e?.start_date ? Date.parse(String(e.start_date)) : Number.NaN;
    if (Number.isNaN(start)) continue;
    const endRaw = e?.end_date ? Date.parse(String(e.end_date)) : now;
    const end = Number.isNaN(endRaw) || e?.current ? now : endRaw;
    if (end > start) ranges.push([start, Math.min(end, now)]);
  }
  const first = ranges.sort((a, b) => a[0] - b[0])[0];
  if (!first) return null;
  let total = 0;
  let [curStart, curEnd] = first;
  for (const [s, e] of ranges.slice(1)) {
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else {
      total += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  total += curEnd - curStart;
  return Math.min(40, Math.round((total / 31_557_600_000) * 10) / 10);
}

/** Workable stage names vary per account — rank by well-known keywords. */
function stageProgress(stage: string | null | undefined): number {
  const s = (stage ?? '').toLowerCase();
  if (/hire/.test(s)) return 100;
  if (/offer/.test(s)) return 90;
  if (/interview|panel|onsite|final|client|manager/.test(s)) return 70;
  if (/assess|test|challenge|exercise|gorilla/.test(s)) return 55;
  if (/screen|phone|call|evaluaci/.test(s)) return 45;
  return 20; // sourced / applied / new / unknown
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'our',
  'you',
  'your',
  'per',
  'via',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'para',
  'con',
  'y',
  'o',
  'en',
  'un',
  'una',
  'jr',
  'sr',
  'mid',
  'level',
  'remote',
  'remoto',
  'latam',
]);

function titleTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
    ),
  ];
}

interface EvidenceCandidate {
  id: string;
  name: string;
  headline: string | null;
  stage: string | null;
  updatedAt: string | null;
  profileUrl: string | null;
  preScore: number;
  breakdown: { skills: number; roleFit: number; experience: number; stageProgress: number };
  matchedSkills: string[];
  missingMustHaves: string[];
  experienceYears: number | null;
  evidence: string[];
  /** Compact card for the batched LLM evaluation — never the full profile. */
  card: string;
}

function buildEvidence(
  detail: Raw,
  listRow: Raw,
  jobTextLower: string,
  jobTitleTokens: string[],
  mustHaves: string[],
): EvidenceCandidate {
  const skills: string[] = [
    ...new Set(
      [...(detail?.skills ?? []), ...(detail?.tags ?? [])]
        .map((s: Raw) => String(typeof s === 'string' ? s : (s?.name ?? '')))
        .filter((s: string) => s.trim().length >= 2),
    ),
  ];
  const experiences: Raw[] = Array.isArray(detail?.experience_entries)
    ? detail.experience_entries
    : [];
  const headline: string | null = detail?.headline ?? null;

  const evidence: string[] = [];

  // --- skills (50% of pre-score) ---
  let skillsScore: number;
  let matchedSkills: string[];
  let missingMustHaves: string[] = [];
  if (mustHaves.length > 0) {
    // The recruiter told us what matters: score coverage of THEIR list against
    // the candidate's own profile text (skills + summary + experience prose).
    const candidateText = [
      skills.join(' '),
      stripHtml(detail?.summary, 4_000),
      headline ?? '',
      ...experiences.map((e) => `${e?.title ?? ''} ${stripHtml(e?.summary, 500)}`),
    ]
      .join(' ')
      .toLowerCase();
    matchedSkills = mustHaves.filter((m) => termInText(m, candidateText));
    missingMustHaves = mustHaves.filter((m) => !matchedSkills.includes(m));
    skillsScore = (matchedSkills.length / mustHaves.length) * 100;
    evidence.push(
      `Covers ${matchedSkills.length}/${mustHaves.length} must-have skills${matchedSkills.length ? `: ${matchedSkills.join(', ')}` : ''}${missingMustHaves.length && missingMustHaves.length <= 5 ? ` (missing: ${missingMustHaves.join(', ')})` : ''}`,
    );
  } else {
    // No curated list: count which of THEIR skills the job posting mentions.
    matchedSkills = skills.filter((s) => termInText(s, jobTextLower));
    skillsScore = (Math.min(matchedSkills.length, 8) / 8) * 100;
    if (matchedSkills.length) {
      evidence.push(
        `${matchedSkills.length} of their ${skills.length} listed skills appear in the job posting: ${matchedSkills.slice(0, 8).join(', ')}${matchedSkills.length > 8 ? '…' : ''}`,
      );
    } else if (skills.length) {
      evidence.push(
        `None of their ${skills.length} listed skills appear verbatim in the job posting`,
      );
    } else {
      evidence.push('No skills/tags on their Workable profile — skill match unknown');
    }
  }

  // --- role fit (20%) ---
  const roleText = [headline ?? '', ...experiences.slice(0, 3).map((e) => String(e?.title ?? ''))]
    .join(' ')
    .toLowerCase();
  const fitHits = jobTitleTokens.filter((t) => termInText(t, roleText));
  const roleFit = jobTitleTokens.length ? (fitHits.length / jobTitleTokens.length) * 100 : 0;
  if (fitHits.length) {
    evidence.push(
      `Role fit: ${headline ? `"${headline}"` : 'their recent titles'} match the job title on ${fitHits.join(', ')}`,
    );
  }

  // --- experience (15%) ---
  const years = experienceYears(experiences);
  const expScore = years == null ? 0 : Math.min(years / 8, 1) * 100;
  if (years != null) {
    evidence.push(`≈${years} yrs experience across ${experiences.length} role(s)`);
  } else {
    evidence.push('No dated work history on their profile — experience length unknown');
  }

  // --- pipeline progress (15%) ---
  const stage = listRow?.stage ?? detail?.stage ?? null;
  const stageScore = stageProgress(stage);
  if (stage && stageScore >= 45) {
    evidence.push(`Already at stage "${stage}" — the team has been advancing them`);
  }

  const answers: Raw[] = Array.isArray(detail?.answers) ? detail.answers : [];
  if (answers.length > 0) evidence.push(`Answered ${answers.length} screening question(s)`);

  const preScore =
    Math.round((skillsScore * 0.5 + roleFit * 0.2 + expScore * 0.15 + stageScore * 0.15) * 10) / 10;

  // The card is everything the LLM is allowed to know about this person:
  // compact, factual, no raw resume dump.
  const recentRoles = experiences
    .slice(0, 4)
    .map(
      (e) =>
        `${e?.title ?? '?'} @ ${e?.company ?? '?'} (${String(e?.start_date ?? '?').slice(0, 7)}–${e?.current ? 'now' : String(e?.end_date ?? '?').slice(0, 7)})`,
    )
    .join('; ');
  const answerLines = answers
    .slice(0, 3)
    .map(
      (a: Raw) =>
        `Q: ${stripHtml(String(a?.question ?? ''), 120)} → A: ${stripHtml(String(a?.answer ?? ''), 180)}`,
    )
    .join(' | ');
  const card = [
    `id: ${String(detail?.id ?? listRow?.id ?? '')}`,
    `name: ${detail?.name ?? listRow?.name ?? '?'}`,
    headline ? `headline: ${headline}` : null,
    `current stage: ${stage ?? 'unknown'}`,
    `skills on profile: ${skills.slice(0, 15).join(', ') || 'none listed'}`,
    years != null ? `experience: ≈${years} yrs` : 'experience: undated',
    recentRoles ? `recent roles: ${recentRoles}` : null,
    detail?.summary ? `profile summary: ${stripHtml(detail.summary, 500)}` : null,
    answerLines ? `screening answers: ${answerLines}` : null,
    `deterministic evidence: ${evidence.join(' | ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    id: String(detail?.id ?? listRow?.id ?? ''),
    name:
      detail?.name ??
      listRow?.name ??
      [detail?.firstname, detail?.lastname].filter(Boolean).join(' '),
    headline,
    stage,
    updatedAt: listRow?.updated_at ?? detail?.updated_at ?? null,
    profileUrl: detail?.profile_url ?? listRow?.profile_url ?? null,
    preScore,
    breakdown: {
      skills: Math.round(skillsScore),
      roleFit: Math.round(roleFit),
      experience: Math.round(expScore),
      stageProgress: stageScore,
    },
    matchedSkills,
    missingMustHaves,
    experienceYears: years,
    evidence,
    card,
  };
}

const llmRankingSchema = z.object({
  ranking: z.array(
    z.object({
      candidateId: z.string(),
      score: z.number().min(0).max(100),
      verdict: z.enum(['strong_match', 'good_match', 'possible', 'weak']),
      why: z
        .string()
        .describe('1-2 sentences: why this candidate earns this rank, citing the data'),
      strengths: z.array(z.string()).max(4),
      concerns: z
        .array(z.string())
        .max(3)
        .describe('Risks or gaps, including missing data ("no dated work history")'),
    }),
  ),
  poolInsight: z
    .string()
    .describe(
      '2-3 sentences on the pool overall: depth, common gaps, where the real competition is',
    ),
});

type LlmRanking = z.infer<typeof llmRankingSchema>;

async function rankWithLlm(
  jobTitle: string,
  jobText: string,
  mustHaves: string[],
  candidates: EvidenceCandidate[],
  limit: number,
  signal?: AbortSignal,
): Promise<LlmRanking> {
  const system = [
    'You are a senior technical recruiter at Zipdev evaluating candidates for one job.',
    'STRICT GROUNDING RULES:',
    '- Use ONLY the candidate cards and job description provided. Never invent skills, employers, dates, or outcomes.',
    '- Every strength and concern must be traceable to the provided data; missing/unclear data is itself a valid concern.',
    "- Scores are relative to THIS job's requirements, not to each other.",
    '- Judge only professional signal. Ignore and never mention name origin, gender, age, or photos.',
    'Return every candidate you were given exactly once in `ranking`, best first.',
  ].join('\n');

  const prompt = [
    `JOB: ${jobTitle}`,
    mustHaves.length ? `MUST-HAVE SKILLS (per the recruiter): ${mustHaves.join(', ')}` : null,
    `JOB POSTING (trimmed): ${jobText.slice(0, 2_500)}`,
    '',
    `CANDIDATES (${candidates.length}):`,
    ...candidates.map((c, i) => `--- Candidate ${i + 1} ---\n${c.card}`),
    '',
    `Rank ALL ${candidates.length} candidates for this job (the caller will keep the top ${limit}).`,
  ]
    .filter((v) => v != null)
    .join('\n');

  const { object } = await generateObject({
    model: google(RANKING_MODEL()),
    schema: llmRankingSchema,
    system,
    prompt,
    abortSignal: signal,
  });
  return object;
}

export const workableTopCandidates = registerTool({
  id: 'workable.top_candidates',
  description:
    'Top N candidates for a Workable job with AI insights, computed LIVE from the ATS in one call — answers "who are the top 5 for this job and why" without a matching run and without any database dependency. Give it the job shortcode (from workable.list_jobs); it fetches the job posting, pages through the real pipeline, loads full profiles for the strongest subset (bounded, rate-limit-safe), then a SINGLE batched LLM evaluation compares them against the job and returns, per candidate: score, verdict (strong_match/good_match/possible/weak), why they rank, strengths, concerns — plus deterministic `evidence` (skills found in the posting, role fit, experience years, stage) and a `poolInsight` about the pipeline overall. Present the why/strengths/concerns as the answer. ' +
    'Pass mustHaveSkills (e.g. ["React","Node.js","AWS"]) when the user names what matters — both the evidence pass and the LLM weigh coverage of that list. ' +
    'LIMITS to disclose: only `profilesLoaded` of `poolSize` candidates get a deep look (prioritized by stage + recency; meta says if others were left out). If the LLM is unavailable the tool still answers using the deterministic evidence ranking and meta.dataQuality says so. recruit.find_matches remains the tool for a full per-candidate deep evaluation that also attaches recommendations to the job. ' +
    "HOW TO PHRASE IT: plain human terms, no tool names or shortcodes. Lead with names and why ('María va primera: cubre React, Node y AWS, ≈9 años de experiencia, y su riesgo es que no muestra proyectos con Kubernetes').",
  inputSchema: z.object({
    shortcode: z.string().min(1).describe('Workable job shortcode, e.g. from workable.list_jobs'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    mustHaveSkills: z
      .array(z.string().min(2))
      .max(15)
      .optional()
      .describe('Skills the role truly requires; when set, ranking scores coverage of this list'),
    stage: z.string().optional().describe('Only consider candidates currently in this stage'),
    maxProfiles: z
      .number()
      .int()
      .min(5)
      .max(MAX_PROFILES)
      .default(DEFAULT_PROFILES)
      .describe('How many full profiles to load for deep ranking (each costs one ATS call)'),
  }),
  outputSchema: z.object({
    job: z.object({
      shortcode: z.string(),
      title: z.string().nullable(),
      state: z.string().nullable(),
    }),
    candidates: z.array(z.any()),
    poolInsight: z.string().nullable(),
    meta: z
      .object({
        fetchedAt: z.string(),
        poolSize: z.number(),
        activeCandidates: z.number(),
        profilesLoaded: z.number(),
        profileErrors: z.number(),
        apiCalls: z.number(),
        aiRanking: z.object({ used: z.boolean(), model: z.string().nullable() }),
        source: z.any(),
        dataQuality: z.array(z.string()),
      })
      .passthrough(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const maxProfiles = input.maxProfiles ?? DEFAULT_PROFILES;
    const mustHaves = (input.mustHaveSkills ?? []).map((s) => s.trim()).filter(Boolean);
    let apiCalls = 0;

    // 1. The job posting — title + prose is what we match skills against.
    apiCalls++;
    const job: Raw = await workableFetch(
      `/jobs/${encodeURIComponent(input.shortcode)}?include_fields=description,full_description,requirements`,
      { signal: ctx.signal },
    );
    const jobText = [
      job?.title ?? '',
      stripHtml(job?.requirements),
      stripHtml(job?.full_description ?? job?.description),
    ].join(' ');
    const jobTextLower = jobText.toLowerCase();
    const jobTokens = titleTokens(String(job?.title ?? ''));

    // 2. The live pipeline (100/page, up to 3 pages = 300 candidates).
    const params = new URLSearchParams({ shortcode: input.shortcode, limit: '100' });
    if (input.stage) params.set('stage', input.stage);
    const pool: Raw[] = await fetchCandidatePages(`/candidates?${params}`, 3, ctx.signal);
    apiCalls += Math.max(1, Math.ceil(pool.length / 100));
    const scannedAll = pool.length < 300;

    // 3. Cheap prioritization BEFORE spending detail calls: active only,
    //    furthest stage first, then most recent activity.
    const active = pool.filter((c) => !c?.disqualified);
    const toHydrate = [...active]
      .sort(
        (a, b) =>
          stageProgress(b?.stage) - stageProgress(a?.stage) ||
          String(b?.updated_at ?? '').localeCompare(String(a?.updated_at ?? '')),
      )
      .slice(0, maxProfiles);

    // 4. Hydrate full profiles under a self-imposed throttle so this tool can
    //    never eat Workable's 10 req/s global budget on its own.
    const hydrated: EvidenceCandidate[] = [];
    let profileErrors = 0;
    let cursor = 0;
    const workers = Array.from({ length: HYDRATE_CONCURRENCY }, async () => {
      while (cursor < toHydrate.length) {
        if (ctx.signal?.aborted) return;
        const row = toHydrate[cursor++];
        try {
          apiCalls++;
          const data: Raw = await workableFetch(
            `/candidates/${encodeURIComponent(String(row.id))}`,
            { signal: ctx.signal },
          );
          const detail = data?.candidate ?? data;
          hydrated.push(buildEvidence(detail, row, jobTextLower, jobTokens, mustHaves));
        } catch {
          profileErrors++;
        }
        await new Promise((r) => setTimeout(r, HYDRATE_GAP_MS));
      }
    });
    await Promise.all(workers);

    // 5. Evidence pre-rank chooses who goes into the single batched LLM call.
    const preRanked = [...hydrated].sort((a, b) => b.preScore - a.preScore);
    const llmPool = preRanked.slice(0, Math.min(MAX_LLM_CANDIDATES, preRanked.length));

    let llm: LlmRanking | null = null;
    let llmError: string | null = null;
    if (llmPool.length > 0) {
      try {
        llm = await rankWithLlm(
          String(job?.title ?? input.shortcode),
          jobText,
          mustHaves,
          llmPool,
          limit,
          ctx.signal,
        );
      } catch (err) {
        llmError = err instanceof Error ? err.message : String(err);
      }
    }

    // 6. Merge: LLM order + insights when available, evidence ranking otherwise.
    const byId = new Map(hydrated.map((c) => [c.id, c]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let top: any[];
    if (llm) {
      const seen = new Set<string>();
      top = llm.ranking
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
            why: r.why,
            strengths: r.strengths,
            concerns: r.concerns,
            preScore,
          };
        })
        .slice(0, limit);
    } else {
      top = preRanked.slice(0, limit).map((c) => {
        const { card: _card, preScore, ...rest } = c;
        return {
          ...rest,
          score: preScore,
          scoreSource: 'deterministic',
          verdict: null,
          why: null,
          strengths: [],
          concerns: [],
          preScore,
        };
      });
    }

    const dataQuality: string[] = [];
    if (!scannedAll) {
      dataQuality.push(
        'The pipeline has more than 300 candidates; only the first 300 were scanned. Narrow with the stage filter to cover a specific slice completely.',
      );
    }
    if (active.length > toHydrate.length) {
      dataQuality.push(
        `${active.length - toHydrate.length} active candidate(s) did not get a deep profile look (cap of ${maxProfiles}, prioritized by stage progress + recent activity) — early-stage, long-quiet candidates are the ones most likely skipped. Raise maxProfiles to widen the sweep.`,
      );
    }
    if (profileErrors > 0) {
      dataQuality.push(`${profileErrors} profile(s) failed to load and were left out.`);
    }
    if (hydrated.length > llmPool.length) {
      dataQuality.push(
        `The AI evaluation compared the ${llmPool.length} strongest by evidence; ${hydrated.length - llmPool.length} weaker profile(s) were ranked by evidence only.`,
      );
    }
    if (llmError) {
      dataQuality.push(
        'AI insights unavailable for this call (the evaluation model failed) — this is the deterministic evidence ranking only. Verdicts, strengths and concerns are missing, not zero.',
      );
    }
    dataQuality.push(
      llm
        ? 'Scores, verdicts, strengths and concerns are Zipdev AI output computed just now over live Workable data — not ATS fields and not client feedback. `evidence` lines are deterministic and verifiable in the profile.'
        : 'This ranking is deterministic keyword/date evidence computed live from Workable — not ATS fields and not client feedback.',
    );

    const meta = {
      fetchedAt: new Date().toISOString(),
      poolSize: pool.length,
      activeCandidates: active.length,
      profilesLoaded: hydrated.length,
      profileErrors,
      apiCalls,
      aiRanking: { used: !!llm, model: llm ? RANKING_MODEL() : null },
      source: {
        system: 'Workable ATS (live, SPI v3)',
        endpoint: '/jobs/:shortcode + /candidates?shortcode= + /candidates/:id',
      },
      dataQuality,
    };

    const verdictLabel: Record<string, string> = {
      strong_match: 'strong match',
      good_match: 'good match',
      possible: 'possible',
      weak: 'weak',
    };
    const lines: string[] = [];
    lines.push(
      `**Top ${top.length} for "${job?.title ?? input.shortcode}"** — live from Workable (${active.length} active in pipeline, ${hydrated.length} profiles deep-checked${llm ? ', AI-evaluated in one pass' : ''})`,
    );
    lines.push('');
    if (!top.length) {
      lines.push('_No active candidates found for this job._');
    }
    top.forEach((c, i) => {
      lines.push(
        `${i + 1}. **${c.name}** — ${Math.round(c.score)}/100${c.verdict ? ` · ${verdictLabel[c.verdict] ?? c.verdict}` : ''}${c.stage ? ` · stage ${c.stage}` : ''}`,
      );
      if (c.why) lines.push(`   - Why: ${c.why}`);
      if (c.strengths?.length) lines.push(`   - Strengths: ${c.strengths.join('; ')}`);
      if (c.concerns?.length) lines.push(`   - Concerns: ${c.concerns.join('; ')}`);
      for (const e of c.evidence) lines.push(`   - Evidence: ${e}`);
    });
    if (llm?.poolInsight) {
      lines.push('');
      lines.push(`**Pool insight:** ${llm.poolInsight}`);
    }
    lines.push('');
    lines.push(
      `_source: Workable ATS live · read ${meta.fetchedAt}${llm ? ` · AI evaluation: one batched pass (${RANKING_MODEL()})` : ' · deterministic evidence ranking'}_`,
    );
    for (const note of dataQuality) lines.push(`> ⚠️ ${note}`);

    return {
      job: {
        shortcode: input.shortcode,
        title: job?.title ?? null,
        state: job?.state ?? null,
      },
      candidates: top,
      poolInsight: llm?.poolInsight ?? null,
      meta,
      markdown: lines.join('\n'),
    };
  },
});
