import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const Output = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  isPullRequest: z.boolean(),
  labels: z.array(z.string()),
  author: z.string().nullable(),
  assignees: z.array(z.string()),
  comments: z.number(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});

export const getIssue = registerTool({
  id: 'github.get_issue',
  description:
    'Get a single GitHub issue or pull request by number: title, body, state, labels, author, assignees and comment count. Works for both issues and PRs.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type Issue = {
      number: number;
      title: string;
      body: string | null;
      state: string;
      pull_request?: unknown;
      labels: Array<{ name: string } | string>;
      user: { login: string } | null;
      assignees?: Array<{ login: string }>;
      comments: number;
      html_url: string;
      created_at: string;
      updated_at: string;
      closed_at: string | null;
    };
    const issue = await githubFetch<Issue>(
      ctx,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}`,
    );

    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      isPullRequest: issue.pull_request != null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      author: issue.user?.login ?? null,
      assignees: (issue.assignees ?? []).map((a) => a.login),
      comments: issue.comments,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
    };
  },
});
