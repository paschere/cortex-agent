import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
});

// priority: 0 = none, 1 = urgent, 2 = high, 3 = normal, 4 = low (Linear scale).
const MUTATION = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        title
        url
      }
    }
  }
`;

export const createIssue = registerTool({
  id: 'linear.create_issue',
  description:
    'Create a Linear issue on a team. priority: 0=none, 1=urgent, 2=high, 3=normal, 4=low. Use linear.list_teams to find the teamId.',
  inputSchema: z.object({
    teamId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    assigneeId: z.string().optional(),
    priority: z.number().int().min(0).max(4).optional(),
  }),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'linear', scopes: ['write'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const issueInput: Record<string, unknown> = { teamId: input.teamId, title: input.title };
    if (input.description !== undefined) issueInput.description = input.description;
    if (input.assigneeId !== undefined) issueInput.assigneeId = input.assigneeId;
    if (input.priority !== undefined) issueInput.priority = input.priority;

    type R = {
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; title: string; url: string };
      };
    };
    const data = await linearFetch<R>(ctx, MUTATION, { input: issueInput });
    const issue = data.issueCreate.issue;
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    };
  },
});
