import { z } from "zod";
import { registerTool } from "../index";
import { internalFetch, matcherFetch, qs } from "./client";
import {
  type ToolMeta,
  buildMeta,
  candidateFromLegacy,
  metaFromServer,
  metaSchema,
  provenanceFooter,
} from "./shape";

const MAX_LIMIT = 50;

function score(v: unknown): string {
  return typeof v === "number" ? String(Math.round(v)) : "—";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(
  candidates: any[],
  jobLabel: string,
  meta: ToolMeta,
): string {
  if (candidates.length === 0) {
    return [
      `No candidates matched for ${jobLabel}.`,
      "",
      provenanceFooter(meta),
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push(
    `**${candidates.length} candidate(s) for ${jobLabel}** (ranked by AI match score)`,
  );
  lines.push("");
  lines.push(
    "| # | Candidate | Stage | Score | Exp | Interviews | Ratings | TestGorilla |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  candidates.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.name ?? "(unnamed)"} | ${c.stage ?? "—"} | ${score(c.scores?.combined)} | ${c.experienceYears != null ? `${c.experienceYears}y` : "—"} | ${c.signals?.interviews?.count ?? 0} | ${c.signals?.recruiterRatings?.count ?? 0} | ${c.signals?.testGorilla?.tests ?? 0} |`,
    );
  });
  lines.push("");
  lines.push(provenanceFooter(meta));
  return lines.join("\n");
}

export const listCandidates = registerTool({
  id: "recruit.list_candidates",
  description:
    "List the candidate pool for one requisition, ranked by AI match score. Each row is decision-grade and small: name, pipeline stage, combined + AI score with confidence, years of experience, top skills, interview / recruiter-rating / TestGorilla signal counts, a 240-character AI summary, and applied / last-activity dates. Resumes and raw analysis JSON are never returned — use recruit.get_candidate for one person. " +
    "Capped at 50 per call (default 15). ALWAYS check meta.totalAvailable and meta.truncated: pools routinely run to hundreds of candidates, and the old behaviour of silently showing ten of them was misleading. Page with offset, or narrow with stage / minScore. " +
    "Filters: stage (SOURCED, APPLIED, SOURCER_SCREENER, ASSESSMENT, RECRUITER_INTERVIEW, CLIENT_MANAGER, PRE_OFFER, OFFER, HIRED, REJECTED, WITHDRAWN), minScore, includeDisqualified, sort (score | stage | recent). " +
    "PROVENANCE: `scores.*` and `summary` are Cortex AI output — attribute them that way and never as Workable ATS data. `signals.*` name their own systems (interview analysis, recruiter ratings, TestGorilla), and `source` / `links` show where each person came from and where to verify them. Report the pool size and the freshness alongside any ranking you give.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    stage: z.string().optional(),
    minScore: z.number().min(0).max(100).optional(),
    includeDisqualified: z.boolean().default(false),
    sort: z.enum(["score", "stage", "recent"]).default("score"),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(15),
    offset: z.number().int().min(0).default(0),
  }),
  outputSchema: z.object({
    candidates: z.array(z.any()),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    // zod `.default()` is applied at parse time, so the handler's input type
    // still marks these optional — pin them once here.
    const limit = input.limit ?? 15;
    const offset = input.offset ?? 0;
    const query = qs({
      jobId: input.jobId,
      stage: input.stage,
      minScore: input.minScore,
      includeDisqualified: input.includeDisqualified,
      sort: input.sort,
      limit,
      offset,
    });

    const lean = await internalFetch<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candidates: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      meta: any;
    }>(`/api/internal/recruit/candidates${query}`);

    if (lean.available) {
      const meta = metaFromServer(
        lean.data.meta,
        "/api/internal/recruit/candidates",
      );
      const label = lean.data.job?.title
        ? `"${lean.data.job.title}"`
        : `job ${input.jobId}`;
      return {
        candidates: lean.data.candidates,
        meta,
        markdown: renderMarkdown(lean.data.candidates, label, meta),
      };
    }

    // Fallback: the fat public list — measured at 341 KB for ten candidates,
    // 99% of it resume text, extracted-profile JSON and raw scoring rationale.
    // Project it down here so none of that reaches the model.
    const data = await matcherFetch(
      `/api/candidates?jobId=${encodeURIComponent(input.jobId)}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: any[] = Array.isArray(data) ? data : (data?.candidates ?? []);
    if (input.stage) {
      const s = input.stage.toUpperCase();
      raw = raw.filter((c) => String(c?.status ?? "").toUpperCase() === s);
    }
    if (input.minScore != null) {
      raw = raw.filter(
        (c) =>
          typeof c?.matchScore === "number" && c.matchScore >= input.minScore!,
      );
    }
    const totalAvailable = raw.length;
    const page = raw
      .slice(offset, offset + limit)
      .map((c) => candidateFromLegacy(c, input.jobId));

    const meta = buildMeta({
      endpoint: "/api/candidates",
      degraded: true,
      degradedReason: lean.reason,
      totalAvailable,
      returned: page.length,
      limit,
      offset,
      truncated: offset + page.length < totalAvailable,
      sort: input.sort,
      provenance: {
        "name, email, topSkills, experienceYears":
          "Workable ATS / Matcher service DB — imported profile data",
        "stage, appliedAt":
          "Matcher service DB — pipeline state maintained by recruiters",
        "scores.*, summary": "Cortex AI scoring — derived, never an ATS field",
      },
      dataQuality: [
        "This endpoint returns only the top slice of the pool and does not report the true pool size, so meta.totalAvailable counts what it returned, NOT how many candidates the job actually has. Use recruit.job_insights for the real total before quoting a number.",
      ],
    });

    return {
      candidates: page,
      meta,
      markdown: renderMarkdown(page, `job ${input.jobId}`, meta),
    };
  },
});
