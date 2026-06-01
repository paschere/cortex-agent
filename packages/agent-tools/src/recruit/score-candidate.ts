import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

function fmtScore(s: unknown): string {
  return typeof s === 'number' ? `${Math.round(s)}` : 'N/A';
}

export const scoreCandidate = registerTool({
  id: 'recruit.score_candidate',
  description:
    "Get a candidate's AI match score. If a jobId is provided, returns the versioned scores for that candidate's application to that job (per-source contributions, confidence, rationale, and whether a fresh score version is available). If no jobId is provided, returns the candidate's scores across all their job applications. Use this when a user asks 'how good is this candidate', 'what's the score for X on job Y', or wants a candidate's match rationale.",
  inputSchema: z.object({
    candidateId: z.string().min(1),
    jobId: z.string().optional(),
  }),
  outputSchema: z.object({
    score: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    if (input.jobId) {
      const data = await matcherFetch(
        `/api/candidates/${input.candidateId}/score-versions?jobId=${encodeURIComponent(input.jobId)}`,
      );
      const d = data?.data ?? {};
      const versions: any[] = Array.isArray(d.versions) ? d.versions : [];
      const lines: string[] = [];
      lines.push(`**Score for candidate \`${input.candidateId}\` on job \`${input.jobId}\`**`);
      lines.push('');
      lines.push(`- Current score: **${fmtScore(d.currentScore)}** (version ${d.currentVersion ?? 'N/A'})`);
      if (d.newVersionAvailable) {
        lines.push(`- A newer score version is available: ${d.newVersionReason ?? 'new data'}`);
      }
      if (versions.length) {
        const latest = versions[0];
        if (latest?.confidenceLevel) lines.push(`- Confidence: ${latest.confidenceLevel}`);
        const c = latest?.contributions;
        if (c) {
          lines.push(
            `- Contributions: workable ${fmtScore(c.workable)}, testGorilla ${fmtScore(c.testGorilla)}, interviews ${fmtScore(c.interviews)}, recruiterRatings ${fmtScore(c.recruiterRatings)}`,
          );
        }
        if (latest?.executiveSummary) lines.push(`\n${latest.executiveSummary}`);
        else if (latest?.rationale) lines.push(`\n${latest.rationale}`);
      }
      return { score: data, markdown: lines.join('\n') };
    }

    // No jobId: summarize combinedScore across the candidate's applications.
    const data = await matcherFetch(`/api/candidates/${input.candidateId}`);
    const apps: any[] = Array.isArray(data?.applications) ? data.applications : [];
    const name = data?.name ?? (`${data?.firstName ?? ''} ${data?.lastName ?? ''}`.trim() || input.candidateId);
    const lines: string[] = [];
    lines.push(`**Scores for ${name}** (\`${input.candidateId}\`)`);
    lines.push('');
    if (!apps.length) {
      lines.push('No job applications found for this candidate.');
    } else {
      lines.push('| Job | Company | Status | Score |');
      lines.push('| --- | --- | --- | --- |');
      for (const a of apps) {
        lines.push(
          `| ${a.jobTitle ?? 'N/A'} | ${a.company ?? 'N/A'} | ${a.status ?? 'N/A'} | ${fmtScore(a.combinedScore)} |`,
        );
      }
      lines.push('');
      lines.push('_Provide a jobId for a detailed, versioned score breakdown for a specific job._');
    }
    return { score: data, markdown: lines.join('\n') };
  },
});
