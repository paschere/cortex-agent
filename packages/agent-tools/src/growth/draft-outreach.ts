import { z } from 'zod';
import { registerTool } from '../index';

export function buildOutreachDraft(input: {
  company: string;
  contactName?: string;
  offer: string;
  opportunityNeed: string;
  buyingSignal: string;
  evidenceUrl: string;
  tone?: 'direct' | 'consultative';
}) {
  const greeting = input.contactName?.trim() ? `Hola ${input.contactName.trim()},` : 'Hola,';
  const bridge =
    input.tone === 'direct'
      ? 'Por eso te escribo.'
      : 'Quería preguntarte si esto ya es una prioridad para ustedes.';
  return {
    subject: `${input.company}: ${input.opportunityNeed}`,
    body: `${greeting}\n\nVi esta señal pública sobre ${input.company}: ${input.buyingSignal} (${input.evidenceUrl}). ${bridge}\n\nAyudamos con ${input.offer}. Si tiene sentido, puedo compartirte una idea concreta para ${input.opportunityNeed}.\n\nSaludos,`,
    requiresReview: true as const,
    sent: false as const,
  };
}

export const growthDraftOutreach = registerTool({
  id: 'growth.draft_outreach',
  description:
    'Prepare an industry-neutral outreach draft grounded in the configured offer, opportunity need, buying signal and evidence URL. Returns text for human review only. It has no recipient field, does not call Gmail, and never sends or starts a campaign.',
  inputSchema: z.object({
    company: z.string().min(2),
    contactName: z.string().optional(),
    offer: z.string().min(2),
    opportunityNeed: z.string().min(2),
    buyingSignal: z.string().min(2),
    evidenceUrl: z.string().url(),
    tone: z.enum(['direct', 'consultative']).default('consultative'),
  }),
  outputSchema: z.object({
    subject: z.string(),
    body: z.string(),
    requiresReview: z.literal(true),
    sent: z.literal(false),
  }),
  handler: async (input) => buildOutreachDraft(input),
});
