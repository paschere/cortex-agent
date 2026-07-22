import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const CommentOut = z.object({
  id: z.number(),
  author: z.string().nullable(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const Output = z.object({
  comments: z.array(CommentOut),
});

const MAX_PAGES = 5; // 100 comments/page → up to 500 comments.

export const listIssueComments = registerTool({
  id: 'github.list_issue_comments',
  description:
    'List comments on a GitHub issue or pull request (the conversation thread). Returns author, body, and timestamps per comment. Returns up to 500 comments.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type Comment = {
      id: number;
      user: { login: string } | null;
      body: string;
      html_url: string;
      created_at: string;
      updated_at: string;
    };

    const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}/comments`;
    const comments: z.infer<typeof CommentOut>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await githubFetch<Comment[]>(ctx, `${base}?per_page=100&page=${page}`);
      for (const c of data) {
        comments.push({
          id: c.id,
          author: c.user?.login ?? null,
          body: c.body,
          url: c.html_url,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
        });
      }
      if (data.length < 100) break;
      if (page === MAX_PAGES && data.length === 100) {
        ctx.logger.info(
          { owner: input.owner, repo: input.repo, number: input.number, fetched: comments.length },
          'github.list_issue_comments truncated at page cap',
        );
      }
    }

    return { comments };
  },
});
