import { z } from "zod";
import { registerTool } from "../index";
import { matcherFetch } from "./client";
import {
  SOURCE,
  buildMeta,
  matcherLink,
  metaSchema,
  provenanceFooter,
  shortSummary,
} from "./shape";

function fmtScore(s: unknown): string {
  return typeof s === "number" ? `${Math.round(s)}` : "N/A";
}

export const scoreCandidate = registerTool({
  id: "recruit.score_candidate",
  description:
    "Get a candidate's AI match score. With a jobId: the versioned score for that application — current score and version, per-source contributions (Workable profile, TestGorilla, interviews, recruiter ratings), confidence, the executive summary, and whether a fresher score version is available. Without a jobId: their score across every application. " +
    "By default only the latest version is returned in a compact form; pass includeVersionHistory to get the earlier versions, and includeRawAnalysis for the full skills/experience/fit JSON (large — only when you need to quote it). " +
    "PROVENANCE: the score itself is Cortex AI scoring, but `contributions` names the real underlying systems it was built from. Report it as an AI assessment, name the inputs, and cite `scoredAt` — a score computed weeks ago before an interview happened is stale, and meta.dataQuality will say so.",
  inputSchema: z.object({
    candidateId: z.string().min(1),
    jobId: z.string().optional(),
    includeVersionHistory: z.boolean().default(false),
    includeRawAnalysis: z.boolean().default(false),
  }),
  outputSchema: z.object({
    score: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    if (input.jobId) {
      const data = await matcherFetch(
        `/api/candidates/${encodeURIComponent(input.candidateId)}/score-versions?jobId=${encodeURIComponent(input.jobId)}`,
      );
      const d = data?.data ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const versions: any[] = Array.isArray(d.versions) ? d.versions : [];
      const latest = versions[0] ?? null;
      const summary = shortSummary(
        latest?.executiveSummary ?? latest?.rationale,
        600,
      );

      const score = {
        candidateId: input.candidateId,
        jobId: input.jobId,
        currentScore: d.currentScore ?? null,
        currentVersion: d.currentVersion ?? null,
        newVersionAvailable: !!d.newVersionAvailable,
        newVersionReason: d.newVersionReason ?? null,
        confidence: latest?.confidenceLevel ?? null,
        scoredAt: latest?.createdAt ?? null,
        contributions: latest?.contributions ?? null,
        summary: summary.text || null,
        summaryTruncated: summary.truncated,
        versionCount: versions.length,
        ...(input.includeVersionHistory
          ? {
              versions: versions.map((v) => ({
                version: v?.version ?? null,
                score: v?.score ?? null,
                createdAt: v?.createdAt ?? null,
                confidenceLevel: v?.confidenceLevel ?? null,
                versionReason: v?.versionReason ?? null,
              })),
            }
          : {}),
        ...(input.includeRawAnalysis ? { rawLatestVersion: latest } : {}),
        source: {
          origin: SOURCE.aiScoring,
          readFrom: SOURCE.matcher,
          lastUpdatedAt: latest?.createdAt ?? null,
        },
        links: {
          matcher: matcherLink(`/candidates/${input.candidateId}`),
          job: matcherLink(`/jobs/${input.jobId}`),
        },
      };

      const meta = buildMeta({
        endpoint: `/api/candidates/${input.candidateId}/score-versions`,
        returned: 1,
        truncated: !input.includeVersionHistory && versions.length > 1,
        provenance: {
          currentScore: `${SOURCE.aiScoring} — derived, never an ATS field`,
          "contributions.workable": `${SOURCE.workable} — profile signal feeding the score`,
          "contributions.testGorilla": SOURCE.testGorilla,
          "contributions.interviews": SOURCE.interviewAnalysis,
          "contributions.recruiterRatings": SOURCE.recruiterRatings,
        },
        dataQuality: [
          ...(d.newVersionAvailable
            ? [
                `A newer score version is available (${d.newVersionReason ?? "new data has arrived"}), so the score below is out of date until it is recomputed.`,
              ]
            : []),
          ...(versions.length > 1 && !input.includeVersionHistory
            ? [
                `${versions.length - 1} earlier score version(s) were omitted; pass includeVersionHistory to see them.`,
              ]
            : []),
        ],
      });

      const lines: string[] = [];
      lines.push(
        `**AI match score — candidate \`${input.candidateId}\` on requisition \`${input.jobId}\`**`,
      );
      lines.push("");
      lines.push(
        `- Score: **${fmtScore(score.currentScore)}** (version ${score.currentVersion ?? "N/A"}${score.confidence ? `, confidence ${score.confidence}` : ""})`,
      );
      if (score.scoredAt) lines.push(`- Computed: ${score.scoredAt}`);
      const c = score.contributions;
      if (c) {
        lines.push(
          `- Built from: Workable profile ${fmtScore(c.workable)} · TestGorilla ${fmtScore(c.testGorilla)} · interviews ${fmtScore(c.interviews)} · recruiter ratings ${fmtScore(c.recruiterRatings)}`,
        );
      }
      if (score.summary) {
        lines.push("");
        lines.push(score.summary);
      }
      lines.push("");
      lines.push(provenanceFooter(meta));

      return { score, meta, markdown: lines.join("\n") };
    }

    // No jobId: summarize the candidate's score across their applications.
    const data = await matcherFetch(
      `/api/candidates/${encodeURIComponent(input.candidateId)}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apps: any[] = Array.isArray(data?.applications)
      ? data.applications
      : [];
    const name =
      data?.name ??
      (`${data?.firstName ?? ""} ${data?.lastName ?? ""}`.trim() ||
        input.candidateId);

    const score = {
      candidateId: input.candidateId,
      name,
      applications: apps.map((a) => ({
        jobId: a?.jobId ?? null,
        jobTitle: a?.jobTitle ?? null,
        client: a?.company && a.company !== "Cortex" ? a.company : null,
        stage: a?.status ?? null,
        score: typeof a?.combinedScore === "number" ? a.combinedScore : null,
        aiMatchScore: a?.insights?.overallMatchScore ?? null,
        scoredAt: a?.scoreHistory?.[0]?.calculatedAt ?? null,
      })),
      source: {
        origin: SOURCE.aiScoring,
        readFrom: SOURCE.matcher,
        profileUpdatedAt: data?.updatedAt ?? null,
      },
      links: { matcher: matcherLink(`/candidates/${input.candidateId}`) },
    };

    const meta = buildMeta({
      endpoint: `/api/candidates/${input.candidateId}`,
      returned: apps.length,
      truncated: false,
      provenance: {
        "applications[].score, aiMatchScore": `${SOURCE.aiScoring} — derived, never an ATS field`,
        "applications[].stage": `${SOURCE.matcher} — pipeline state maintained by recruiters`,
      },
      dataQuality: [
        "Cross-job scores are not comparable head-to-head: each is computed against a different requisition. Pass a jobId for the versioned breakdown that explains one of them.",
      ],
    });

    const lines: string[] = [];
    lines.push(`**AI match scores for ${name}** (\`${input.candidateId}\`)`);
    lines.push("");
    if (!score.applications.length) {
      lines.push("No job applications found for this candidate.");
    } else {
      lines.push("| Job | Client | Stage | Score | Computed |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const a of score.applications) {
        lines.push(
          `| ${a.jobTitle ?? "N/A"} | ${a.client ?? "_unlinked_"} | ${a.stage ?? "N/A"} | ${fmtScore(a.score)} | ${typeof a.scoredAt === "string" ? a.scoredAt.slice(0, 10) : "—"} |`,
        );
      }
    }
    lines.push("");
    lines.push(provenanceFooter(meta));

    return { score, meta, markdown: lines.join("\n") };
  },
});
