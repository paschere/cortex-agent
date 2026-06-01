import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const generatePresentation = registerTool({
  id: 'recruit.generate_presentation',
  description:
    "Generate an AI-written candidate presentation (ZIPDEV-format HTML) for a candidate, built from their skills, experience, education, and latest score insights. This CREATES/updates a stored presentation (version-bumped, createdBy='AI'). Requires confirmation because it writes data. Use when a user asks to 'create/generate a presentation' or 'write up a candidate'. To only read an existing presentation without generating, use recruit.get_presentation.",
  inputSchema: z.object({
    candidateId: z.string().min(1),
    jobId: z.string().optional(),
  }),
  outputSchema: z.object({
    presentation: z.any(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input) => {
    // Endpoint takes the candidateId path param only (no body); jobId is unused server-side.
    const data = await matcherFetch(`/api/candidates/${input.candidateId}/presentation/generate`, {
      method: 'POST',
    });
    const p = data?.presentation ?? null;
    const markdown = p
      ? `**Presentation generated for candidate \`${input.candidateId}\`** (version ${p.version ?? 'N/A'}, by ${p.lastEditedBy ?? 'AI'}).\n\nThe HTML presentation is ready (${p.htmlContent ? `${p.htmlContent.length} chars` : 'content available'}). Last updated ${p.updatedAt ?? 'just now'}.`
      : `Presentation generation for candidate \`${input.candidateId}\` returned no presentation. Response: ${JSON.stringify(data).slice(0, 200)}`;
    return { presentation: p, markdown };
  },
});
