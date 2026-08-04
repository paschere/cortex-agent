import { internalFetch } from "../recruit/client";
import { workableFetch } from "./client";

/**
 * Shared evaluation plumbing for the Workable-direct ranking tools
 * (workable.top_candidates, workable.compare_candidates).
 *
 * Everything here is deterministic evidence-building over live ATS payloads:
 * skill/term matching against the job posting, experience years derived from
 * dated work history, and stage-progress weighting. The LLM layers on top of
 * this in each tool; these helpers guarantee the evidence the model cites is
 * verifiable in the profile.
 *
 * One deliberate exception to "Workable only": TestGorilla. Those results
 * live in the matcher DB but arrive through the TestGorilla integration
 * itself (keyed by email), NOT through the stale/partial Workable sync — so
 * they are trustworthy regardless of sync state and are batched in as the
 * verified-assessment signal. If the matcher endpoint is unreachable the
 * tools proceed without it and say so.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Raw = any;

import { CHAT_MODEL } from "../model";

/** Cortex's default model; override for a cheaper or deeper read via env. */
export const RANKING_MODEL = () =>
  process.env.Cortex_RANKING_MODEL ?? CHAT_MODEL;

export const VERDICT_LABEL: Record<string, string> = {
  strong_match: "strong match",
  good_match: "good match",
  possible: "possible",
  weak: "weak",
};

export function stripHtml(s: string | null | undefined, cap = 12_000): string {
  if (!s) return "";
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Boundary-aware containment: "go" must not match "google", but "c++" and
 * "node.js" must still match. Letters/digits/+/# glue a token together; a dot
 * is a boundary ("GraphQL." at sentence end must match "graphql") yet still
 * matches inside a term because it is escaped there ("node.js").
 */
export function termInText(term: string, loweredText: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return false;
  const re = new RegExp(
    `(^|[^a-z0-9+#])${escapeRegExp(t)}($|[^a-z0-9+#])`,
    "i",
  );
  return re.test(loweredText);
}

/** Merge experience_entries date ranges into total non-overlapping years. */
export function experienceYears(entries: Raw[]): number | null {
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
export function stageProgress(stage: string | null | undefined): number {
  const s = (stage ?? "").toLowerCase();
  if (/hire/.test(s)) return 100;
  if (/offer/.test(s)) return 90;
  if (/interview|panel|onsite|final|client|manager/.test(s)) return 70;
  if (/assess|test|challenge|exercise|gorilla/.test(s)) return 55;
  if (/screen|phone|call|evaluaci/.test(s)) return 45;
  return 20; // sourced / applied / new / unknown
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "our",
  "you",
  "your",
  "per",
  "via",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "para",
  "con",
  "y",
  "o",
  "en",
  "un",
  "una",
  "jr",
  "sr",
  "mid",
  "level",
  "remote",
  "remoto",
  "latam",
]);

export function titleTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
    ),
  ];
}

/** Job posting text prepared once for matching and for the LLM prompt. */
export interface JobContext {
  title: string;
  text: string;
  textLower: string;
  tokens: string[];
}

export function buildJobContext(job: Raw, fallbackTitle: string): JobContext {
  const title = String(job?.title ?? fallbackTitle);
  const text = [
    title,
    stripHtml(job?.requirements),
    stripHtml(job?.full_description ?? job?.description),
  ].join(" ");
  return {
    title,
    text,
    textLower: text.toLowerCase(),
    tokens: titleTokens(title),
  };
}

/**
 * GET one full candidate profile, retrying once after a pause if Workable
 * answers 429 — the only place a burst of detail fetches could trip the
 * account-wide 10 req/s budget shared with the matcher's sync.
 */
export async function fetchCandidateDetail(
  candidateId: string,
  signal?: AbortSignal,
): Promise<Raw> {
  const path = `/candidates/${encodeURIComponent(candidateId)}`;
  try {
    const data: Raw = await workableFetch(path, { signal });
    return data?.candidate ?? data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/\b429\b/.test(msg)) throw err;
    await new Promise((r) => setTimeout(r, 1_200));
    const data: Raw = await workableFetch(path, { signal });
    return data?.candidate ?? data;
  }
}

export interface TestGorillaSignal {
  tests: number;
  completed: number;
  avgScore: number | null;
  results: {
    testName: string | null;
    score: number | null;
    completed: boolean;
  }[];
  lastUpdatedAt: string | null;
}

