import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const getRequisition = registerTool({
  id: 'recruit.get_requisition',
  description:
    'Get the full detail of a single job/requisition by its id from the zipdev-matcher recruitment system. Returns the job record (title, company, location, required skills, description, candidate count breakdown, assigned recruiter/sourcer) plus a human-readable markdown summary.',
  inputSchema: z.object({
    id: z.string().min(1),
  }),
  outputSchema: z.object({
    requisition: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input) => {
    const job = await matcherFetch(`/api/jobs/${encodeURIComponent(input.id)}`);

    const lines = [`# ${job?.title ?? '(untitled)'}${job?.company ? ` @ ${job.company}` : ''}`];
    if (job?.status) lines.push(`Status: ${job.status}`);
    if (job?.location) lines.push(`Location: ${job.location}`);
    if (typeof job?.candidates === 'number') {
      lines.push(
        `Candidates: ${job.candidates} (shortlisted ${job.shortlisted ?? 0}, pending ${job.pending ?? 0}, rejected ${job.rejected ?? 0})`,
      );
    }
    if (Array.isArray(job?.requiredSkills) && job.requiredSkills.length) {
      lines.push(`Required skills: ${job.requiredSkills.join(', ')}`);
    }
    if (job?.recruiterName) lines.push(`Recruiter: ${job.recruiterName}`);
    if (job?.sourcerName) lines.push(`Sourcer: ${job.sourcerName}`);
    if (job?.description) lines.push('', String(job.description));

    return { requisition: job, markdown: lines.join('\n') };
  },
});
