import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

function n(v: unknown): string {
  return typeof v === 'number' ? `${v}` : 'N/A';
}

export const jobInsights = registerTool({
  id: 'recruit.job_insights',
  description:
    "Get aggregated analytics for a job's candidate pool: total candidates, how many have AI scores / interviews / ratings / TestGorilla, score-range distribution, the top candidates, and interview / TestGorilla / predictive summaries. Use this to answer 'how is the pipeline for job X', 'who are the top candidates', or 'how many candidates are ready for a decision'. Also useful after recruit.find_matches to see the resulting pool.",
  inputSchema: z.object({
    jobId: z.string().min(1),
  }),
  outputSchema: z.object({
    insights: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const data = await matcherFetch(`/api/jobs/${input.jobId}/insights`);
    const s = data?.stats ?? {};
    const sr = s.scoreRanges ?? {};
    const top: any[] = Array.isArray(s.topCandidates) ? s.topCandidates : [];

    const lines: string[] = [];
    lines.push(`**Pipeline insights for job \`${input.jobId}\`**`);
    lines.push('');
    lines.push(`- Total candidates: **${n(s.totalCandidates)}**`);
    lines.push(
      `- With AI score: ${n(s.candidatesWithAI)} | with interviews: ${n(s.candidatesWithInterviews)} | with ratings: ${n(s.candidatesWithRatings)} | with TestGorilla: ${n(s.candidatesWithTestGorilla)}`,
    );
    lines.push(`- Ready for decision: ${n(s.readyForDecision)} | needing attention: ${n(s.needingAttention)}`);
    lines.push(
      `- Score ranges: excellent ${n(sr.excellent)}, good ${n(sr.good)}, average ${n(sr.average)}, below avg ${n(sr.belowAverage)}`,
    );
    if (s.interviews) {
      lines.push(`- Interviews: ${n(s.interviews.total)} total, avg score ${n(s.interviews.avgScore)}`);
    }
    if (s.predictions) {
      lines.push(`- Avg success probability: ${n(s.predictions.avgSuccessProbability)}`);
    }
    if (top.length) {
      lines.push('');
      lines.push('**Top candidates:**');
      lines.push('| # | Name | Score | Interviews | TestGorilla | Recommendation |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      top.forEach((c, i) => {
        lines.push(
          `| ${i + 1} | ${c.name ?? 'N/A'} | ${n(c.score)} | ${c.hasInterviews ? 'yes' : 'no'} | ${c.hasTestGorilla ? 'yes' : 'no'} | ${c.interviewRecommendation ?? 'N/A'} |`,
        );
      });
    }
    return { insights: data, markdown: lines.join('\n') };
  },
});
