import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const getPresentation = registerTool({
  id: 'recruit.get_presentation',
  description:
    "Get the latest stored candidate presentation (HTML) for a candidate, if one exists. Returns null content when no presentation has been created yet (this is normal, not an error). Read-only. Use when a user asks to 'show/view the presentation' for a candidate. To create one, use recruit.generate_presentation.",
  inputSchema: z.object({
    candidateId: z.string().min(1),
  }),
  outputSchema: z.object({
    presentation: z.any().nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input) => {
    const data = await matcherFetch(`/api/candidates/${input.candidateId}/presentation`);
    const p = data?.presentation ?? null;
    const markdown = p
      ? `**Presentation for candidate \`${input.candidateId}\`** — version ${p.version ?? 'N/A'} (created by ${p.createdBy ?? 'N/A'}, last edited by ${p.lastEditedBy ?? 'N/A'}).\n\nHTML content is ${p.htmlContent ? `available (${p.htmlContent.length} chars)` : 'empty'}. Last updated ${p.updatedAt ?? 'N/A'}.`
      : `No presentation exists yet for candidate \`${input.candidateId}\`. Use recruit.generate_presentation to create one.`;
    return { presentation: p, markdown };
  },
});
