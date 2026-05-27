export const PROMPTS = [
  {
    name: 'draft-proposal',
    description: 'Draft a complete client proposal for a Zipdev candidate role.',
    arguments: [
      { name: 'role', description: 'e.g., "frontend", "fullstack"', required: true },
      { name: 'seniority', description: 'junior | mid | senior | lead', required: true },
      { name: 'companyId', description: 'Optional HubSpot company ID for context', required: false },
    ],
  },
  {
    name: 'qualify-lead',
    description: 'Walk through qualifying a sales lead from HubSpot data.',
    arguments: [
      { name: 'dealId', description: 'HubSpot deal ID', required: true },
    ],
  },
  {
    name: 'rate-question',
    description: 'Answer a rate question by calling rate.estimate.',
    arguments: [
      { name: 'role', required: true },
      { name: 'seniority', required: true },
      { name: 'region', required: false },
    ],
  },
];

export function getPromptDefinition(
  name: string,
  args: Record<string, string>,
): {
  description: string;
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
} | null {
  switch (name) {
    case 'draft-proposal':
      return {
        description: 'Draft a complete client proposal',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Use the sales.draft_proposal tool to create a proposal for a ${args.seniority} ${args.role}${args.companyId ? ` for HubSpot company ${args.companyId}` : ''}. Pull recent deal context if available, get a rate estimate, search the KB for relevant case studies, and produce a polished markdown proposal with citations.`,
            },
          },
        ],
      };
    case 'qualify-lead':
      return {
        description: 'Qualify a sales lead',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Look up HubSpot deal ${args.dealId} (use hubspot.get_deal then hubspot.get_company on the associated company). Pull recent activities. Then summarize the qualifying signals: budget, timeline, decision-maker, fit. Cite KB sources for qualification criteria.`,
            },
          },
        ],
      };
    case 'rate-question':
      return {
        description: 'Answer a rate question',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Use rate.estimate for a ${args.seniority} ${args.role}${args.region ? ` in ${args.region}` : ' in LATAM'}. Cite the rate notes verbatim.`,
            },
          },
        ],
      };
    default:
      return null;
  }
}