/**
 * Batch TestGorilla lookup by email against the matcher's lean endpoint.
 * Never throws: assessment signal is an enhancement, not a dependency — on
 * any failure the ranking proceeds without it and `note` explains the gap.
 */
export async function fetchTestGorillaSignals(
  emails: string[],
): Promise<{ byEmail: Map<string, TestGorillaSignal>; note: string | null }> {
  const cleaned = [
    ...new Set(
      emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")),
    ),
  ];
  if (!cleaned.length) return { byEmail: new Map(), note: null };
  try {
    const res = await internalFetch<{
      results: Record<string, TestGorillaSignal>;
    }>(
      `/api/internal/recruit/testgorilla?emails=${encodeURIComponent(cleaned.join(","))}`,
    );
    if (!res.available) {
      return {
        byEmail: new Map(),
        note: `TestGorilla scores could not be included (${res.reason}) — ranking proceeds on profile evidence only.`,
      };
    }
    return {
      byEmail: new Map(Object.entries(res.data.results ?? {})),
      note: null,
    };
  } catch (err) {
    return {
      byEmail: new Map(),
      note: `TestGorilla scores could not be included (${err instanceof Error ? err.message : String(err)}) — ranking proceeds on profile evidence only.`,
    };
  }
}

export interface EvidenceCandidate {
  id: string;
  name: string;
  email: string | null;
  headline: string | null;
  stage: string | null;
  updatedAt: string | null;
  profileUrl: string | null;
  testGorilla: TestGorillaSignal | null;
  preScore: number;
  breakdown: {
    skills: number;
    roleFit: number;
    experience: number;
    stageProgress: number;
  };
  matchedSkills: string[];
  missingMustHaves: string[];
  experienceYears: number | null;
  evidence: string[];
  /** Compact card for the batched LLM evaluation — never the full profile. */
  card: string;
}

