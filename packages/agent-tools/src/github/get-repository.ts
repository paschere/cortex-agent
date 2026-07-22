import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const Output = z.object({
  id: z.number(),
  name: z.string(),
  fullName: z.string(),
  owner: z.string(),
  description: z.string().nullable(),
  visibility: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  topics: z.array(z.string()),
  languages: z.record(z.string(), z.number()),
  homepage: z.string().nullable(),
  url: z.string(),
  stars: z.number(),
  forks: z.number(),
  openIssues: z.number(),
  pushedAt: z.string().nullable(),
});

export const getRepository = registerTool({
  id: 'github.get_repository',
  description:
    'Get metadata for a single GitHub repository: description, default branch, topics, visibility, language breakdown (bytes per language), stars and open-issue count.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
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
      description: string | null;
      visibility?: string;
      private: boolean;
      default_branch: string;
      topics?: string[];
      homepage: string | null;
      html_url: string;
      stargazers_count: number;
      forks_count: number;
      open_issues_count: number;
      pushed_at: string | null;
    };
    const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const repo = await githubFetch<Repo>(ctx, base);
    const languages = await githubFetch<Record<string, number>>(ctx, `${base}/languages`);

    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      description: repo.description,
      visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
      private: repo.private,
      defaultBranch: repo.default_branch,
      topics: repo.topics ?? [],
      languages,
      homepage: repo.homepage,
      url: repo.html_url,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      pushedAt: repo.pushed_at,
    };
  },
});
