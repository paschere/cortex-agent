import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

interface Summary {
  id: string;
  name: string;
  topSkills: string[];
  experienceYears: number | null;
  score: number | null;
  seniority: string;
  english: string;
  timezone: string;
  summary: string;
}

function bestScore(data: any, jobId?: string): number | null {
  const apps: any[] = Array.isArray(data?.applications) ? data.applications : [];
  if (!apps.length) return null;
  const relevant = jobId ? apps.filter((a) => a.jobId === jobId) : apps;
  const pool = relevant.length ? relevant : apps;
  const scores = pool.map((a) => a.combinedScore).filter((s) => typeof s === 'number') as number[];
  return scores.length ? Math.max(...scores) : null;
}

function summarize(data: any, id: string, jobId?: string): Summary {
  const name = data?.name ?? (`${data?.firstName ?? ''} ${data?.lastName ?? ''}`.trim() || id);
  const skills: any[] = Array.isArray(data?.skills) ? data.skills : [];
  const topSkills = skills.map((s) => s?.name).filter(Boolean).slice(0, 8);
  const exp = typeof data?.totalExperienceYears === 'number' ? data.totalExperienceYears : null;
  const score = bestScore(data, jobId);
  // english / timezone / seniority are not part of the candidate-detail contract — report N/A rather than fabricate.
  const apps: any[] = Array.isArray(data?.applications) ? data.applications : [];
  const ins = apps.map((a) => a?.insights).find((i) => i?.executiveSummary);
  const summary = ins?.executiveSummary ?? data?.extractedData?.summary ?? '';
  return {
    id,
    name,
    topSkills,
    experienceYears: exp,
    score,
    seniority: 'N/A',
    english: 'N/A',
    timezone: 'N/A',
    summary: typeof summary === 'string' ? summary : '',
  };
}

export const compareCandidates = registerTool({
  id: 'recruit.compare_candidates',
  description:
    "Compare two or more candidates side by side: skills, years of experience, AI match score, seniority, English, and timezone (the latter shown as N/A when the source data does not provide them), plus a short recommendation of the strongest candidate. Optionally scope the score to a specific jobId. Use when a user asks to 'compare', 'who is better between', or 'rank these candidates'.",
  inputSchema: z.object({
    candidateIds: z.array(z.string().min(1)).min(2).max(8),
    jobId: z.string().optional(),
  }),
  outputSchema: z.object({
    candidates: z.array(z.any()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input) => {
    const pairs = await Promise.all(
      input.candidateIds.map(async (id) => ({ id, data: await matcherFetch(`/api/candidates/${id}`) })),
    );
    const summaries = pairs.map(({ id, data }) => summarize(data, id, input.jobId));

    const lines: string[] = [];
    lines.push(
      `**Candidate comparison${input.jobId ? ` (job \`${input.jobId}\`)` : ''}**`,
    );
    lines.push('');
    lines.push('| Candidate | Score | Experience | Top skills | Seniority | English | Timezone |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of summaries) {
      lines.push(
        `| ${s.name} | ${s.score != null ? Math.round(s.score) : 'N/A'} | ${s.experienceYears != null ? `${s.experienceYears}y` : 'N/A'} | ${s.topSkills.length ? s.topSkills.join(', ') : 'N/A'} | ${s.seniority} | ${s.english} | ${s.timezone} |`,
      );
    }

    // Recommendation: highest score, then most experience as tiebreaker.
    const ranked = [...summaries].sort((a, b) => {
      const sa = a.score ?? -1;
      const sb = b.score ?? -1;
      if (sb !== sa) return sb - sa;
      return (b.experienceYears ?? -1) - (a.experienceYears ?? -1);
    });
    const top = ranked[0];
    lines.push('');
    if (top && (top.score != null || top.experienceYears != null)) {
      const reason =
        top.score != null
          ? `highest match score (${Math.round(top.score)})`
          : `most experience (${top.experienceYears}y)`;
      lines.push(`**Recommendation:** ${top.name} stands out — ${reason}.`);
      if (top.summary) lines.push(`\n${top.summary}`);
    } else {
      lines.push('**Recommendation:** Not enough scored data to confidently rank these candidates.');
    }

    return { candidates: summaries, markdown: lines.join('\n') };
  },
});
