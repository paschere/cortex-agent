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

export const dashboardStats = registerTool({
  id: "recruit.dashboard_stats",
  description:
    "Org-wide recruitment health check in one cheap call: active candidates (and new today), open positions, AI scoring accuracy, interview success rate, presentation totals by outcome, pipeline volume by stage, and the most in-demand skills. Use it before drilling into any single requisition. " +
    'PROVENANCE: counts come from the Cortex matcher DB; "AI accuracy" and "interview success" are Cortex-computed metrics, not externally validated benchmarks — present them as internal figures and cite meta.fetchedAt.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    stats: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async () => {
    const stats = await matcherFetch("/api/dashboard/stats", { method: "GET" });

    const meta = buildMeta({
      endpoint: "/api/dashboard/stats",
      returned: 1,
      truncated: false,
      links: { matcher: matcherLink("/") },
      provenance: {
        "metrics.activeCandidates, openPositions, presentations, pipeline, topSkills": `${SOURCE.matcher} — counted live across the recruitment database`,
        "metrics.aiAccuracy": `${SOURCE.aiScoring} — Cortex's own accuracy metric, not an external benchmark`,
        "metrics.interviewSuccess": `${SOURCE.interviewAnalysis} — computed from analysed interviews`,
      },
      dataQuality: [
        "These are whole-org totals with no client or recruiter filter applied. For one client or one role, use recruit.list_requisitions or recruit.job_insights instead of dividing these numbers.",
      ],
    });

    const parts: string[] = ["### Recruitment dashboard"];
    const m = stats?.metrics;
    if (m) {
      if (m.activeCandidates)
        parts.push(
          `- Active candidates: ${m.activeCandidates.total} (new today: ${m.activeCandidates.newToday})`,
        );
      if (m.openPositions)
        parts.push(
          `- Open positions: ${m.openPositions.total} (urgent: ${m.openPositions.urgent})`,
        );
      if (m.aiAccuracy)
        parts.push(
          `- AI accuracy (Cortex-computed): ${m.aiAccuracy.percentage}%`,
        );
      if (m.interviewSuccess)
        parts.push(`- Interview success: ${m.interviewSuccess.percentage}%`);
    }
    const p = stats?.presentations;
    if (p) {
      parts.push(
        `- Presentations: ${p.total} total (pending ${p.pending}, accepted ${p.accepted}, rejected ${p.rejected})`,
      );
    }
    if (stats?.pipeline && typeof stats.pipeline === "object") {
      const stages = Object.entries(stats.pipeline)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      if (stages) parts.push(`\n**Pipeline**\n${stages}`);
    }
    if (Array.isArray(stats?.topSkills) && stats.topSkills.length) {
      const skills = stats.topSkills
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((s: any) => `${s.name} (${s.demand_count})`)
        .join(", ");
      parts.push(`\n**Top skills**: ${skills}`);
    }
    parts.push("");
    parts.push(provenanceFooter(meta));

    return { stats, meta, markdown: parts.join("\n") };
  },
});