export function buildEvidence(
  detail: Raw,
  listRow: Raw,
  jobCtx: JobContext,
  mustHaves: string[],
  testGorilla: TestGorillaSignal | null = null,
): EvidenceCandidate {
  const skills: string[] = [
    ...new Set(
      [...(detail?.skills ?? []), ...(detail?.tags ?? [])]
        .map((s: Raw) => String(typeof s === "string" ? s : (s?.name ?? "")))
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
      skills.join(" "),
      stripHtml(detail?.summary, 4_000),
      headline ?? "",
      ...experiences.map(
        (e) => `${e?.title ?? ""} ${stripHtml(e?.summary, 500)}`,
      ),
    ]
      .join(" ")
      .toLowerCase();
    matchedSkills = mustHaves.filter((m) => termInText(m, candidateText));
    missingMustHaves = mustHaves.filter((m) => !matchedSkills.includes(m));
    skillsScore = (matchedSkills.length / mustHaves.length) * 100;
    evidence.push(
      `Covers ${matchedSkills.length}/${mustHaves.length} must-have skills${matchedSkills.length ? `: ${matchedSkills.join(", ")}` : ""}${missingMustHaves.length && missingMustHaves.length <= 5 ? ` (missing: ${missingMustHaves.join(", ")})` : ""}`,
    );
  } else {
    // No curated list: count which of THEIR skills the job posting mentions.
    matchedSkills = skills.filter((s) => termInText(s, jobCtx.textLower));
    skillsScore = (Math.min(matchedSkills.length, 8) / 8) * 100;
    if (matchedSkills.length) {
      evidence.push(
        `${matchedSkills.length} of their ${skills.length} listed skills appear in the job posting: ${matchedSkills.slice(0, 8).join(", ")}${matchedSkills.length > 8 ? "…" : ""}`,
      );
    } else if (skills.length) {
      evidence.push(
        `None of their ${skills.length} listed skills appear verbatim in the job posting`,
      );
    } else {
      evidence.push(
        "No skills/tags on their Workable profile — skill match unknown",
      );
    }
  }

  // --- role fit (20%) ---
  const roleText = [
    headline ?? "",
    ...experiences.slice(0, 3).map((e) => String(e?.title ?? "")),
  ]
    .join(" ")
    .toLowerCase();
  const fitHits = jobCtx.tokens.filter((t) => termInText(t, roleText));
  const roleFit = jobCtx.tokens.length
    ? (fitHits.length / jobCtx.tokens.length) * 100
    : 0;
  if (fitHits.length) {
    evidence.push(
      `Role fit: ${headline ? `"${headline}"` : "their recent titles"} match the job title on ${fitHits.join(", ")}`,
    );
  }

  // --- experience (15%) ---
  const years = experienceYears(experiences);
  const expScore = years == null ? 0 : Math.min(years / 8, 1) * 100;
  if (years != null) {
    evidence.push(
      `≈${years} yrs experience across ${experiences.length} role(s)`,
    );
  } else {
    evidence.push(
      "No dated work history on their profile — experience length unknown",
    );
  }

  // --- pipeline progress (15%) ---
  const stage = listRow?.stage ?? detail?.stage ?? null;
  const stageScore = stageProgress(stage);
  if (stage && stageScore >= 45) {
    evidence.push(
      `Already at stage "${stage}" — the team has been advancing them`,
    );
  }

  const answers: Raw[] = Array.isArray(detail?.answers) ? detail.answers : [];
  if (answers.length > 0)
    evidence.push(`Answered ${answers.length} screening question(s)`);

  // --- TestGorilla (verified assessment — reported as evidence and weighed
  //     by the LLM; it does not move the deterministic pre-score) ---
  if (testGorilla && testGorilla.tests > 0) {
    const names = testGorilla.results
      .map((r) => r.testName)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    evidence.push(
      `TestGorilla: ${testGorilla.avgScore != null ? `avg ${testGorilla.avgScore}` : "no numeric score"} across ${testGorilla.tests} test(s)${names ? ` (${names})` : ""} — verified assessment`,
    );
  }

  const preScore =
    Math.round(
      (skillsScore * 0.5 +
        roleFit * 0.2 +
        expScore * 0.15 +
        stageScore * 0.15) *
        10,
    ) / 10;

  // The card is everything the LLM is allowed to know about this person:
  // compact, factual, no raw resume dump.
  const recentRoles = experiences
    .slice(0, 4)
    .map(
      (e) =>
        `${e?.title ?? "?"} @ ${e?.company ?? "?"} (${String(e?.start_date ?? "?").slice(0, 7)}–${e?.current ? "now" : String(e?.end_date ?? "?").slice(0, 7)})`,
    )
    .join("; ");
  const answerLines = answers
    .slice(0, 3)
    .map(
      (a: Raw) =>
        `Q: ${stripHtml(String(a?.question ?? ""), 120)} → A: ${stripHtml(String(a?.answer ?? ""), 180)}`,
    )
    .join(" | ");
  const tgLine =
    testGorilla && testGorilla.tests > 0
      ? `testgorilla (verified assessment): ${testGorilla.results
          .slice(0, 4)
          .map(
            (r) =>
              `${r.testName ?? "test"}: ${r.score != null ? r.score : "n/a"}${r.completed ? "" : " (incomplete)"}`,
          )
          .join(
            "; ",
          )}${testGorilla.avgScore != null ? ` | avg ${testGorilla.avgScore}` : ""}`
      : null;
  const card = [
    `id: ${String(detail?.id ?? listRow?.id ?? "")}`,
    `name: ${detail?.name ?? listRow?.name ?? "?"}`,
    headline ? `headline: ${headline}` : null,
    `current stage: ${stage ?? "unknown"}`,
    `skills on profile: ${skills.slice(0, 15).join(", ") || "none listed"}`,
    years != null ? `experience: ≈${years} yrs` : "experience: undated",
    recentRoles ? `recent roles: ${recentRoles}` : null,
    detail?.summary
      ? `profile summary: ${stripHtml(detail.summary, 500)}`
      : null,
    answerLines ? `screening answers: ${answerLines}` : null,
    tgLine,
    `deterministic evidence: ${evidence.join(" | ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: String(detail?.id ?? listRow?.id ?? ""),
    name:
      detail?.name ??
      listRow?.name ??
      [detail?.firstname, detail?.lastname].filter(Boolean).join(" "),
    email: detail?.email ?? listRow?.email ?? null,
    headline,
    stage,
    updatedAt: listRow?.updated_at ?? detail?.updated_at ?? null,
    profileUrl: detail?.profile_url ?? listRow?.profile_url ?? null,
    testGorilla: testGorilla && testGorilla.tests > 0 ? testGorilla : null,
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
