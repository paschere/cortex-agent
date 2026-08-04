import { z } from "zod";
import { BASE } from "./client";

/**
 * Shared response shaping for the recruit tools.
 *
 * Two jobs:
 *
 * 1. PROVENANCE. Every recruit tool returns `meta` — where the data came from,
 *    when it was read, how stale the underlying row is, and what about it is
 *    untrustworthy. Cortex quotes these numbers to recruiters, so "329 candidates"
 *    has to be traceable to a system and a timestamp, and AI-derived scores must
 *    never be passed off as ATS facts.
 *
 * 2. SIZE. The matcher's public endpoints return prose-heavy records (the job
 *    list was 308 KB for 57 requisitions, 85% of it job descriptions; the
 *    candidate list 341 KB for 10 people, 99% of it resumes and raw analysis
 *    JSON). When the lean `/api/internal/recruit/*` endpoints are unavailable
 *    the tools still fall back to those, but they project them into the SAME
 *    lean shape here, client-side, so the model never sees the bulk.
 */

/** Real systems behind the matcher's data — keep in sync with the matcher's
 *  lib/internal/recruit-provenance.ts. Never invent a label. */
export const SOURCE = {
  workable: "Workable ATS",
  matcher: "Matcher service DB",
  aiScoring: "Cortex AI scoring",
  testGorilla: "TestGorilla",
  interviewAnalysis: "Interview analysis (AI)",
  recruiterRatings: "Recruiter ratings (human)",
} as const;

/**
 * The matcher substitutes the operating company's own name for `company` when
 * an application's job has no client linked. That name is a placeholder, not an
 * account, so reporting it back as a client would invent a customer.
 *
 * It is data we RECEIVE, so the label depends on the upstream deployment rather
 * than on anything this codebase can know — hence `MATCHER_UNLINKED_COMPANY`.
 * Unset means no name is filtered, which is why it must be configured wherever
 * the matcher fills the field in.
 */
export function clientOrNull(company: unknown): string | null {
  if (typeof company !== "string" || !company.trim()) return null;
  const placeholder = process.env.MATCHER_UNLINKED_COMPANY?.trim();
  return placeholder && company === placeholder ? null : company;
}

export const metaSchema = z
  .object({
    fetchedAt: z.string(),
    source: z.any(),
    dataQuality: z.array(z.string()),
  })
  .passthrough();

export type ToolMeta = z.infer<typeof metaSchema>;

