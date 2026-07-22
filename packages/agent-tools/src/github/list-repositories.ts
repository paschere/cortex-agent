import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const RepoOut = z.object({
  id: z.number(),
  name: z.string(),
  fullName: z.string(),
  owner: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  url: z.string(),
  updatedAt: z.string().nullable(),
});

const Output = z.object({
  repositories: z.array(RepoOut),
});

const MAX_PAGES = 5; // 100 repos/page → up to 500 repos listed.

export const listRepositories = registerTool({
  id: 'github.list_repositories',
  description:
    'List GitHub repositories accessible to the user. Optionally restrict to a single org. Returns up to 500 repos (name, owner, visibility, description, default branch).',
  inputSchema: z.object({
    org: z.string().optional(),
    sort: z.enum(['created', 'updated', 'pushed', 'full_name']).default('updated'),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type Repo = {
      id: number;
      name: string;
      full_name: string;
      owner: { login: string };
      private: boolean;
      description: string | null;
      default_branch: string;
      html_url: string;
      updated_at: string | null;
    };

    const repositories: z.infer<typeof RepoOut>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = input.org
        ? `/orgs/${encodeURIComponent(input.org)}/repos?per_page=100&page=${page}&sort=${input.sort}`
        : `/user/repos?per_page=100&page=${page}&sort=${input.sort}&affiliation=owner,collaborator,organization_member`;
      const data = await githubFetch<Repo[]>(ctx, path);
      for (const r of data) {
        repositories.push({
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          owner: r.owner.login,
          private: r.private,
          description: r.description,
          defaultBranch: r.default_branch,
          url: r.html_url,
          updatedAt: r.updated_at,
        });
      }
      if (data.length < 100) break;
      if (page === MAX_PAGES && data.length === 100) {
        ctx.logger.info({ org: input.org, fetched: repositories.length }, 'github.list_repositories truncated at page cap');
      }
    }

    return { repositories };
  },
});
