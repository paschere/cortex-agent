import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const Output = z.object({
  id: z.number(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
});

export const createIssueComment = registerTool({
  id: 'github.create_issue_comment',
  description:
    'Post a comment on a GitHub issue or pull request. Provide the issue/PR number and a Markdown body. Confirm with the user before posting.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    body: z.string().min(1),
  }),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    type Comment = { id: number; body: string; html_url: string; created_at: string };
    const comment = await githubFetch<Comment>(
      ctx,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}/comments`,
      { method: 'POST', body: JSON.stringify({ body: input.body }) },
    );

    return {
      id: comment.id,
      body: comment.body,
      url: comment.html_url,
      createdAt: comment.created_at,
    };
  },
});
