import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const PrOut = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean(),
  author: z.string().nullable(),
  headRef: z.string(),
  baseRef: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
});

const Output = z.object({
  pullRequests: z.array(PrOut),
});

const MAX_PAGES = 5; // 100 PRs/page → up to 500 PRs.

export const listPullRequests = registerTool({
  id: 'github.list_pull_requests',
  description:
    'List pull requests for a GitHub repository, filtered by state (open, closed, or all). Returns title, state, author, head/base branches and merge timestamps. Up to 500 PRs.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    state: z.enum(['open', 'closed', 'all']).default('open'),
    sort: z.enum(['created', 'updated', 'popularity', 'long-running']).default('created'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type Pr = {
      number: number;
      title: string;
      state: string;
      draft?: boolean;
      user: { login: string } | null;
      head: { ref: string };
      base: { ref: string };
      html_url: string;
      created_at: string;
      updated_at: string;
      closed_at: string | null;
      merged_at: string | null;
    };

    const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`;
    const pullRequests: z.infer<typeof PrOut>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await githubFetch<Pr[]>(
        ctx,
        `${base}?state=${input.state}&sort=${input.sort}&direction=${input.direction}&per_page=100&page=${page}`,
      );
      for (const p of data) {
        pullRequests.push({
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft ?? false,
          author: p.user?.login ?? null,
          headRef: p.head.ref,
          baseRef: p.base.ref,
          url: p.html_url,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
          closedAt: p.closed_at,
          mergedAt: p.merged_at,
        });
      }
      if (data.length < 100) break;
      if (page === MAX_PAGES && data.length === 100) {
        ctx.logger.info(
          {
            owner: input.owner,
            repo: input.repo,
            state: input.state,
            fetched: pullRequests.length,
          },
          'github.list_pull_requests truncated at page cap',
        );
      }
    }

    return { pullRequests };
  },
});
