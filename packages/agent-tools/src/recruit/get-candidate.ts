import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const getCandidate = registerTool({
  id: 'recruit.get_candidate',
  description:
    'Get full detail of a single candidate by candidateId from the zipdev-matcher recruitment system. Returns profile, skills, all job applications with scores, score history, recruiter ratings, AI insights and recent activity, plus a human-readable markdown summary.',
  inputSchema: z.object({
    candidateId: z.string().min(1),
  }),
  outputSchema: z.object({
    candidate: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input) => {
    const c = await matcherFetch(`/api/candidates/${encodeURIComponent(input.candidateId)}`);

    const name = c?.name ?? [c?.firstName, c?.lastName].filter(Boolean).join(' ') ?? '(unnamed)';
    const lines = [`# ${name || '(unnamed)'}`];
    if (c?.email) lines.push(`Email: ${c.email}`);
    if (c?.phone) lines.push(`Phone: ${c.phone}`);
    if (typeof c?.totalExperienceYears === 'number') {
      lines.push(`Experience: ${c.totalExperienceYears} year(s)`);
    }
    if (Array.isArray(c?.skills) && c.skills.length) {
      lines.push(`Skills: ${c.skills.map((s: any) => s?.name ?? s).filter(Boolean).join(', ')}`);
    }
    if (Array.isArray(c?.applications) && c.applications.length) {
      lines.push('', `Applications (${c.applications.length}):`);
      for (const a of c.applications) {
        const score = typeof a?.combinedScore === 'number' ? ` — score ${a.combinedScore}` : '';
        lines.push(`- ${a?.jobTitle ?? a?.jobId ?? '(job)'}${a?.status ? ` [${a.status}]` : ''}${score}`);
      }
    }

    return { candidate: c, markdown: lines.join('\n') };
  },
});