export interface MetaInput {
  endpoint: string;
  /** True when we had to use the fat public endpoint instead of the lean one. */
  degraded?: boolean;
  degradedReason?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Build a `meta` block for a tool response. */
export function buildMeta(input: MetaInput): ToolMeta {
  const { endpoint, degraded, degradedReason, ...rest } = input;
  const dataQuality: string[] = Array.isArray(rest.dataQuality)
    ? [...rest.dataQuality]
    : [];
  if (degraded) {
    dataQuality.unshift(
      `Served from the matcher's legacy public endpoint (${degradedReason ?? "lean endpoint unavailable"}); ` +
        "pipeline status, stage breakdowns and last-activity timestamps may be missing or approximate.",
    );
  }
  return {
    fetchedAt: new Date().toISOString(),
    source: {
      system: "Matcher service",
      baseUrl: BASE(),
      endpoint,
      mode: degraded ? "legacy-public-endpoint" : "lean-internal-endpoint",
    },
    ...rest,
    dataQuality,
  } as ToolMeta;
}

/**
 * Merge the matcher's own `meta` (it already carries provenance, cache state
 * and data-quality notes) with the tool-side framing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function metaFromServer(serverMeta: any, endpoint: string): ToolMeta {
  return {
    ...(serverMeta ?? {}),
    fetchedAt: serverMeta?.fetchedAt ?? new Date().toISOString(),
    source: {
      ...(serverMeta?.source ?? {}),
      baseUrl: BASE(),
      mode: "lean-internal-endpoint",
    },
    dataQuality: Array.isArray(serverMeta?.dataQuality)
      ? serverMeta.dataQuality
      : [],
  } as ToolMeta;
}

/**
 * One-line provenance footer for a tool's markdown, so the model has the
 * citation right next to the numbers it is about to read out loud.
 */
export function provenanceFooter(meta: ToolMeta): string {
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = meta as any;
  const bits: string[] = [];
  bits.push(
    `source: ${m.source?.system ?? "Matcher service"} (${m.source?.endpoint ?? "n/a"})`,
  );
  bits.push(`read ${meta.fetchedAt}`);
  if (m.cache?.hit) bits.push(`cached ${m.cache.ageSeconds ?? 0}s ago`);
  if (typeof m.totalAvailable === "number" && typeof m.returned === "number") {
    bits.push(`showing ${m.returned} of ${m.totalAvailable}`);
  }
  lines.push(`_${bits.join(" · ")}_`);
  if (m.truncated) {
    lines.push(
      `_More records exist — re-run with offset=${(m.offset ?? 0) + (m.returned ?? 0)} to continue._`,
    );
  }
  for (const note of meta.dataQuality ?? []) lines.push(`> ⚠️ ${note}`);
  return lines.join("\n");
}

/** Plain-text, length-capped extract of an HTML or prose field. */
export function shortSummary(
  raw: string | null | undefined,
  maxChars = 240,
): { text: string; truncated: boolean; originalChars: number } {
  if (!raw) return { text: "", truncated: false, originalChars: 0 };
  const plain = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|li|div|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxChars)
    return { text: plain, truncated: false, originalChars: raw.length };
  const cut = plain.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return {
    text: `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`,
    truncated: true,
    originalChars: raw.length,
  };
}

/**
 * The Workable account belongs to whoever runs the deployment, so there is no
 * default worth guessing: an invented subdomain would send a recruiter to a
 * stranger's ATS.
 */
const WORKABLE_SUBDOMAIN = () => process.env.WORKABLE_SUBDOMAIN?.trim() ?? "";

/**
 * `Job.workableId` holds the Workable shortcode, which keys the backend UI.
 * Null when no subdomain is configured — no link beats a wrong one.
 */
export function workableJobUrl(
  shortcode: string | null | undefined,
): string | null {
  const subdomain = WORKABLE_SUBDOMAIN();
  return shortcode && subdomain
    ? `https://${subdomain}.workable.com/backend/jobs/${shortcode}`
    : null;
}

