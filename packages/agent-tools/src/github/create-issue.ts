import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const Output = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
});

export const createIssue = registerTool({
  id: 'github.create_issue',
  description:
    'Create a new issue in a GitHub repository. Provide a title, optional Markdown body, and optional labels. Confirm with the user before creating.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    title: z.string().min(1),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const payload: Record<string, unknown> = { title: input.title };
    if (input.body !== undefined) payload.body = input.body;
    if (input.labels !== undefined) payload.labels = input.labels;

    type Issue = { number: number; title: string; state: string; html_url: string };
    const issue = await githubFetch<Issue>(
      ctx,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`,
      { method: 'POST', body: JSON.stringify(payload) },
    );

    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
    };
  },
});
