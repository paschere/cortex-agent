import { z } from "zod";
import { registerTool } from "../index";
import { matcherFetch } from "./client";
import {
  SOURCE,
  buildMeta,
  matcherLink,
  metaSchema,
  provenanceFooter,
} from "./shape";

function n(v: unknown): string {
  return typeof v === "number" ? `${Math.round(v * 100) / 100}` : "N/A";
}

export const jobInsights = registerTool({
  id: "recruit.job_insights",
  description:
    "Aggregate analytics for one requisition's candidate pool: the true total, how many have AI scores / interviews / recruiter ratings / TestGorilla results, the score distribution, who the top five are, and interview / TestGorilla / predictive summaries. " +
    "Use it for 'how is the pipeline for this role', 'who are the top candidates', or 'how many are ready for a decision', and use it to get the REAL pool size before quoting a number from recruit.list_candidates. " +
    'PROVENANCE: the totals and stage counts come from the matcher service DB; every score, ranking and "success probability" is Cortex AI scoring; interview figures come from AI interview analysis and test figures from TestGorilla. Attribute each to its own system — none of it is Workable ATS data or client feedback — and cite meta.fetchedAt for freshness.',
  inputSchema: z.object({
    jobId: z.string().min(1),
  }),
  outputSchema: z.object({
    insights: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const data = await matcherFetch(
      `/api/jobs/${encodeURIComponent(input.jobId)}/insights`,
    );
    const s = data?.stats ?? {};
    const sr = s.scoreRanges ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const top: any[] = Array.isArray(s.topCandidates) ? s.topCandidates : [];

    const meta = buildMeta({
      endpoint: `/api/jobs/${input.jobId}/insights`,
      returned: Number(s.totalCandidates ?? 0),
      truncated: false,
      links: { matcher: matcherLink(`/jobs/${input.jobId}`) },
      provenance: {
        "totalCandidates, candidatesWith*": `${SOURCE.matcher} — counted live from the job's application rows`,
        "scoreRanges, topCandidates[].score, predictions.*": `${SOURCE.aiScoring} — derived, never an ATS field`,
        "interviews.*": SOURCE.interviewAnalysis,
        "testGorilla.*": `${SOURCE.testGorilla} — joined to candidates by email`,
        "readyForDecision, needingAttention": `${SOURCE.matcher} — heuristics over the above (score ≥ 70 with / without an interview)`,
      },
      dataQuality: [
        '"Ready for decision" and "needing attention" are thresholds computed by the matcher (score ≥ 70, interview present or not) — not a recruiter\'s judgement.',
        ...(Number(s.candidatesWithAI ?? 0) < Number(s.totalCandidates ?? 0)
          ? [
              `${Number(s.totalCandidates ?? 0) - Number(s.candidatesWithAI ?? 0)} candidate(s) in this pool have no AI score, so score-based figures cover only part of the pipeline.`,
            ]
          : []),
      ],
    });

    const lines: string[] = [];
    lines.push(`**Pipeline insights for requisition \`${input.jobId}\`**`);
    lines.push("");
    lines.push(`- Total candidates: **${n(s.totalCandidates)}**`);
    lines.push(
      `- With AI score: ${n(s.candidatesWithAI)} | with interviews: ${n(s.candidatesWithInterviews)} | with ratings: ${n(s.candidatesWithRatings)} | with TestGorilla: ${n(s.candidatesWithTestGorilla)}`,
    );
    lines.push(
      `- Ready for decision: ${n(s.readyForDecision)} | needing attention: ${n(s.needingAttention)}`,
    );
    lines.push(
      `- Score ranges: excellent ${n(sr.excellent)}, good ${n(sr.good)}, average ${n(sr.average)}, below avg ${n(sr.belowAverage)}`,
    );
    if (s.interviews) {
      lines.push(
        `- Interviews: ${n(s.interviews.total)} total, avg score ${n(s.interviews.avgScore)}`,
      );
    }
    if (s.predictions) {
      lines.push(
        `- Avg success probability: ${n(s.predictions.avgSuccessProbability)}`,
      );
    }
    if (top.length) {
      lines.push("");
      lines.push("**Top candidates** (Cortex AI scoring):");
      lines.push(
        "| # | Name | Score | Interviews | TestGorilla | Recommendation |",
      );
      lines.push("| --- | --- | --- | --- | --- | --- |");
      top.forEach((c, i) => {
        lines.push(
          `| ${i + 1} | ${c.name ?? "N/A"} | ${n(c.score)} | ${c.hasInterviews ? "yes" : "no"} | ${c.hasTestGorilla ? "yes" : "no"} | ${c.interviewRecommendation ?? "N/A"} |`,
        );
      });
    }
    lines.push("");
    lines.push(provenanceFooter(meta));

    return { insights: data, meta, markdown: lines.join("\n") };
  },
});