export function matcherLink(path: string): string {
  return `${BASE().replace(/\/$/, "")}${path}`;
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

/**
 * Project a record from the legacy public /api/jobs (or /api/jobs/[id]) into
 * the lean requisition shape.
 *
 * Two traps in that payload, both handled here rather than passed on:
 *  - `status` is hardcoded to "Active" for every job by the matcher's job
 *    formatter, so it says nothing. It is reported as `atsStatus`, and the
 *    real pipeline `status` is null because the legacy endpoint doesn't carry it.
 *  - `company` falls back to a placeholder name whenever the job has no company
 *    linked (49 of 57 production requisitions), so `client` is only trusted
 *    when `companyId` is present.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requisitionFromLegacyJob(j: any): Record<string, unknown> {
  const summary = shortSummary(j?.description);
  const openedAt = j?.postedDate ?? j?.createdAt ?? null;
  const linked = !!j?.companyId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byStage: Record<string, number> = (j?.statusCounts as any) ?? {};
  return {
    id: j?.id ?? null,
    title: j?.title ?? "(untitled)",
    client: linked ? (j?.company ?? null) : null,
    clientId: j?.companyId ?? null,
    clientAttribution: linked ? "linked" : "unlinked",
    status: null,
    atsStatus: j?.status ?? null,
    archived: !!j?.archived,
    location: j?.location ?? null,
    seats: null,
    pod: null,
    budget:
      j?.budgetMin != null || j?.budgetMax != null
        ? {
            min: j?.budgetMin ?? null,
            max: j?.budgetMax ?? null,
            currency: "USD",
          }
        : null,
    openedAt,
    daysOpen: daysSince(openedAt),
    deadline: j?.deadline ?? null,
    lastActivityAt: j?.updatedAt ?? null,
    owner: {
      recruiter: j?.recruiterId
        ? { id: j.recruiterId, name: j?.recruiterName ?? null }
        : null,
      sourcer: j?.sourcerId
        ? { id: j.sourcerId, name: j?.sourcerName ?? null }
        : null,
    },
    candidates: {
      total: typeof j?.candidates === "number" ? j.candidates : 0,
      active: typeof j?.shortlisted === "number" ? j.shortlisted : null,
      hired: byStage.HIRED ?? null,
      rejected: typeof j?.rejected === "number" ? j.rejected : null,
      presentedToClient: null,
      byStage,
    },
    skills: {
      required: Array.isArray(j?.requiredSkills)
        ? j.requiredSkills.slice(0, 12)
        : [],
    },
    summary: summary.text || null,
    summaryTruncated: summary.truncated,
    descriptionChars: summary.originalChars,
    matching: {
      syncStatus: j?.syncStatus ?? null,
      syncProgress: null,
      lastCompletedAt: null,
    },
    source: {
      origin: j?.workableId ? SOURCE.workable : SOURCE.matcher,
      readFrom: SOURCE.matcher,
      workableShortcode: j?.workableId ?? null,
      syncedAt: j?.lastSynced ?? null,
      synced: !!j?.synced,
      lastUpdatedAt: j?.updatedAt ?? null,
    },
    links: {
      matcher: j?.id ? matcherLink(`/jobs/${j.id}`) : null,
      workable: workableJobUrl(j?.workableId),
    },
  };
}

/**
 * Project a record from the legacy public /api/candidates?jobId= into the lean
 * candidate shape — dropping `resumeText`, `extractedData`, `insights` and
 * `llmRationale`, which together were 99% of that payload.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function candidateFromLegacy(
  c: any,
  jobId: string,
): Record<string, unknown> {
  const summary = shortSummary(
    c?.insights?.executiveSummary ?? c?.llmRationale,
    240,
  );
  return {
    candidateId: c?.id ?? null,
    applicationId: null,
    name:
      c?.name ?? [c?.firstName, c?.lastName].filter(Boolean).join(" ") ?? null,
    email: c?.email ?? null,
    stage: c?.status ?? null,
    disqualified: null,
    experienceYears: c?.totalExperienceYears ?? null,
    topSkills: Array.isArray(c?.skills)
      ? c.skills
          .map((s: unknown) =>
            typeof s === "string" ? s : (s as { name?: string })?.name,
          )
          .filter(Boolean)
          .slice(0, 10)
      : [],
    scores: {
      combined: typeof c?.matchScore === "number" ? c.matchScore : null,
      initialMatch: null,
      aiMatch: c?.insights?.overallMatchScore ?? null,
      confidence: c?.insights?.confidenceLevel ?? null,
      source: SOURCE.aiScoring,
      scoredAt: null,
    },
    signals: {
      interviews: {
        count: Array.isArray(c?.interviewAnalyses)
          ? c.interviewAnalyses.length
          : 0,
        source: SOURCE.interviewAnalysis,
      },
      recruiterRatings: {
        count: Array.isArray(c?.recruiterRatings)
          ? c.recruiterRatings.length
          : 0,
        source: SOURCE.recruiterRatings,
      },
      testGorilla: {
        tests: Array.isArray(c?.testGorillaResults)
          ? c.testGorillaResults.length
          : 0,
        source: SOURCE.testGorilla,
      },
    },
    summary: summary.text || null,
    summaryTruncated: summary.truncated,
    appliedAt: c?.appliedDate ?? null,
    lastActivityAt: null,
    source: {
      origin: c?.source ?? SOURCE.matcher,
      readFrom: SOURCE.matcher,
      lastUpdatedAt: null,
    },
    links: {
      matcher: c?.id ? matcherLink(`/candidates/${c.id}`) : null,
      workable: null,
    },
    jobId,
  };
}
