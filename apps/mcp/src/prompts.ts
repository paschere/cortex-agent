export const PROMPTS = [
  {
    name: 'draft-proposal',
    description: 'Draft a complete client proposal for a candidate role.',
    arguments: [
      { name: 'role', description: 'e.g., "frontend", "fullstack"', required: true },
      { name: 'seniority', description: 'junior | mid | senior | lead', required: true },
      {
        name: 'companyId',
        description: 'Optional HubSpot company ID for context',
        required: false,
      },
    ],
  },
  {
    name: 'qualify-lead',
    description: 'Walk through qualifying a sales lead from HubSpot data.',
    arguments: [{ name: 'dealId', description: 'HubSpot deal ID', required: true }],
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
              text: `Use the sales.draft_proposal tool to create a proposal for a ${args.seniority} ${args.role}${args.companyId ? ` for HubSpot company ${args.companyId}` : ''}. Pull recent deal context if available, search Brain Knowledge for relevant case studies AND for the pricing used on comparable past proposals, and produce a polished markdown proposal with citations. There is no rate estimator — quote the document a number came from, or leave the pricing for the user to fill in.`,
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
              text: `Look up HubSpot deal ${args.dealId} (use hubspot.get_deal then hubspot.get_company on the associated company). Pull recent activities. Then summarize the qualifying signals: budget, timeline, decision-maker, fit. Cite Brain Knowledge sources for qualification criteria.`,
            },
          },
        ],
      };
    default:
      return null;
  }
}
