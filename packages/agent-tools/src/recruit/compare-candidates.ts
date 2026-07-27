import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';
import {
  SOURCE,
  buildMeta,
  matcherLink,
  metaSchema,
  provenanceFooter,
  shortSummary,
} from './shape';

interface Summary {
  id: string;
  name: string;
  topSkills: string[];
  experienceYears: number | null;
  score: number | null;
  scoredAt: string | null;
  seniority: string;
  english: string;
  timezone: string;
  summary: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  links: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bestApplication(data: any, jobId?: string): any | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps: any[] = Array.isArray(data?.applications) ? data.applications : [];
  if (!apps.length) return null;
  const relevant = jobId ? apps.filter((a) => a.jobId === jobId) : apps;
  const pool = relevant.length ? relevant : apps;
  const scored = pool.filter((a) => typeof a.combinedScore === 'number');
  if (!scored.length) return pool[0] ?? null;
  return scored.reduce((best, a) => (a.combinedScore > best.combinedScore ? a : best));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarize(data: any, id: string, jobId?: string): Summary {
  const name = data?.name ?? (`${data?.firstName ?? ''} ${data?.lastName ?? ''}`.trim() || id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skills: any[] = Array.isArray(data?.skills) ? data.skills : [];
  const topSkills = skills
    .map((s) => s?.name)
    .filter(Boolean)
    .slice(0, 8);
  const exp = typeof data?.totalExperienceYears === 'number' ? data.totalExperienceYears : null;
  const app = bestApplication(data, jobId);
  const summary = shortSummary(
    app?.insights?.executiveSummary ?? app?.llmRationale ?? data?.extractedData?.summary,
    280,
  );
  return {
    id,
    name,
    topSkills,
    experienceYears: exp,
    score: typeof app?.combinedScore === 'number' ? app.combinedScore : null,
    scoredAt: app?.scoreHistory?.[0]?.calculatedAt ?? null,
    // seniority / english / timezone are not part of the candidate-detail
    // contract — report N/A rather than fabricate them.
    seniority: 'N/A',
    english: 'N/A',
    timezone: 'N/A',
    summary: summary.text,
    source: {
      origin: data?.workableId ? SOURCE.workable : SOURCE.matcher,
      readFrom: SOURCE.matcher,
      scoreSource: SOURCE.aiScoring,
      profileUpdatedAt: data?.updatedAt ?? null,
    },
    links: { matcher: matcherLink(`/candidates/${id}`) },
  };
}

export const compareCandidates = registerTool({
  id: 'recruit.compare_candidates',
  description:
    "Compare two to eight candidates side by side: AI match score, years of experience, top skills, and a short AI summary of the strongest one, plus seniority / English / timezone (reported as N/A — the matcher does not store them, so never fill them in from guesswork). Optionally scope the scores to one jobId so you are comparing like with like. Use for 'compare', 'who is better between', or 'rank these candidates'. " +
    "PROVENANCE: the ranking is Zipdev AI scoring, not a recruiter's or a client's judgement — say so. Scores computed against DIFFERENT requisitions are not comparable, and meta.dataQuality will tell you when that is what you are looking at; pass jobId to avoid it.",
  inputSchema: z.object({
    candidateIds: z.array(z.string().min(1)).min(2).max(8),
    jobId: z.string().optional(),
  }),
  outputSchema: z.object({
    candidates: z.array(z.any()),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input) => {
    const pairs = await Promise.all(
      input.candidateIds.map(async (id) => ({
        id,
        data: await matcherFetch(`/api/candidates/${encodeURIComponent(id)}`),
      })),
    );
    const summaries = pairs.map(({ id, data }) => summarize(data, id, input.jobId));
    const unscored = summaries.filter((s) => s.score == null).length;

    const meta = buildMeta({
      endpoint: '/api/candidates/:id',
      returned: summaries.length,
      truncated: false,
      provenance: {
        'name, topSkills, experienceYears': `${SOURCE.workable} / ${SOURCE.matcher} — imported profile`,
        'score, summary': `${SOURCE.aiScoring} — derived, never an ATS field or client feedback`,
      },
      dataQuality: [
        'Seniority, English level and timezone are not stored in the matcher and are reported as N/A — do not infer them.',
        ...(input.jobId
          ? []
          : [
              'Scores were not scoped to a single requisition, so they may have been computed against different jobs and are not strictly comparable. Pass jobId for a like-for-like ranking.',
            ]),
        ...(unscored
          ? [`${unscored} of ${summaries.length} candidates have no AI score at all.`]
          : []),
      ],
    });

    const lines: string[] = [];
    lines.push(`**Candidate comparison${input.jobId ? ` (requisition \`${input.jobId}\`)` : ''}**`);
    lines.push('');
    lines.push('| Candidate | Score | Experience | Top skills | Seniority | English | Timezone |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of summaries) {
      lines.push(
        `| ${s.name} | ${s.score != null ? Math.round(s.score) : 'N/A'} | ${s.experienceYears != null ? `${s.experienceYears}y` : 'N/A'} | ${s.topSkills.length ? s.topSkills.join(', ') : 'N/A'} | ${s.seniority} | ${s.english} | ${s.timezone} |`,
      );
    }

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
          ? `highest AI match score (${Math.round(top.score)})`
          : `most experience (${top.experienceYears}y)`;
      lines.push(`**Recommendation:** ${top.name} stands out — ${reason}.`);
      if (top.summary) lines.push(`\n${top.summary}`);
    } else {
      lines.push(
        '**Recommendation:** Not enough scored data to confidently rank these candidates.',
      );
    }
    lines.push('');
    lines.push(provenanceFooter(meta));

    return { candidates: summaries, meta, markdown: lines.join('\n') };
  },
});
