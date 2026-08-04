import { z } from "zod";
import { registerTool } from "../index";
import { matcherFetch } from "./client";
import {
  SOURCE,
  type ToolMeta,
  buildMeta,
  matcherLink,
  metaSchema,
  provenanceFooter,
  shortSummary,
} from "./shape";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(c: any, meta: ToolMeta): string {
  const lines: string[] = [];
  lines.push(`# ${c.name || "(unnamed)"}`);
  const facts: string[] = [];
  if (c.experienceYears != null) facts.push(`${c.experienceYears}y experience`);
  if (c.email) facts.push(c.email);
  if (c.phone) facts.push(c.phone);
  if (facts.length) lines.push(facts.join(" · "));
  if (Array.isArray(c.skills) && c.skills.length) {
    lines.push("");
    lines.push(`**Skills:** ${c.skills.join(", ")}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps: any[] = Array.isArray(c.applications) ? c.applications : [];
  if (apps.length) {
    lines.push("");
    lines.push(
      `**Applications (${apps.length})** — scores are Cortex AI scoring, not ATS data:`,
    );
    lines.push("| Job | Client | Stage | Score | Last activity |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const a of apps) {
      lines.push(
        `| ${a.jobTitle ?? a.jobId ?? "(job)"} | ${a.client ?? "_unlinked_"} | ${a.stage ?? "—"} | ${typeof a.score === "number" ? Math.round(a.score) : "—"} | ${typeof a.lastActivityAt === "string" ? a.lastActivityAt.slice(0, 10) : "—"} |`,
      );
    }
    const withSummary = apps.find((a) => a.summary);
    if (withSummary?.summary) {
      lines.push("");
      lines.push(
        `_AI summary (${withSummary.jobTitle ?? "latest application"}):_ ${withSummary.summary}`,
      );
    }
  }
  lines.push("");
  lines.push(provenanceFooter(meta));
  return lines.join("\n");
}

export const getCandidate = registerTool({
  id: "recruit.get_candidate",
  description:
    "Get one candidate's profile and their applications across every job: contact details, years of experience, skills, and per-application stage, AI score, score history and a short AI summary. " +
    "By default the heavy fields are omitted — resume text, the extracted-profile JSON and the raw AI analysis blocks were ~80% of this record and a model needs none of them. Set includeResumeText or includeRawInsights only if you specifically need to quote them. " +
    "PROVENANCE: profile fields come from the candidate record imported into the Cortex matcher (Workable ATS where workableId is set); every score and summary is Cortex AI scoring and must be attributed as such, never as ATS or client feedback. `source.profileUpdatedAt` tells you how fresh the profile is — cite it.",
  inputSchema: z.object({
    candidateId: z.string().min(1),
    includeResumeText: z.boolean().default(false),
    includeRawInsights: z.boolean().default(false),
  }),
  outputSchema: z.object({
    candidate: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input) => {
    const raw = await matcherFetch(
      `/api/candidates/${encodeURIComponent(input.candidateId)}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawApps: any[] = Array.isArray(raw?.applications)
      ? raw.applications
      : [];
    const applications = rawApps.map((a) => {
      const summary = shortSummary(
        a?.insights?.executiveSummary ?? a?.llmRationale,
        280,
      );
      return {
        applicationId: a?.id ?? null,
        jobId: a?.jobId ?? null,
        jobTitle: a?.jobTitle ?? null,
        // /api/candidates/:id defaults an unlinked job's company to "Cortex";
        // treat that literal as "unknown" rather than repeating it as a client.
        client: a?.company && a.company !== "Cortex" ? a.company : null,
        stage: a?.status ?? null,
        jobArchived: a?.jobArchived ?? null,
        score: typeof a?.combinedScore === "number" ? a.combinedScore : null,
        initialMatchScore: a?.initialMatchScore ?? null,
        aiMatchScore: a?.insights?.overallMatchScore ?? null,
        confidence: a?.insights?.confidenceLevel ?? null,
        summary: summary.text || null,
        summaryTruncated: summary.truncated,
        scoreHistoryPoints: Array.isArray(a?.scoreHistory)
          ? a.scoreHistory.length
          : 0,
        latestScoreAt: a?.scoreHistory?.[0]?.calculatedAt ?? null,
        recruiterRatings: Array.isArray(a?.recruiterRatings)
          ? a.recruiterRatings.length
          : 0,
        lastActivityAt: a?.scoreHistory?.[0]?.calculatedAt ?? null,
        scoreSource: SOURCE.aiScoring,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(input.includeRawInsights
          ? { rawInsights: a?.insights ?? null }
          : {}),
        links: { matcher: a?.jobId ? matcherLink(`/jobs/${a.jobId}`) : null },
      };
    });

    const candidate = {
      id: raw?.id ?? input.candidateId,
      name:
        raw?.name ?? [raw?.firstName, raw?.lastName].filter(Boolean).join(" "),
      email: raw?.email ?? null,
      phone: raw?.phone ?? null,
      experienceYears: raw?.totalExperienceYears ?? null,
      skills: Array.isArray(raw?.skills)
        ? raw.skills
            .map((s: { name?: string } | string) =>
              typeof s === "string" ? s : s?.name,
            )
            .filter(Boolean)
        : [],
      applications,
      recentActivityCount: Array.isArray(raw?.recentActivity)
        ? raw.recentActivity.length
        : 0,
      resumeChars:
        typeof raw?.resumeText === "string" ? raw.resumeText.length : 0,
      ...(input.includeResumeText
        ? { resumeText: raw?.resumeText ?? null }
        : {}),
      source: {
        origin: raw?.workableId ? SOURCE.workable : SOURCE.matcher,
        readFrom: SOURCE.matcher,
        workableCandidateId: raw?.workableId ?? null,
        profileUpdatedAt: raw?.updatedAt ?? null,
        createdAt: raw?.createdAt ?? null,
      },
      links: {
        matcher: matcherLink(`/candidates/${raw?.id ?? input.candidateId}`),
      },
    };

    const meta = buildMeta({
      endpoint: `/api/candidates/${input.candidateId}`,
      returned: 1,
      truncated: false,
      provenance: {
        "name, email, phone, skills, experienceYears": `${SOURCE.workable} / ${SOURCE.matcher} — imported profile`,
        "applications[].stage": `${SOURCE.matcher} — pipeline state maintained by recruiters`,
        "applications[].score, aiMatchScore, summary": `${SOURCE.aiScoring} — derived, never an ATS field`,
        "applications[].recruiterRatings": SOURCE.recruiterRatings,
      },
      dataQuality: [
        ...(candidate.resumeChars && !input.includeResumeText
          ? [
              `Resume text (${candidate.resumeChars} chars) and the extracted-profile JSON were omitted from this response by default; re-request with includeResumeText if you need to quote them.`,
            ]
          : []),
        ...(applications.some((a) => a.client === null)
          ? [
              'Some applications show no client because their job is not linked to a company in the matcher (the underlying API reports "Cortex" there, which is a placeholder).',
            ]
          : []),
      ],
    });

    return { candidate, meta, markdown: renderMarkdown(candidate, meta) };
  },
});
